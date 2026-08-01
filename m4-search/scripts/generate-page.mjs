#!/usr/bin/env node
/**
 * Generate the M4 Competition Watch page from m4-search/data/listings.json.
 *
 * Output (m4-search/site/index.html) is fully self-contained: listing photos are
 * embedded as base64 data URIs because the page is published as a Claude
 * artifact, whose CSP blocks all external requests (including images).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const OUT = join(ROOT, 'site', 'index.html');

const data = JSON.parse(readFileSync(join(DATA, 'listings.json'), 'utf8'));
const { criteria } = data;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gbp = (n) => (n == null ? '—' : '£' + Number(n).toLocaleString('en-GB'));
const miles = (n) => (n == null ? 'mileage n/a' : Number(n).toLocaleString('en-GB') + ' mi');

function img64(l) {
  if (!l.image) return null;
  const p = join(DATA, l.image);
  if (!existsSync(p)) return null;
  return `data:image/jpeg;base64,${readFileSync(p).toString('base64')}`;
}

const live = Object.values(data.listings || {}).filter(
  (l) => !l.stale && (l.year == null || (l.year >= criteria.yearMin && l.year <= criteria.yearMax)),
);
live.sort((a, b) => (b.score ?? -999) - (a.score ?? -999));
const inBudget = live.filter((l) => l.price <= criteria.priceMax);
const watch = live.filter((l) => l.price > criteria.priceMax);

const today = data.updatedAt.slice(0, 10);
const newToday = live.filter((l) => l.firstSeen === today);
const drops = live.filter((l) => {
  const h = l.priceHistory || [];
  return h.length >= 2 && h[h.length - 1].price < h[h.length - 2].price;
});

const updated = new Date(data.updatedAt).toLocaleString('en-GB', {
  timeZone: 'Europe/London',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function specChips(l) {
  const text = `${l.title} ${l.description}`.toLowerCase();
  const chips = [];
  if (/full (bmw |main dealer |)service history|fbmwsh|fsh/.test(text)) chips.push(['FSH', 'good']);
  if (/one owner|1 owner/.test(text)) chips.push(['1 owner', 'good']);
  else if (/two owners|2 owners/.test(text)) chips.push(['2 owners', 'good']);
  if (/harman|hk audio/.test(text)) chips.push(['Harman Kardon', '']);
  if (/head[- ]up|hud/.test(text)) chips.push(['HUD', '']);
  if (/adaptive/.test(text)) chips.push(['Adaptive susp.', '']);
  if (/carbon (interior|trim|pack)/.test(text)) chips.push(['Carbon trim', '']);
  if (/sunroof/.test(text)) chips.push(['Sunroof', '']);
  if (/manual/.test(text) && !/manual.*dct|dct.*manual/.test(text)) chips.push(['Manual', '']);
  if (l.modFlag) chips.push(['Modified — verify', 'warn']);
  return chips;
}

function daysOn(l) {
  const d = Math.round((new Date(today) - new Date(l.firstSeen)) / 86400000);
  return d <= 0 ? 'New today' : `${d}d listed`;
}

function card(l, rank) {
  const src = img64(l);
  // Only claim a value delta when the model had real inputs to work with.
  const value = l.expectedPrice && l.year && l.mileage ? l.price - l.expectedPrice : null;
  const chips = specChips(l);
  const lastDrop = (() => {
    const h = l.priceHistory || [];
    if (h.length >= 2) {
      const d = h[h.length - 1].price - h[h.length - 2].price;
      if (d < 0) return d;
    }
    return null;
  })();
  return `
  <article class="card${rank === 0 ? ' top' : ''}">
    <div class="photo">
      ${src ? `<img src="${src}" alt="${esc(l.title)}">` : `<div class="no-photo"><span>M4</span>photo on listing</div>`}
      ${rank === 0 ? '<span class="flag">Top pick</span>' : ''}
      ${l.firstSeen === today ? '<span class="flag new">New today</span>' : ''}
    </div>
    <div class="body">
      <div class="titlerow">
        <h3>${esc(l.title || 'BMW M4 Competition')}</h3>
        <div class="price">${gbp(l.price)}${lastDrop ? `<span class="drop">▼ ${gbp(-lastDrop).slice(1)} drop</span>` : ''}</div>
      </div>
      <div class="meta">
        <span>${l.year ?? '2016–18'}</span><span>${miles(l.mileage)}</span>
        ${l.location ? `<span>${esc(l.location)}</span>` : ''}
        <span>${daysOn(l)}</span>
      </div>
      ${chips.length ? `<div class="chips">${chips.map(([t, k]) => `<span class="chip ${k}">${esc(t)}</span>`).join('')}</div>` : ''}
      ${l.description ? `<p class="desc">${esc(l.description.slice(0, 220))}${l.description.length > 220 ? '…' : ''}</p>` : ''}
      <div class="foot">
        <span class="seller">${l.sellerType === 'specialist' ? '<span class="chip spec">Specialist</span> ' : ''}${esc(l.sellerName || l.source)}</span>
        ${value != null ? `<span class="value ${value <= 0 ? 'under' : 'over'}">${value <= 0 ? gbp(-value).slice(0) + ' under model' : gbp(value) + ' over model'}</span>` : ''}
        <a class="go" href="${esc(l.url)}" target="_blank" rel="noopener">View listing ↗</a>
      </div>
    </div>
  </article>`;
}

const html = `<title>M4 Competition Watch</title>
<style>
  :root { color-scheme: light;
    --paper:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
    --grid:#e1e0d9; --border:rgba(11,11,11,.10); --accent:#2a78d6; --wash:rgba(42,120,214,.07);
    --good:#006300; --warn:#b06000; --crit:#d03b3b; }
  @media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --paper:#0d0d0d; --surface:#1a1a19; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --border:rgba(255,255,255,.10); --accent:#3987e5; --wash:rgba(57,135,229,.10);
    --good:#0ca30c; --warn:#e0a030; --crit:#e66767; } }
  :root[data-theme="dark"] { color-scheme: dark;
    --paper:#0d0d0d; --surface:#1a1a19; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --border:rgba(255,255,255,.10); --accent:#3987e5; --wash:rgba(57,135,229,.10);
    --good:#0ca30c; --warn:#e0a030; --crit:#e66767; }
  :root[data-theme="light"] { color-scheme: light;
    --paper:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
    --grid:#e1e0d9; --border:rgba(11,11,11,.10); --accent:#2a78d6; --wash:rgba(42,120,214,.07);
    --good:#006300; --warn:#b06000; --crit:#d03b3b; }

  body { background:var(--paper); color:var(--ink);
    font-family: system-ui,-apple-system,"Segoe UI",sans-serif; line-height:1.5; }
  .wrap { max-width:1080px; margin:0 auto; padding:40px 22px 72px; display:flex; flex-direction:column; gap:28px; }

  .stripe { display:flex; height:4px; width:110px; border-radius:2px; overflow:hidden; }
  .stripe span { flex:1; } .s1{background:#4c9fdc} .s2{background:#23439b} .s3{background:#d0273a}
  header { display:flex; flex-direction:column; gap:10px; }
  .eyebrow { font-size:12px; font-weight:600; letter-spacing:.13em; text-transform:uppercase; color:var(--ink2); }
  h1 { margin:0; font-size:clamp(26px,4.5vw,38px); font-weight:800; letter-spacing:-.02em; line-height:1.1; }
  .sub { color:var(--ink2); font-size:14.5px; max-width:70ch; margin:0; }
  .stamp { display:inline-flex; align-items:center; gap:8px; font-size:13px; color:var(--ink2);
    background:var(--wash); border:1px solid var(--border); border-radius:99px; padding:5px 14px; align-self:flex-start; }
  .stamp b { color:var(--ink); font-weight:700; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--accent); }

  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
  .tile { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:13px 16px; }
  .tile .n { font-size:24px; font-weight:800; }
  .tile .l { font-size:11.5px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:var(--muted); }

  h2 { margin:6px 0 0; font-size:19px; font-weight:750; letter-spacing:-.01em; }
  .sec-note { color:var(--ink2); font-size:13.5px; margin:0; }

  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:16px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:14px; overflow:hidden;
    display:flex; flex-direction:column; }
  .card.top { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
  .photo { position:relative; aspect-ratio:16/10; background:var(--grid); }
  .photo img { width:100%; height:100%; object-fit:cover; display:block; }
  .no-photo { width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:4px; color:var(--muted); font-size:12.5px; }
  .no-photo span { font-size:34px; font-weight:800; letter-spacing:-.02em; opacity:.35; }
  .flag { position:absolute; top:10px; left:10px; background:var(--accent); color:#fff; font-size:11px;
    font-weight:700; letter-spacing:.06em; text-transform:uppercase; padding:3px 10px; border-radius:99px; }
  .flag.new { left:auto; right:10px; background:var(--ink); color:var(--paper); }
  .body { padding:14px 16px 16px; display:flex; flex-direction:column; gap:9px; flex:1; }
  .titlerow h3 { margin:0 0 2px; font-size:15px; font-weight:700; line-height:1.3; }
  .price { font-size:21px; font-weight:800; letter-spacing:-.01em; display:flex; align-items:baseline; gap:10px; }
  .drop { font-size:12px; font-weight:700; color:var(--good); }
  .meta { display:flex; flex-wrap:wrap; gap:4px 14px; font-size:12.5px; color:var(--ink2); font-variant-numeric:tabular-nums; }
  .chips { display:flex; flex-wrap:wrap; gap:5px; }
  .chip { font-size:11px; font-weight:700; padding:2px 9px; border-radius:99px; border:1px solid var(--border); color:var(--ink2); }
  .chip.good { color:var(--good); background:color-mix(in srgb,var(--good) 9%,transparent); border-color:transparent; }
  .chip.warn { color:var(--warn); background:color-mix(in srgb,var(--warn) 10%,transparent); border-color:transparent; }
  .chip.spec { color:var(--accent); background:var(--wash); border-color:transparent; }
  .desc { margin:0; font-size:12.5px; color:var(--ink2); }
  .foot { margin-top:auto; padding-top:10px; border-top:1px solid var(--grid); display:flex; align-items:center;
    gap:10px; flex-wrap:wrap; font-size:12.5px; }
  .seller { color:var(--ink2); font-weight:600; display:flex; align-items:center; gap:4px; }
  .value.under { color:var(--good); font-weight:700; } .value.over { color:var(--muted); }
  .go { margin-left:auto; color:var(--accent); font-weight:700; text-decoration:none; }
  .go:hover { text-decoration:underline; }
  .go:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:3px; }

  .empty { background:var(--surface); border:1px dashed var(--baseline,var(--grid)); border-radius:14px;
    padding:36px; text-align:center; color:var(--ink2); font-size:14px; }
  footer { font-size:12px; color:var(--muted); border-top:1px solid var(--grid); padding-top:16px; max-width:80ch; }
</style>
<div class="wrap">
  <header>
    <div class="stripe" aria-hidden="true"><span class="s1"></span><span class="s2"></span><span class="s3"></span></div>
    <div class="eyebrow">Maverick Studios · car search</div>
    <h1>M4 Competition Watch</h1>
    <p class="sub">BMW M4 Competition (F82) · 2016–2018 · up to ${gbp(criteria.priceMax)} · UK-wide, marketplaces + specialist dealers. Exceptional cars only: stock, history, honest owners — write-offs and modified cars are filtered out automatically.</p>
    <div class="stamp"><span class="dot"></span>Data refreshed <b>${esc(updated)}</b> · scans run daily at 4pm UK</div>
  </header>

  <div class="tiles">
    <div class="tile"><div class="n">${inBudget.length}</div><div class="l">In budget</div></div>
    <div class="tile"><div class="n">${watch.length}</div><div class="l">Worth watching</div></div>
    <div class="tile"><div class="n">${newToday.length}</div><div class="l">New today</div></div>
    <div class="tile"><div class="n">${drops.length}</div><div class="l">Price drops</div></div>
  </div>

  <section>
    <h2>In budget — ≤ ${gbp(criteria.priceMax)}</h2>
    ${
      inBudget.length
        ? `<div class="grid">${inBudget.map((l, i) => card(l, i)).join('')}</div>`
        : `<div class="empty">Nothing inside ${gbp(criteria.priceMax)} today. Competition cars at this money are rare and sell fast — the watch list below is where the next one usually comes from.</div>`
    }
  </section>

  ${
    watch.length
      ? `<section>
    <h2>Worth watching — just over budget</h2>
    <p class="sec-note">Asking ${gbp(criteria.priceMax)}–${gbp(criteria.watchPriceMax)}: negotiable into range, especially past 30 days listed or after a price drop.</p>
    <div class="grid">${watch.map((l) => card(l, -1)).join('')}</div>
  </section>`
      : ''
  }

  <footer>
    Values compared against a simple market model (2017 Competition, 40k miles ≈ £34k, adjusted for year and mileage) — a negative delta means priced under the model. Always verify with an HPI check, full MOT history and an independent inspection before buying. Photos © their listing sources; follow the listing link for the full gallery.
  </footer>
</div>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(
  `Generated ${OUT}: ${inBudget.length} in budget, ${watch.length} watching, ` +
    `${live.filter((l) => l.image).length}/${live.length} with photos`,
);
