# LBC Seller-Trust Flag — Userscript Specification

**Version:** 1.0.0 (draft)
**Target platform:** Tampermonkey (Chrome, Firefox, Edge)
**Deliverable:** a single file, `src/lbc-seller-trust.user.js`

## 1. Purpose

Flag Leboncoin search-result ads whose seller looks untrustworthy, directly in the
results list, so the user can skip them at a glance.

A seller is considered **untrusted** when either:

1. **Account is too young** — registered less than a configurable number of months ago
   (default **6**), or
2. **Multi-listing in the same category** — the seller has other active ads in the same
   category as the current search (a pattern typical of undeclared professional
   resellers).

Untrusted sellers get a small red badge on their ad card, labeled with the reason
(§6.3).

## 2. Scope

### In scope

- Search result pages: `https://www.leboncoin.fr/recherche*`, including results loaded
  by infinite scroll and results replaced by client-side (SPA) navigation.
- Two user-configurable thresholds — age (1–36 months, default 6) and multi-listing
  count (1–10 ads, default 1) — stored in userscript storage and editable via the
  Tampermonkey menu.

### Out of scope (non-goals)

- Ad detail pages, seller profile pages, favorites, messaging.
- Any UI beyond the badge and the menu commands (no options page, no popup).
- Persistence of trust verdicts across page loads (in-memory cache only).
- Blocking, hiding, or reordering ads — the script only annotates.

## 3. Script metadata

```javascript
// ==UserScript==
// @name         LBC Seller-Trust Flag
// @namespace    https://github.com/gushmazuko
// @version      1.2.0
// @description  Flags Leboncoin ads from young or multi-listing sellers
// @match        https://www.leboncoin.fr/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// @updateURL    https://raw.githubusercontent.com/gushmazuko/lbc-seller-trust/main/src/lbc-seller-trust.user.js
// @downloadURL  https://raw.githubusercontent.com/gushmazuko/lbc-seller-trust/main/src/lbc-seller-trust.user.js
// ==/UserScript==
```

Rationale:

- `@match .../*` (not `/recherche*`): Tampermonkey injects only on full page loads.
  The user may land anywhere on the site and reach search via client-side navigation,
  so the script must be present on every page and activate itself only on search URLs
  (see §6).
- `@noframes`: never run in iframes.
- No `@connect` / `GM_xmlhttpRequest`: the script calls `api.leboncoin.fr` with plain
  `fetch(..., { credentials: "include" })`. The page's own frontend performs the same
  cross-origin credentialed calls, so the API's CORS policy already admits the
  `www.leboncoin.fr` origin the script runs under.
- `@updateURL`/`@downloadURL` point at the raw `main`-branch file: no build step, no
  release pipeline — `src/lbc-seller-trust.user.js` on `main` **is** the distributable.
  Tampermonkey compares `@version` against this URL on its own update schedule; the
  only maintenance rule is to bump `@version` whenever the script changes.

## 4. Settings

| Key               | Type    | Default | Range | Storage      |
|-------------------|---------|---------|-------|--------------|
| `monthsThreshold` | integer | 6       | 1–36  | `GM_setValue` |
| `multiListingMin` | integer | 1       | 1–10  | `GM_setValue` |

- Both are read at startup with `GM_getValue(key, default)`.
- Two menu commands, registered with `GM_registerMenuCommand`:
  - **"Set age threshold (months)…"** — clamped to `[1, 36]`.
  - **"Set multi-listing threshold (ads)…"** — clamped to `[1, 10]`; this is
    `MULTI_LISTING_MIN` from §5.2-C, made user-configurable so sellers with only one
    or two other ads in a category can be tolerated instead of always flagged.
  Each opens `prompt()` pre-filled with the current value; non-numeric input keeps
  the current value.
- A changed value applies immediately to subsequent checks. Already-rendered badges
  and cached verdicts are not recomputed (page reload picks them up).

## 5. Trust evaluation

### 5.1 Inputs

For each ad card the script extracts:

- `listId` — final numeric segment of the ad link's pathname
  (`a[href*='/ad/']` → `/ad/<category-slug>/<listId>`). Non-numeric → skip the card.
- `userId` — from the ad detail endpoint (§5.2, call A).
- `categoryId` — the ad's own `category_id` (§5.2, call A), a numeric string (e.g.
  `"81"`). Falls back to the `category` query parameter of the current page URL only
  if the ad-level field is missing/empty. This makes the multi-listing check (§5.2-C)
  work on every search, not only ones with a category filter applied.

### 5.2 API calls

All calls: `credentials: "include"`, and **any non-`ok` HTTP status or JSON parse
failure aborts the evaluation as trusted (fail-open, §5.5)**.

**A. Resolve the seller and category** —
`GET https://api.leboncoin.fr/finder/classified/{listId}`
→ `owner.user_id` and `category_id` (confirmed live: a top-level numeric-string field,
e.g. `"81"` for "Accessoires téléphone & Objets connectés"). Missing `owner.user_id` →
skip the card silently.

**B. Account age** —
`GET https://api.leboncoin.fr/api/user-card/v1/{userId}/infos`
(`userId` interpolated with `encodeURIComponent`)
→ `registered_at` (ISO date).

```
ageOk = (Date.now() - Date.parse(registered_at)) >= monthsThreshold * 30.4375 * 86_400_000
```

An unparseable `registered_at` (`NaN`) counts as **failure → fail-open**, not as
"too young".

**C. Multi-listing** —
`POST https://api.leboncoin.fr/api/adfinder/v1/owner_listing`
`Content-Type: application/json`

```json
{
  "owner_user_id": "<userId>",
  "displayed_id": <listId as number>,
  "limit": 2,
  "category_id": <categoryId as number>
}
```

→ `aggregations.category_id` is an object keyed by category id (string keys).

```
sameCatCount = aggregations.category_id?.[categoryId] ?? 0
multi        = sameCatCount >= multiListingMin   // user setting, default 1, §4
```

If the page URL has **no** `category` parameter, skip call C entirely and evaluate on
age alone (`multi = false`). Never send `category_id: 0` or `NaN`.

**Confirmed:** the endpoint excludes the viewed ad from its own counts — the response's
`pivot.exclude_ids` contains the submitted `displayed_id`, and the returned
`aggregations.category_id` totals are consistent with that exclusion (verified against
a live pro seller: 16 other ads in category 17, `displayed_id` excluded from both the
`ads` list and the aggregation). So `sameCatCount` is always "other ads besides this
one" — `MULTI_LISTING_MIN = 1` is correct as specified; no calibration adjustment
needed.

### 5.3 Verdict

```
reasons = []
if (!ageOk) reasons.push("young")
if (multi)  reasons.push("multi")
trusted = reasons.length === 0
```

A seller can be flagged for both reasons at once. `trusted === false` → badge with a
reason tooltip (§6.3). `trusted === true` → no DOM change.

### 5.4 Caching and deduplication

Two in-memory `Map`s, lifetime = page lifetime:

- **Verdict cache** — key `"{userId}::{listId}::{categoryId}"` → `{ trusted, reasons }`.
- **In-flight map** — same key → pending `Promise`, so concurrent evaluations of the
  same key share one request chain instead of duplicating calls B/C. The entry is
  removed when the promise settles.
- Additionally, call B's result (`registered_at` per `userId`) is cached per user, so
  a seller appearing in several ads costs one age lookup.
- Failure verdicts (§5.5) are **not** cached — a later scroll-past may retry.

No eviction: bounded in practice by the number of ads seen in one page session.

### 5.5 Error handling — fail-open and blocked-response detection

Any failure in calls B or C (network error, non-`ok` status, parse error, `NaN`
date) resolves the evaluation to `{ trusted: true, reasons: [] }` and is not cached.
The script must never flag a seller because an API call failed, and must never throw
an unhandled rejection.

Failures are further split into two logged categories:

- **Blocked** — the response looks like anti-bot interference rather than an ordinary
  failure: a non-JSON `Content-Type`, an HTTP `403`/`429`, or a body that fails to
  parse as JSON. Logged via `console.error`, throttled to the 1st occurrence and then
  every 20th occurrence per page session, so a sustained block doesn't spam the
  console while still being loud enough to notice (as opposed to silently looking
  like "every seller is trustworthy").
- **Ordinary** — network failures (e.g. offline) and JSON-bodied HTTP errors (e.g. a
  real `500`). Logged via a plain `console.warn`, unthrottled, as before.

### 5.6 Rate limiting

At most **4 concurrent** evaluation chains (simple semaphore). Excess cards queue in
FIFO order. This bounds burst traffic against the API when a results page renders
30+ cards at once.

## 6. Page integration

### 6.1 Activation

The script installs one URL predicate: `location.pathname.startsWith("/recherche")`.
Card processing is a no-op when the predicate is false. No navigation events are
hooked — activation is checked per processed node, which makes SPA transitions
free.

### 6.2 Card discovery

- Card selector: `[data-qa-id="aditem_container"]`.
- On startup: process all current matches.
- One persistent `MutationObserver` on `document.body`
  (`{ childList: true, subtree: true }`):
  - added node matching the selector → process it;
  - added node *containing* matches → process those matches.
- A module-level `WeakSet` of processed card nodes prevents rework; the observer is
  installed exactly once (single script instance per page — guaranteed by
  Tampermonkey + `@noframes`).

### 6.3 Badge

- Class: `lbc-no-trust`; text is the reason label(s), joined with `" + "`:
  `"new"` (young account), `"multi-listing"` (other ads in the same category), or
  `"new + multi-listing"` when a seller matches both signals.
- `title` tooltip states the reason(s) in full, joined with `" and "` when both
  apply — e.g. `"Seller: new account (< 6 months) and multiple listings in this
  category"`.
- Insertion point: the card's `.mb-md.flex.items-center.gap-sm` container; fallback:
  `p[data-test-id="price"]`; last resort: the card node itself.
- Style (inline): white text on `#c0392b`, `font-size: 12px`, `padding: 2px 6px`,
  `border-radius: 4px`, `margin-left: 4px`, `display: inline-block`.
- Guards before insertion: the card is still connected to the DOM
  (`node.isConnected`) and does not already contain `.lbc-no-trust`.

## 7. Repository layout

```
docs/SPEC.md                    ← this document
src/lbc-seller-trust.user.js    ← the userscript (single file)
```

## 8. Acceptance criteria

1. On a `/recherche` results page, ads from sellers registered < threshold months ago
   show the badge; older single-listing sellers show nothing.
2. Infinite scroll: newly loaded cards are evaluated and badged without reload.
3. SPA navigation to a different query/category: new cards are evaluated with the
   **new** category id; no duplicate observers or duplicate badges appear after any
   number of navigations.
4. A seller present in N cards triggers exactly one age lookup (call B) — verified
   via the network panel.
5. With the network blocked or the API returning 403/429, **no** badges appear and
   the console shows warnings, not uncaught errors.
6. Changing the threshold via the Tampermonkey menu affects the next page load.
7. The script never runs in iframes and does nothing on non-search pages.
