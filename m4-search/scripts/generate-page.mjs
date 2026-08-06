#!/usr/bin/env node
/**
 * Generate the M4 Competition Watch page from m4-search/data/listings.json.
 *
 * Output (m4-search/site/index.html) is fully self-contained: listing photos and
 * the display typeface are embedded as base64 data URIs because the page is
 * published as a Claude artifact, whose CSP blocks all external requests.
 *
 * Design: "race-entry ledger" — a numbered, hairline-ruled datasheet. No cards,
 * no shadows; hierarchy is carried by type scale (Archivo Black) and rules.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const OUT = join(ROOT, 'site', 'index.html');
const FONT = join(ROOT, 'assets', 'archivo-black-latin-400-normal.woff2');

const data = JSON.parse(readFileSync(join(DATA, 'listings.json'), 'utf8'));
const { criteria } = data;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gbp = (n) => (n == null ? '—' : '£' + Number(n).toLocaleString('en-GB'));
const kmi = (n) => (n == null ? 'MILES TBC' : Number(n).toLocaleString('en-GB') + ' MI');

const fontData = existsSync(FONT)
  ? `@font-face{font-family:'Archivo Black';font-style:normal;font-weight:400;font-display:swap;src:url(data:font/woff2;base64,${readFileSync(FONT).toString('base64')}) format('woff2');}`
  : '';

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
const comp = live.filter((l) => !['manual', 'm2', 'rs5'].includes(l.category));
const manuals = live.filter((l) => l.category === 'manual');
const m2s = live.filter((l) => l.category === 'm2');
const rs5s = live.filter((l) => l.category === 'rs5');
const inBudget = comp.filter((l) => l.price <= criteria.priceMax);
const watch = comp.filter((l) => l.price > criteria.priceMax);
const inBudgetAll = live.filter((l) => l.price <= criteria.priceMax);

const today = data.updatedAt.slice(0, 10);
const newToday = live.filter((l) => l.firstSeen === today);
const drops = live.filter((l) => {
  const h = l.priceHistory || [];
  return h.length >= 2 && h[h.length - 1].price < h[h.length - 2].price;
});

// First new-today car in display order (in-budget by score, then watch, then manual lanes).
const firstNewId =
  [...inBudget, ...watch, ...manuals, ...m2s, ...rs5s].find((l) => l.firstSeen === today)?.id ?? null;

const updated = new Date(data.updatedAt)
  .toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  .toUpperCase();

function specBits(l) {
  const text = `${l.title} ${l.description}`.toLowerCase();
  const bits = [];
  if (/full (bmw |main dealer |)service history|fbmwsh|fsh/.test(text)) bits.push('FSH');
  if (/one owner|1 owner/.test(text)) bits.push('1 OWNER');
  else if (/two owners|2 owners/.test(text)) bits.push('2 OWNERS');
  if (/harman|hk audio/.test(text)) bits.push('HARMAN KARDON');
  if (/head[- ]up|hud/.test(text)) bits.push('HUD');
  if (/adaptive/.test(text)) bits.push('ADAPTIVE SUSP');
  if (/carbon (interior|trim|pack)/.test(text)) bits.push('CARBON TRIM');
  if (/crank hub done|crank hub fix/.test(text)) bits.push('CRANK HUB DONE');
  if (/sports? exhaust/.test(text)) bits.push('SPORTS EXHAUST');
  if (/sonoma/.test(text)) bits.push('SONOMA GREEN');
  else if (/nardo/.test(text)) bits.push('NARDO GREY');
  if (/b&o|bang & olufsen|bang and olufsen/.test(text)) bits.push('B&O AUDIO');
  if (/sunroof/.test(text)) bits.push('SUNROOF');
  return bits;
}

function daysOn(l) {
  const d = Math.round((new Date(today) - new Date(l.firstSeen)) / 86400000);
  return d <= 0 ? 'LISTED TODAY' : `${d}D LISTED`;
}

function entry(l, idx, { top = false } = {}) {
  const src = img64(l);
  const value = l.expectedPrice && l.year && l.mileage ? l.price - l.expectedPrice : null;
  const bits = specBits(l);
  const lastDrop = (() => {
    const h = l.priceHistory || [];
    if (h.length >= 2 && h[h.length - 1].price < h[h.length - 2].price)
      return h[h.length - 2].price - h[h.length - 1].price;
    return null;
  })();
  const meta = [
    l.year ?? '2016–18',
    l.gearbox === 'manual' ? 'MANUAL' : l.category === 'rs5' && l.gearbox ? 'AUTO' : l.gearbox || null,
    kmi(l.mileage),
    l.sellerName || l.source,
    l.location ? esc(l.location) : null,
    daysOn(l),
  ]
    .filter(Boolean)
    .join('&ensp;·&ensp;');

  return `
  <li class="entry${top ? ' is-top' : ''}" id="e-${l.id}">
    <span class="no" aria-hidden="true">${String(idx).padStart(2, '0')}</span>
    <a class="shot" href="${esc(l.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">
      ${src ? `<img src="${src}" alt="">` : `<span class="noimg">PHOTO ON LISTING</span>`}
    </a>
    <div class="info">
      ${top ? `<span class="toptag">Top pick</span>` : ''}
      ${l.modFlag ? `<span class="modtag">Modified — verify</span>` : ''}
      <h3>${esc(l.title || 'BMW M4 Competition')}</h3>
      <p class="meta">${meta}</p>
      ${bits.length ? `<p class="bits">${bits.join('&ensp;/&ensp;')}</p>` : ''}
      ${l.description ? `<p class="desc">${esc(l.description.slice(0, 190))}${l.description.length > 190 ? '…' : ''}</p>` : ''}
    </div>
    <div class="deal">
      <span class="price">${gbp(l.price)}</span>
      ${l.price > criteria.priceMax ? `<span class="delta">${gbp(l.price - criteria.priceMax)} OVER BUDGET</span>` : ''}
      ${lastDrop ? `<span class="delta drop">▼ ${gbp(lastDrop)} PRICE DROP</span>` : ''}
      ${value != null && value < 0 ? `<span class="delta under">${gbp(-value)} UNDER MODEL</span>` : ''}
      ${value != null && value >= 0 ? `<span class="delta">MODEL ${gbp(l.expectedPrice)}</span>` : ''}
      <a class="view" href="${esc(l.url)}" target="_blank" rel="noopener">View listing<span aria-hidden="true"> ↗</span></a>
    </div>
  </li>`;
}

const html = `<title>M4 Competition Watch</title>
<style>
  ${fontData}
  :root {
    color-scheme: light;
    --paper: #f4f4f2;
    --ink: #0d0d0e;
    --ink2: #55555a;
    --mute: #8e8e90;
    --line: #d8d8d4;
    --line-strong: #0d0d0e;
    --accent: #1e5bd6;
    --good: #006300;
    --wash: rgba(13, 13, 14, 0.03);
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --paper: #0e0e10;
      --ink: #f4f4f2;
      --ink2: #b4b4b6;
      --mute: #77777a;
      --line: #26262a;
      --line-strong: #f4f4f2;
      --accent: #4a8df0;
      --good: #34b234;
      --wash: rgba(244, 244, 242, 0.04);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --paper: #0e0e10; --ink: #f4f4f2; --ink2: #b4b4b6; --mute: #77777a;
    --line: #26262a; --line-strong: #f4f4f2; --accent: #4a8df0; --good: #34b234;
    --wash: rgba(244, 244, 242, 0.04);
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --paper: #f4f4f2; --ink: #0d0d0e; --ink2: #55555a; --mute: #8e8e90;
    --line: #d8d8d4; --line-strong: #0d0d0e; --accent: #1e5bd6; --good: #006300;
    --wash: rgba(13, 13, 14, 0.03);
  }

  body {
    background: var(--paper);
    color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.5;
  }
  .display { font-family: 'Archivo Black', system-ui, sans-serif; font-weight: 400; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 44px 28px 90px; }
  .micro {
    font-size: 11px; font-weight: 650; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--ink2);
  }

  /* ---------- masthead ---------- */
  .tri { display: inline-flex; height: 10px; width: 42px; margin-bottom: 18px; }
  .tri span { flex: 1; }
  .tri .a { background: #4c9fdc; } .tri .b { background: #23439b; } .tri .c { background: #d0273a; }
  .mast { border-bottom: 3px solid var(--line-strong); padding-bottom: 26px; }
  .mast .row { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap; }
  h1 {
    font-family: 'Archivo Black', system-ui, sans-serif; font-weight: 400;
    font-size: clamp(44px, 9vw, 108px);
    line-height: 0.94; letter-spacing: -0.015em; text-transform: uppercase;
    margin: 0 0 18px; text-wrap: balance;
  }
  h1 .thin { color: var(--accent); }
  .specline { display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }
  .specline .micro b { color: var(--ink); font-weight: 750; }
  .stamp { text-align: right; }
  .stamp .micro b { color: var(--ink); }
  .live { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--good); margin-right: 7px; }

  /* ---------- stat strip ---------- */
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid var(--line); }
  .stats > * { padding: 22px 4px 20px; border-left: 1px solid var(--line); padding-left: 18px; }
  .stats > *:first-child { border-left: none; padding-left: 0; }
  .stats .n { font-family: 'Archivo Black', system-ui, sans-serif; font-size: clamp(28px, 4vw, 44px); line-height: 1; }
  .stats .n.accent { color: var(--accent); }
  .stats .micro { margin-top: 6px; display: block; color: var(--mute); }
  a.stat-link { text-decoration: none; color: inherit; }
  a.stat-link .jump { color: var(--accent); }
  @media (hover: hover) { a.stat-link:hover { background: var(--wash); } a.stat-link:hover .micro { color: var(--ink); } }
  a.stat-link:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  @media (prefers-reduced-motion: no-preference) { html, body { scroll-behavior: smooth; } }
  section, .entry { scroll-margin-top: 24px; }
  .entry:target { background: var(--wash); box-shadow: inset 3px 0 0 var(--accent); }
  @media (max-width: 640px) {
    .stats { grid-template-columns: 1fr 1fr; }
    .stats > *:nth-child(3) { border-left: none; padding-left: 0; }
    .stats > *:nth-child(1), .stats > *:nth-child(2) { border-bottom: 1px solid var(--line); }
  }

  /* ---------- section heads ---------- */
  .sechead { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin: 54px 0 0; padding-bottom: 12px; border-bottom: 3px solid var(--line-strong); }
  .sechead h2 {
    font-family: 'Archivo Black', system-ui, sans-serif; font-weight: 400; margin: 0;
    font-size: clamp(19px, 2.6vw, 26px); text-transform: uppercase; letter-spacing: 0.01em;
  }
  .sechead .micro { color: var(--mute); }

  /* ---------- ledger ---------- */
  ol.ledger { list-style: none; margin: 0; padding: 0; }
  .entry {
    display: grid;
    grid-template-columns: 68px 340px 1fr 210px;
    gap: 26px;
    padding: 26px 0;
    border-bottom: 1px solid var(--line);
    align-items: start;
  }
  @media (hover: hover) { .entry { transition: background 0.15s ease; } .entry:hover { background: var(--wash); } }
  .no {
    font-family: 'Archivo Black', system-ui, sans-serif;
    font-size: 30px; line-height: 1; padding-top: 4px;
    color: transparent; -webkit-text-stroke: 1.2px var(--mute);
    font-variant-numeric: tabular-nums;
  }
  .is-top .no { color: var(--accent); -webkit-text-stroke: 0; }
  .shot { display: block; aspect-ratio: 3 / 2; overflow: hidden; background: var(--line); }
  .shot img { width: 100%; height: 100%; object-fit: cover; display: block; }
  @media (hover: hover) and (prefers-reduced-motion: no-preference) {
    .shot img { transition: transform 0.45s cubic-bezier(0.2, 0.6, 0.2, 1); }
    .entry:hover .shot img { transform: scale(1.035); }
  }
  .noimg { display: flex; align-items: center; justify-content: center; height: 100%;
    font-size: 11px; letter-spacing: 0.16em; color: var(--mute); }
  .info { min-width: 0; }
  .toptag, .modtag {
    display: inline-block; font-size: 11px; font-weight: 750; letter-spacing: 0.16em;
    text-transform: uppercase; padding: 3px 8px; margin: 0 8px 10px 0;
  }
  .toptag { background: var(--accent); color: var(--paper); }
  .modtag { border: 1px solid var(--line); color: var(--ink2); }
  .info h3 { margin: 0 0 8px; font-size: 17px; font-weight: 700; letter-spacing: -0.005em; line-height: 1.3; }
  .meta { margin: 0 0 10px; font-size: 12.5px; color: var(--ink2); font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em; }
  .bits { margin: 0 0 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; color: var(--accent); }
  .desc { margin: 0; font-size: 13px; color: var(--ink2); max-width: 52ch;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .deal { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 7px; }
  .price { font-family: 'Archivo Black', system-ui, sans-serif; font-size: clamp(24px, 3vw, 34px); line-height: 1; }
  .delta { font-size: 11px; font-weight: 750; letter-spacing: 0.12em; text-transform: uppercase; color: var(--mute); }
  .delta.under { color: var(--good); }
  .delta.drop { color: var(--good); }
  .view {
    margin-top: 6px; font-size: 12px; font-weight: 750; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--ink); text-decoration: none; border-bottom: 2px solid var(--accent); padding-bottom: 3px;
  }
  .view:hover { color: var(--accent); }
  .view:focus-visible, .shot:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

  @media (max-width: 940px) {
    .entry { grid-template-columns: 44px 260px 1fr; }
    .no { font-size: 22px; }
    .deal { grid-column: 2 / -1; flex-direction: row; align-items: baseline; gap: 16px; text-align: left; flex-wrap: wrap; }
  }
  @media (max-width: 640px) {
    .entry { grid-template-columns: 1fr; gap: 14px; padding: 22px 0; }
    .no { display: none; }
    .deal { grid-column: 1; }
  }

  .empty { padding: 44px 0; border-bottom: 1px solid var(--line); color: var(--ink2); font-size: 14px; max-width: 60ch; }

  footer { margin-top: 56px; padding-top: 18px; border-top: 3px solid var(--line-strong); }
  footer p { margin: 0 0 6px; font-size: 12px; color: var(--mute); max-width: 86ch; }

  /* ---------- blocked-navigation fallback sheet ---------- */
  .sheet-veil { position: fixed; inset: 0; background: rgba(13, 13, 14, 0.5); display: none;
    align-items: center; justify-content: center; padding: 22px; z-index: 50; }
  .sheet-veil.on { display: flex; }
  .sheet { background: var(--paper); color: var(--ink); border: 3px solid var(--line-strong);
    max-width: 520px; width: 100%; padding: 24px; }
  .sheet h4 { margin: 0 0 6px; font-family: 'Archivo Black', system-ui, sans-serif; font-weight: 400;
    font-size: 16px; text-transform: uppercase; }
  .sheet p { margin: 0 0 14px; font-size: 13px; color: var(--ink2); }
  .sheet .urlrow { display: flex; gap: 8px; }
  .sheet input { flex: 1; min-width: 0; font: 13px/1.4 ui-monospace, monospace; color: var(--ink);
    background: transparent; border: 1px solid var(--line); padding: 9px 10px; }
  .sheet button { font-size: 12px; font-weight: 750; letter-spacing: 0.1em; text-transform: uppercase;
    background: var(--ink); color: var(--paper); border: 0; padding: 9px 16px; cursor: pointer; }
  .sheet button.ghost { background: transparent; color: var(--ink2); border: 1px solid var(--line); margin-top: 10px; }
  .sheet button:focus-visible, .sheet input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>

<div class="wrap">
  <header class="mast">
    <div class="tri" aria-hidden="true"><span class="a"></span><span class="b"></span><span class="c"></span></div>
    <h1>M4 Competition<br><span class="thin">Watch</span></h1>
    <div class="row">
      <div class="specline">
        <span class="micro">UP TO <b>£35,000</b> · <b>M4 COMP</b> '16–'18 + <b>MANUAL M4</b> + <b>MANUAL M2</b> ('16–'21) + <b>RS5 B9 COUPÉ</b> ('17–'23) · UK-WIDE · STOCK CARS ONLY</span>
      </div>
      <div class="stamp">
        <span class="micro"><span class="live"></span>Data <b>${esc(updated)}</b> · SCAN DAILY 16:00 UK</span>
      </div>
    </div>
  </header>

  <div class="stats">
    <div><span class="n accent display">${inBudgetAll.length}</span><span class="micro">In budget</span></div>
    ${
      watch.length
        ? `<a class="stat-link" href="#watching"><span class="n display">${watch.length}</span><span class="micro">Worth watching<span class="jump" aria-hidden="true"> ↓</span></span></a>`
        : `<div><span class="n display">0</span><span class="micro">Worth watching</span></div>`
    }
    ${
      firstNewId
        ? `<a class="stat-link" href="#e-${firstNewId}"><span class="n display">${newToday.length}</span><span class="micro">New today<span class="jump" aria-hidden="true"> ↓</span></span></a>`
        : `<div><span class="n display">0</span><span class="micro">New today</span></div>`
    }
    <div><span class="n display">${drops.length}</span><span class="micro">Price drops</span></div>
  </div>

  <section>
    <div class="sechead">
      <h2>M4 Competition — in budget</h2>
      <span class="micro">≤ ${gbp(criteria.priceMax)} · ranked by score</span>
    </div>
    ${
      inBudget.length
        ? `<ol class="ledger">${inBudget.map((l, i) => entry(l, i + 1, { top: i === 0 })).join('')}</ol>`
        : `<div class="empty">Nothing inside ${gbp(criteria.priceMax)} today. Competition cars at this money are rare and sell fast — the watch list below is where the next one usually comes from.</div>`
    }
  </section>

  ${
    watch.length
      ? `<section id="watching">
    <div class="sechead">
      <h2>Worth watching</h2>
      <span class="micro">${gbp(criteria.priceMax)}–${gbp(criteria.watchPriceMax)} · negotiable into range</span>
    </div>
    <ol class="ledger">${watch.map((l, i) => entry(l, inBudget.length + i + 1)).join('')}</ol>
  </section>`
      : ''
  }

  <section id="manuals">
    <div class="sechead">
      <h2>M4 manual watch</h2>
      <span class="micro">Non-Competition · manual gearbox only · ${manuals.length} live</span>
    </div>
    ${
      manuals.length
        ? `<ol class="ledger">${manuals.map((l, i) => entry(l, comp.length + i + 1)).join('')}</ol>`
        : `<div class="empty">No manual non-Competition F82s live in the scan today. UK manuals are genuinely rare — a small single-digit share of cars — and tend to surface a few times a month. This section is watched on every daily scan and new finds count toward your 4pm notification.</div>`
    }
  </section>

  <section id="m2s">
    <div class="sechead">
      <h2>M2 manual watch</h2>
      <span class="micro">F87 '16–'21 · manual gearbox only · N55 + Competition · ${m2s.length} live</span>
    </div>
    ${
      m2s.length
        ? `<ol class="ledger">${m2s.map((l, i) => entry(l, comp.length + manuals.length + i + 1)).join('')}</ol>`
        : `<div class="empty">No manual F87 M2s inside ${gbp(criteria.watchPriceMax)} in today's scan. Manual Competitions cluster at £33–38k and move quickly; N55 manuals surface more often around £25–29k. Watched on every scan — new finds count toward your 4pm notification.</div>`
    }
  </section>

  <section id="rs5s">
    <div class="sechead">
      <h2>RS5 B9 watch</h2>
      <span class="micro">Coupé only · '17–'23 · 2.9 biturbo · ${rs5s.length} live</span>
    </div>
    ${
      rs5s.length
        ? `<ol class="ledger">${rs5s.map((l, i) => entry(l, comp.length + manuals.length + m2s.length + i + 1)).join('')}</ol>`
        : `<div class="empty">No B9 RS5 coupés inside ${gbp(criteria.watchPriceMax)} in today's scan. Coupés start around £27k and sports-exhaust cars move fastest — Sportbacks and B8 V8s are filtered out. Watched on every scan; new finds count toward your 4pm notification.</div>`
    }
  </section>

  <footer>
    <p>MODEL — prices compared against mileage-and-year-adjusted benchmarks (M4 Competition '17 @ 40k mi ≈ £34k, base ≈ £3.5k less; manual M2 Competition '19 ≈ £35.5k; N55 M2 '17 ≈ £28.5k). "Under model" means priced below expectation; deltas shown only when year and mileage are verified.</p>
    <p>Always confirm with an HPI check, full MOT history and an independent inspection before buying. Photos © their listing sources — follow the listing link for full galleries.</p>
  </footer>
</div>

<div class="sheet-veil" id="veil" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
  <div class="sheet">
    <h4 id="sheet-title">Open the listing</h4>
    <p>This viewer blocked the redirect. Copy the link and paste it into your browser:</p>
    <div class="urlrow">
      <input id="sheet-url" type="text" readonly value="">
      <button id="sheet-copy" type="button">Copy</button>
    </div>
    <button id="sheet-close" class="ghost" type="button">Close</button>
  </div>
</div>

<script>
(function () {
  'use strict';
  var veil = document.getElementById('veil');
  var input = document.getElementById('sheet-url');
  var copyBtn = document.getElementById('sheet-copy');

  function showSheet(url) {
    input.value = url;
    copyBtn.textContent = 'Copy';
    veil.classList.add('on');
    input.focus();
    input.select();
  }
  function hideSheet() { veil.classList.remove('on'); }

  document.getElementById('sheet-close').addEventListener('click', hideSheet);
  veil.addEventListener('click', function (e) { if (e.target === veil) hideSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideSheet(); });

  copyBtn.addEventListener('click', function () {
    input.select();
    var done = function () { copyBtn.textContent = 'Copied ✓'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(done, function () {
        try { document.execCommand('copy'); done(); } catch (err) { /* text stays selected for manual copy */ }
      });
    } else {
      try { document.execCommand('copy'); done(); } catch (err) { /* text stays selected for manual copy */ }
    }
  });

  // External links: try a real new tab; if the sandbox blocks it, offer the URL to copy.
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[href^="http"]') : null;
    if (!a) return;
    e.preventDefault();
    var w = null;
    // No 'noopener' feature here: it makes window.open return null even on success,
    // which is indistinguishable from a blocked popup. Sever the opener manually.
    try { w = window.open(a.href, '_blank'); } catch (err) { w = null; }
    if (w) { try { w.opener = null; } catch (err) { /* cross-origin — already isolated */ } }
    else showSheet(a.href);
  });
})();
</script>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(
  `Generated ${OUT}: ${inBudget.length} in budget, ${watch.length} watching, ` +
    `${live.filter((l) => l.image).length}/${live.length} with photos`,
);
