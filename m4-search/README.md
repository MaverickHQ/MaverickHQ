# M4 Competition Watch

Daily UK-wide search for an exceptional BMW M4 (F82), 2016–2018, up to £32,000 — two lanes:
Competition (any gearbox) and manual non-Competition cars —
marketplaces plus specialist dealers, with automatic filtering of write-offs and modified cars.

## How it works

```
4pm UK daily (Claude Routine, Europe/London ≈ 15:00 UTC)
   └─ triggers .github/workflows/m4-scan.yml  (GitHub runner has open egress;
      │                                        the Claude sandbox does not)
      ├─ scripts/scan.mjs      scrapes sources → merges data/listings.json
      │                        (price history, first/last seen) and mirrors
      │                        listing photos into data/images/
      └─ commits results to this branch
   └─ Claude session pulls results, adds specialist finds via web search
      (data/curated-sources.json), runs scripts/generate-page.mjs and
      republishes site/index.html as the artifact page
```

- **The page** embeds photos as data URIs because the Claude artifact CSP blocks
  external images. It is viewable at any time; data changes once a day.
- **Sources**: AutoTrader, PistonHeads, eBay, heycar, Motors.co.uk (best-effort —
  each is skipped gracefully if it blocks the runner) plus the curated specialist
  list in `data/curated-sources.json`.
- **Criteria** live at the top of `scripts/scan.mjs` (`CRITERIA`). Cars between
  the budget cap and `watchPriceMax` appear in a separate "worth watching" section.
- **Scoring** favours: priced under a simple market model, full service history,
  low owner count, desirable spec (Harman Kardon, HUD, adaptive suspension),
  specialist sellers; modified cars are penalised, Cat S/N excluded outright.

## Run locally

```
node m4-search/scripts/scan.mjs          # needs open internet (GitHub runner)
node m4-search/scripts/generate-page.mjs # pure transform, runs anywhere
```
