#!/usr/bin/env node
/**
 * Daily scan for BMW M4 Competition (2016-2018, <= £32k) across UK marketplaces.
 *
 * Runs on a GitHub Actions runner (unrestricted egress). The Claude session that
 * orchestrates the daily refresh cannot reach these sites directly, so all
 * network fetching lives here. Results are merged into m4-search/data/listings.json
 * with price history, and listing photos are mirrored to m4-search/data/images/.
 *
 * Design constraints:
 *  - No npm dependencies (global fetch, node:crypto, node:fs only).
 *  - Every source is best-effort: a blocked or redesigned site logs and skips,
 *    it never fails the run.
 *  - Extraction is generic-first (JSON-LD, __NEXT_DATA__ deep-walk, og: tags)
 *    so minor site redesigns degrade gracefully.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const IMAGES = join(DATA, 'images');
const LISTINGS_PATH = join(DATA, 'listings.json');

const CRITERIA = {
  yearMin: 2016,
  yearMax: 2018,
  priceMax: 32000,
  watchPriceMax: 34500, // near-misses worth negotiating down
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function get(url, { asText = true, timeout = 30000, referer } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': asText
        ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        : 'image/avif,image/webp,image/*,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
      ...(referer ? { Referer: referer } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return asText ? res.text() : Buffer.from(await res.arrayBuffer());
}

/* ---------------- generic extraction helpers ---------------- */

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1].trim()));
    } catch {
      /* malformed block — skip */
    }
  }
  return out;
}

function nextData(html) {
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Any embedded JSON state: __NEXT_DATA__, window.__NUXT__, application/json blocks. */
function embeddedState(html) {
  const blobs = [];
  const nd = nextData(html);
  if (nd) blobs.push(nd);
  const nuxt = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (nuxt) {
    try {
      blobs.push(JSON.parse(nuxt[1]));
    } catch {
      /* often a function expression — skip */
    }
  }
  const re = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      blobs.push(JSON.parse(m[1].trim()));
    } catch {
      /* skip */
    }
  }
  return blobs;
}

function diagnose(name, html) {
  const types = [...html.matchAll(/"@type"\s*:\s*"(\w+)"/g)].map((m) => m[1]);
  log(
    `${name} diag: ${html.length}b, nextData=${!!nextData(html)}, nuxt=${/__NUXT__/.test(html)}, ` +
      `jsonScripts=${(html.match(/type=["']application\/json["']/g) || []).length}, ldTypes=[${[...new Set(types)].slice(0, 6)}]`,
  );
}

/** Deep-walk any JSON blob and collect objects that look like car listings. */
function harvestListingObjects(node, out = [], depth = 0) {
  if (!node || depth > 14) return out;
  if (Array.isArray(node)) {
    for (const v of node) harvestListingObjects(v, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;
  const keys = Object.keys(node).map((k) => k.toLowerCase());
  const hasPrice = keys.some((k) => /(^|_)price|pricegbp|totalprice/.test(k));
  const hasTitle = keys.some((k) => /title|name|derivative|headline|model/.test(k));
  const hasLink = keys.some((k) => /url|link|slug|path|advertid|adid|id$/.test(k));
  if (hasPrice && hasTitle && hasLink) out.push(node);
  for (const v of Object.values(node)) harvestListingObjects(v, out, depth + 1);
  return out;
}

const firstString = (obj, patterns) => {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && patterns.some((p) => p.test(k.toLowerCase()))) return v;
    if (typeof v === 'number' && patterns.some((p) => p.test(k.toLowerCase()))) return String(v);
  }
  return null;
};

function parseMoney(s) {
  if (s == null) return null;
  const m = String(s).replace(/[,£\s]/g, '').match(/\d{4,6}/);
  return m ? Number(m[0]) : null;
}

function parseMiles(s) {
  if (s == null) return null;
  const m = String(s)
    .toLowerCase()
    .replace(/,/g, '')
    .match(/(\d{1,3}(?:\d{3})*|\d+)\s*(?:miles|mi\b)/);
  return m ? Number(m[1]) : null;
}

function parseYear(s) {
  if (s == null) return null;
  const m = String(s).match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

const idFor = (url) => createHash('sha1').update(url).digest('hex').slice(0, 12);

/* ---------------- normalization + filtering ---------------- */

function normalise(raw, source) {
  const url = raw.url;
  if (!url) return null;
  const title = (raw.title || '').replace(/\s+/g, ' ').trim();
  const text = `${title} ${raw.description || ''}`.toLowerCase();

  const price = raw.price ?? parseMoney(raw.priceText);
  const year = raw.year ?? parseYear(title) ?? parseYear(raw.description);
  const mileage = raw.mileage ?? parseMiles(raw.mileageText) ?? parseMiles(raw.description);

  if (!price || price < 15000) return null; // parts/replicas/noise
  if (!/m4/.test(text)) return null;
  if (/convertible|cabriolet/.test(text)) return null; // coupé focus
  const isCompetition = /competition|comp pack|450\s?(bhp|hp|ps)/.test(text);

  const redFlag =
    /\b(cat\s?[sncd]\b|category\s?[sncd]\b|salvage|damaged|spares or repair|non[- ]runner)\b/.test(
      text,
    );
  const modFlag = /\b(remap|stage\s?[123]|tuned|decat|downpipe|hybrid turbo)\b/.test(text);

  return {
    id: idFor(url),
    url,
    source,
    title: title.slice(0, 140),
    price,
    year,
    mileage,
    isCompetition,
    redFlag,
    modFlag,
    sellerType: raw.sellerType || null,
    sellerName: raw.sellerName || null,
    location: raw.location || null,
    imageUrl: raw.imageUrl || null,
    description: (raw.description || '').slice(0, 600),
  };
}

function withinCriteria(l) {
  if (!l.isCompetition || l.redFlag) return false;
  if (l.year && (l.year < CRITERIA.yearMin || l.year > CRITERIA.yearMax)) return false;
  return l.price <= CRITERIA.watchPriceMax;
}

/* ---------------- sources ---------------- */

async function srcEbay() {
  const url =
    'https://www.ebay.co.uk/sch/i.html?_nkw=bmw+m4+competition&_sacat=9801&_udhi=34500&_udlo=20000&LH_ItemCondition=3000';
  const html = await get(url);
  const items = [];
  // eBay search results: each card contains a link, title, price and image.
  const cardRe =
    /<a[^>]+href="(https:\/\/www\.ebay\.co\.uk\/itm\/[^"]+)"[\s\S]{0,2200}?<\/li>/gi;
  const seen = new Set();
  let m;
  while ((m = cardRe.exec(html))) {
    const block = m[0];
    const link = m[1].split('?')[0];
    if (seen.has(link)) continue;
    seen.add(link);
    const title = (block.match(/<span[^>]*role="heading"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '')
      .replace(/<[^>]+>/g, ' ')
      .trim();
    const priceText = block.match(/£[\d,]+(?:\.\d\d)?/)?.[0];
    const imageUrl = block.match(/src="(https:\/\/i\.ebayimg\.com\/[^"]+)"/i)?.[1] || null;
    if (!title || !priceText) continue;
    items.push({ url: link, title, priceText, imageUrl, description: title });
  }
  return items.map((r) => normalise(r, 'eBay'));
}

async function srcPistonheads() {
  const objs = [];
  let html = '';
  for (const path of [
    '/buy/bmw/f82-m4?price-to=34500',
    '/buy/bmw/f82-m4?price-to=34500&page=2',
    '/buy/bmw/f82-m4?price-to=34500&page=3',
    '/buy/cars/bmw-m4?price-to=34500',
  ]) {
    try {
      html = await get(`https://www.pistonheads.com${path}`);
      const nd = nextData(html);
      if (nd) objs.push(...harvestListingObjects(nd));
    } catch (e) {
      log(`PistonHeads page ${path} failed — ${e.message}`);
    }
  }
  const items = [];
  for (const o of objs) {
    const link = firstString(o, [/url|link|slug|path/]);
    if (!link || !/\/buy\/|\/classifieds\/|\/used-cars\//i.test(link)) continue;
    items.push({
      url: link.startsWith('http') ? link : `https://www.pistonheads.com${link}`,
      title: firstString(o, [/title|name|headline|derivative/]) || '',
      priceText: firstString(o, [/price/]),
      mileageText: firstString(o, [/mileage|odometer/]),
      imageUrl: firstString(o, [/image|img|photo|thumb/]),
      sellerName: firstString(o, [/dealer|seller|trader/]),
      location: firstString(o, [/location|town|county|postcode/]),
      description: firstString(o, [/description|summary|subtitle/]) || '',
    });
  }
  // Fallback: JSON-LD ItemList if __NEXT_DATA__ moved.
  if (!items.length) {
    for (const b of jsonLdBlocks(html).flat()) {
      const list = b?.itemListElement || [];
      for (const it of list) {
        const item = it?.item || it;
        if (item?.url)
          items.push({
            url: item.url,
            title: item.name || '',
            priceText: item?.offers?.price,
            imageUrl: Array.isArray(item.image) ? item.image[0] : item.image,
            description: item.description || '',
          });
      }
    }
  }
  return items.map((r) => normalise(r, 'PistonHeads'));
}

async function srcAutotrader() {
  const url =
    'https://www.autotrader.co.uk/car-search?make=BMW&model=M4&price-to=34500&year-from=2016&year-to=2018&postcode=SW1A1AA';
  const html = await get(url);
  const items = [];
  for (const b of jsonLdBlocks(html).flat()) {
    const list = b?.itemListElement || (b?.['@type'] === 'ItemList' ? b.item : null) || [];
    for (const it of list) {
      const item = it?.item || it;
      if (item?.url)
        items.push({
          url: item.url.startsWith('http') ? item.url : `https://www.autotrader.co.uk${item.url}`,
          title: item.name || '',
          priceText: item?.offers?.price,
          imageUrl: Array.isArray(item.image) ? item.image[0] : item.image,
          description: item.description || '',
        });
    }
  }
  if (!items.length) {
    const objs = harvestListingObjects(
      nextData(html) ??
        JSON.parse(html.match(/window\.AT_DATA\s*=\s*({[\s\S]*?});\s*<\/script>/)?.[1] ?? 'null'),
    );
    for (const o of objs) {
      const link = firstString(o, [/url|link|path/]);
      if (!link || !/car-details/.test(link)) continue;
      items.push({
        url: link.startsWith('http') ? link : `https://www.autotrader.co.uk${link}`,
        title: firstString(o, [/title|name|headline/]) || '',
        priceText: firstString(o, [/price/]),
        mileageText: firstString(o, [/mileage/]),
        imageUrl: firstString(o, [/image|img/]),
        location: firstString(o, [/location|town/]),
        description: firstString(o, [/subtitle|attention|description/]) || '',
      });
    }
  }
  return items.map((r) => normalise(r, 'AutoTrader'));
}

async function srcHeycar() {
  const url = 'https://heycar.com/uk/autos/make/bmw/model/m4?priceMax=34500';
  const html = await get(url);
  const objs = embeddedState(html).flatMap((b) => harvestListingObjects(b));
  if (!objs.length) diagnose('heycar', html);
  const items = [];
  for (const o of objs) {
    const link = firstString(o, [/url|link|slug|path/]);
    if (!link) continue;
    items.push({
      url: link.startsWith('http') ? link : `https://heycar.com${link}`,
      title: firstString(o, [/title|name|derivative|trim/]) || '',
      priceText: firstString(o, [/price/]),
      mileageText: firstString(o, [/mileage/]),
      imageUrl: firstString(o, [/image|img/]),
      sellerName: firstString(o, [/dealer/]),
      description: firstString(o, [/description|subtitle/]) || '',
    });
  }
  return items.map((r) => normalise(r, 'heycar'));
}

async function srcMotors() {
  const url = 'https://www.motors.co.uk/search/car/?make=BMW&model=M4&price-to=34500';
  const html = await get(url);
  const items = [];
  for (const b of jsonLdBlocks(html).flat()) {
    const list = b?.itemListElement || [];
    for (const it of list) {
      const item = it?.item || it;
      if (item?.url)
        items.push({
          url: item.url,
          title: item.name || '',
          priceText: item?.offers?.price,
          imageUrl: Array.isArray(item.image) ? item.image[0] : item.image,
          description: item.description || '',
        });
    }
  }
  if (!items.length) {
    for (const b of embeddedState(html)) {
      for (const o of harvestListingObjects(b)) {
        const link = firstString(o, [/url|link|path|slug/]);
        if (!link) continue;
        items.push({
          url: link.startsWith('http') ? link : `https://www.motors.co.uk${link}`,
          title: firstString(o, [/title|name|headline|derivative/]) || '',
          priceText: firstString(o, [/price/]),
          mileageText: firstString(o, [/mileage/]),
          imageUrl: firstString(o, [/image|img|photo/]),
          location: firstString(o, [/location|town/]),
          description: firstString(o, [/description|subtitle/]) || '',
        });
      }
    }
  }
  if (!items.length) diagnose('Motors.co.uk', html);
  return items.map((r) => normalise(r, 'Motors.co.uk'));
}

/**
 * Specialist dealers and extra sources supplied by the daily curation pass
 * (data/curated-sources.json). Each entry: { name, searchUrl } — fetched and
 * mined with the generic extractors, or { listing } objects added verbatim.
 */
async function srcCurated() {
  const path = join(DATA, 'curated-sources.json');
  if (!existsSync(path)) return [];
  const curated = JSON.parse(readFileSync(path, 'utf8'));
  const items = [];
  for (const entry of curated.sources || []) {
    try {
      const html = await get(entry.searchUrl);
      const found = [];
      for (const b of jsonLdBlocks(html).flat()) {
        const list = b?.itemListElement || (Array.isArray(b) ? b : [b]);
        for (const it of list) {
          const item = it?.item || it;
          if (item?.url && (item.name || item.description))
            found.push({
              url: item.url,
              title: item.name || '',
              priceText: item?.offers?.price,
              imageUrl: Array.isArray(item.image) ? item.image[0] : item.image,
              description: item.description || '',
              sellerName: entry.name,
              sellerType: entry.sellerType ?? null,
            });
        }
      }
      for (const b of embeddedState(html))
        for (const o of harvestListingObjects(b)) {
          const link = firstString(o, [/url|link|slug|path/]);
          if (!link) continue;
          found.push({
            url: link.startsWith('http') ? link : new URL(link, entry.searchUrl).href,
            title: firstString(o, [/title|name|headline|derivative/]) || '',
            priceText: firstString(o, [/price/]),
            mileageText: firstString(o, [/mileage/]),
            imageUrl: firstString(o, [/image|img|photo/]),
            sellerName: entry.name,
            sellerType: entry.sellerType ?? null,
            description: firstString(o, [/description|subtitle/]) || '',
          });
        }
      if (!found.length) diagnose(`curated:${entry.name}`, html);
      log(`curated:${entry.name}`, found.length, 'raw items');
      items.push(...found.map((r) => normalise(r, entry.name)));
    } catch (e) {
      log(`curated:${entry.name} FAILED — ${e.message}`);
    }
  }
  for (const l of curated.listings || []) {
    items.push(normalise({ ...l, sellerType: l.sellerType || 'specialist' }, l.source || 'curated'));
  }
  return items;
}

/* ---------------- detail enrichment + images ---------------- */

async function enrich(listing) {
  try {
    const html = await get(listing.url, { referer: 'https://www.google.co.uk/' });
    const og = (p) =>
      html.match(new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']+)`, 'i'))?.[1] ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${p}["']`, 'i'))?.[1];
    listing.imageUrl = og('image') || listing.imageUrl;
    const ogTitle = og('title');
    if (ogTitle && (!listing.title || /^advert$|^listing$|^bmw$/i.test(listing.title.trim())))
      listing.title = ogTitle.replace(/\s*[|–-]\s*(PistonHeads|AutoTrader|eBay|AA Cars).*$/i, '').slice(0, 140);
    const desc = og('description');
    if (desc && desc.length > (listing.description?.length || 0)) listing.description = desc.slice(0, 600);
    // Structured data on the detail page is the most reliable enrichment.
    for (const b of jsonLdBlocks(html).flat()) {
      const v = b?.['@type'] === 'Vehicle' || b?.['@type'] === 'Car' ? b : b?.mainEntity;
      if (!v || (v['@type'] !== 'Vehicle' && v['@type'] !== 'Car')) continue;
      listing.year = listing.year ?? parseYear(v.vehicleModelDate || v.productionDate || v.modelDate);
      const odo = v.mileageFromOdometer;
      listing.mileage = listing.mileage ?? (odo && Number(odo.value ?? odo)) ?? null;
      listing.sellerName = listing.sellerName || v?.offers?.seller?.name || null;
      if (!listing.title || listing.title.length < 12) listing.title = v.name || listing.title;
    }
    listing.mileage = listing.mileage ?? parseMiles(html);
    listing.year =
      listing.year ??
      parseYear(listing.title) ??
      parseYear(html.match(/\b20\d{2}\s*\(\s*\d{2}\s*(?:reg|plate)\s*\)/i)?.[0]);
  } catch (e) {
    log(`enrich failed for ${listing.url} — ${e.message}`);
  }
  return listing;
}

async function mirrorImage(listing) {
  if (!listing.imageUrl) return;
  const dest = join(IMAGES, `${listing.id}.jpg`);
  if (existsSync(dest)) {
    listing.image = `images/${listing.id}.jpg`;
    return;
  }
  try {
    const buf = await get(listing.imageUrl, { asText: false, referer: listing.url });
    if (buf.length < 4000) throw new Error('image too small, likely a pixel');
    writeFileSync(dest, buf);
    // Shrink for embedding (ImageMagick is preinstalled on ubuntu runners).
    try {
      execFileSync('convert', [dest, '-resize', '900x>', '-quality', '78', dest]);
    } catch {
      /* keep original if convert is unavailable */
    }
    listing.image = `images/${listing.id}.jpg`;
  } catch (e) {
    log(`image failed for ${listing.id} (${listing.source}) — ${e.message}`);
  }
}

/* ---------------- scoring ---------------- */

function score(l) {
  // Benchmark: £34k for a 40k-mile 2017 Competition; mileage at ~9p/mile.
  const expected = 34000 + (l.year ? (l.year - 2017) * 1200 : 0) - ((l.mileage ?? 55000) - 40000) * 0.09;
  const value = expected - l.price;
  let s = value / 100;
  const text = `${l.title} ${l.description}`.toLowerCase();
  if (/full (bmw |main dealer |)service history|fbmwsh|fsh/.test(text)) s += 18;
  if (/one owner|1 owner|two owners|2 owners/.test(text)) s += 10;
  if (/harman|hk audio/.test(text)) s += 4;
  if (/head[- ]up|hud/.test(text)) s += 3;
  if (/adaptive/.test(text)) s += 3;
  if (/carbon (interior|trim|pack)/.test(text)) s += 2;
  if (l.sellerType === 'specialist') s += 8;
  if (l.modFlag) s -= 30;
  if ((l.mileage ?? 60000) < 45000) s += 6;
  if (l.mileage == null) s -= 25; // unverified mileage: don't let a cheap ad outrank known-good cars
  if (l.year == null) s -= 10;
  l.expectedPrice = Math.round(expected);
  l.score = Math.round(s);
  return l;
}

/* ---------------- main ---------------- */

async function main() {
  mkdirSync(IMAGES, { recursive: true });
  const previous = existsSync(LISTINGS_PATH)
    ? JSON.parse(readFileSync(LISTINGS_PATH, 'utf8'))
    : { listings: {} };

  const sources = [
    ['AutoTrader', srcAutotrader],
    ['PistonHeads', srcPistonheads],
    ['eBay', srcEbay],
    ['heycar', srcHeycar],
    ['Motors.co.uk', srcMotors],
    ['curated', srcCurated],
  ];

  const found = [];
  for (const [name, fn] of sources) {
    try {
      const items = (await fn()).filter(Boolean);
      const kept = items.filter(withinCriteria);
      log(`${name}: ${items.length} parsed, ${kept.length} within criteria`);
      found.push(...kept);
    } catch (e) {
      log(`${name} FAILED — ${e.message}`);
    }
  }

  // Dedupe by id (URL hash); prefer entries that already have images.
  const byId = new Map();
  for (const l of found) if (!byId.has(l.id)) byId.set(l.id, l);

  const today = new Date().toISOString().slice(0, 10);
  const merged = previous.listings || {};

  for (const [id, l] of byId) {
    const prev = merged[id];
    await enrich(l);
    await mirrorImage(l);
    score(l);
    merged[id] = {
      ...prev,
      ...l,
      firstSeen: prev?.firstSeen || today,
      lastSeen: today,
      priceHistory: [
        ...(prev?.priceHistory || []).filter((p) => p.date !== today),
        { date: today, price: l.price },
      ],
    };
  }
  // Mark stale entries (not seen today) but keep 14 days of history.
  for (const [id, l] of Object.entries(merged)) {
    if (l.lastSeen !== today) {
      const age = (new Date(today) - new Date(l.lastSeen)) / 86400000;
      if (age > 14) delete merged[id];
      else merged[id].stale = true;
    } else {
      delete merged[id].stale;
    }
  }

  const out = {
    criteria: CRITERIA,
    updatedAt: new Date().toISOString(),
    listings: merged,
  };
  writeFileSync(LISTINGS_PATH, JSON.stringify(out, null, 2));
  const live = Object.values(merged).filter((l) => !l.stale);
  log(
    `DONE: ${live.length} live listings (${live.filter((l) => l.price <= CRITERIA.priceMax).length} in budget, ` +
      `${live.filter((l) => l.image).length} with images)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
