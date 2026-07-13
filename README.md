# LBC Seller-Trust Flag

A Tampermonkey userscript that flags untrustworthy sellers directly on Leboncoin search
results.

## Why

Some "private" sellers on Leboncoin are actually undeclared professional resellers
posing as individuals. Others are barely-registered accounts, a pattern common among
scam and no-show listings. Either way, spotting it today means opening each seller's
profile by hand and checking their registration date and other ads — nothing anyone
actually does while scrolling a results page.

This script does that check automatically, for every ad, and puts the answer directly on
the card — no clicking through profiles.

## What it does

On `leboncoin.fr` search pages, each ad card's seller is checked against two signals:

- **Account age** — registered less than a configurable number of months ago (default 6).
- **Multi-listing** — has other active ads in the same category (typical of undeclared
  professional resellers).

Sellers matching either signal get a small red badge on their ad card, labeled
**"new"**, **"multi-listing"**, or both — hover it for the full explanation.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open the raw script and Tampermonkey will prompt to install it:
   `https://github.com/gushmazuko/lbc-seller-trust/raw/main/src/lbc-seller-trust.user.js`

## Configuration

Two settings, editable via the Tampermonkey menu on the script:

| Setting                              | Range | Default |
|---------------------------------------|-------|---------|
| Set age threshold (months)…           | 1–36  | 6       |
| Set multi-listing threshold (ads)…    | 1–10  | 1       |

Changes apply to newly evaluated cards immediately; already-rendered badges are picked up
on the next page load.

## How it works

The script resolves each ad's seller via Leboncoin's own internal API, checks their
registration date and their other listings in the same category, and annotates the card
if either check fails. No ads are hidden, blocked, or reordered — it only adds a badge.

Full behavioral specification: [`docs/SPEC.md`](docs/SPEC.md).

## Limitations

- Only active on `leboncoin.fr/recherche*` search pages — not ad detail pages, profiles,
  favorites, or messaging.
- No options page or popup — configuration is menu-only.
- Trust verdicts are cached in memory for the page session only; nothing persists across
  reloads.

## Disclaimer

Unofficial and not affiliated with Leboncoin. It relies on undocumented internal API
endpoints observed via the browser and may break if Leboncoin changes its frontend.

Found a bug? Open an issue with the console output and the URL you were on.

## License

[MIT](LICENSE)
