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

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  const MS_IN_DAY = 86_400_000;
  const MAX_CONCURRENT = 4;

  const CARD_SELECTOR = '[data-qa-id="aditem_container"]';
  const BADGE_CONTAINER_SELECTOR = ".mb-md.flex.items-center.gap-sm";
  const PRICE_SELECTOR = 'p[data-test-id="price"]';

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------
  let monthsThreshold = GM_getValue("monthsThreshold", 6);

  GM_registerMenuCommand("Set age threshold (months)…", () => {
    const input = prompt(
      "Flag sellers registered less than how many months ago?",
      String(monthsThreshold)
    );
    if (input === null) return;
    const next = Math.max(1, Math.min(36, Number(input) || monthsThreshold));
    monthsThreshold = next;
    GM_setValue("monthsThreshold", next);
  });

  // owner_listing excludes the viewed ad itself (see response.pivot.exclude_ids),
  // so this counts OTHER ads only — >=1 other ad means >=2 total in the category.
  let multiListingMin = GM_getValue("multiListingMin", 1);

  GM_registerMenuCommand("Set multi-listing threshold (ads)…", () => {
    const input = prompt(
      "Flag sellers with how many other ads in the same category?",
      String(multiListingMin)
    );
    if (input === null) return;
    const next = Math.max(1, Math.min(10, Number(input) || multiListingMin));
    multiListingMin = next;
    GM_setValue("multiListingMin", next);
  });

  // ---------------------------------------------------------------------
  // Concurrency limiter — bounds burst API traffic (SPEC §5.6)
  // ---------------------------------------------------------------------
  function createSemaphore(limit) {
    let active = 0;
    const queue = [];

    function next() {
      if (queue.length === 0 || active >= limit) return;
      active++;
      const resolve = queue.shift();
      resolve();
    }

    return {
      acquire() {
        return new Promise(resolve => {
          queue.push(resolve);
          next();
        });
      },
      release() {
        active--;
        next();
      }
    };
  }

  const evalSemaphore = createSemaphore(MAX_CONCURRENT);

  // ---------------------------------------------------------------------
  // Trust engine — network + caching, no DOM (SPEC §5)
  // ---------------------------------------------------------------------
  function blockedError(url, detail) {
    const err = new Error(`possibly blocked by anti-bot protection — ${url} (${detail})`);
    err.blocked = true;
    return err;
  }

  async function fetchJson(url, init) {
    const res = await fetch(url, { credentials: "include", ...init });
    const contentType = res.headers.get("content-type") || "";
    const looksJson = contentType.includes("json");

    if (!res.ok) {
      if (!looksJson || res.status === 403 || res.status === 429) {
        throw blockedError(url, `HTTP ${res.status}, content-type "${contentType}"`);
      }
      throw new Error(`${url} → HTTP ${res.status}`);
    }
    if (!looksJson) {
      throw blockedError(url, `unexpected content-type "${contentType}" on 200`);
    }
    try {
      return await res.json();
    } catch (err) {
      throw blockedError(url, `JSON parse failed: ${err.message}`);
    }
  }

  // Counts and throttles the loud anti-bot warning so a sustained block doesn't
  // spam the console; ordinary (non-blocked) failures stay a plain console.warn.
  let blockedCount = 0;
  const BLOCKED_LOG_EVERY = 20;

  function logFetchFailure(err) {
    if (err && err.blocked) {
      blockedCount++;
      if (blockedCount === 1 || blockedCount % BLOCKED_LOG_EVERY === 0) {
        console.error(
          `[lbc-trust] possibly blocked by anti-bot protection (${blockedCount} occurrence${blockedCount > 1 ? "s" : ""} this session)`,
          err
        );
      }
    } else {
      console.warn("[lbc-trust]", err);
    }
  }

  // Per-user memoised age lookup: caching the promise gives in-flight
  // dedupe for free. Failed lookups are evicted so a later retry can
  // succeed instead of being stuck on a cached rejection.
  const registeredAtCache = new Map(); // userId -> Promise<string>

  function getRegisteredAt(userId) {
    if (!registeredAtCache.has(userId)) {
      const promise = fetchJson(
        `https://api.leboncoin.fr/api/user-card/v1/${encodeURIComponent(userId)}/infos`
      ).then(data => data.registered_at);
      promise.catch(() => registeredAtCache.delete(userId));
      registeredAtCache.set(userId, promise);
    }
    return registeredAtCache.get(userId);
  }

  function computeAgeOk(registeredAt) {
    const registeredMs = Date.parse(registeredAt);
    if (Number.isNaN(registeredMs)) {
      throw new Error(`unparseable registered_at: ${registeredAt}`);
    }
    return Date.now() - registeredMs >= monthsThreshold * 30.4375 * MS_IN_DAY;
  }

  async function getSameCategoryCount(userId, listId, categoryId) {
    const data = await fetchJson(
      "https://api.leboncoin.fr/api/adfinder/v1/owner_listing",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_user_id: userId,
          displayed_id: Number(listId),
          limit: 2,
          category_id: Number(categoryId)
        })
      }
    );
    return data.aggregations?.category_id?.[categoryId] ?? 0;
  }

  const verdictCache = new Map(); // "userId::listId::categoryId" -> { trusted, reasons }
  const inFlight = new Map(); // same key -> Promise<{ trusted, reasons }>

  function evaluateSeller({ userId, listId, categoryId }) {
    const key = `${userId}::${listId}::${categoryId}`;

    if (verdictCache.has(key)) return Promise.resolve(verdictCache.get(key));
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
      await evalSemaphore.acquire();
      try {
        const registeredAt = await getRegisteredAt(userId);
        const ageOk = computeAgeOk(registeredAt);

        let multi = false;
        if (categoryId) {
          const sameCatCount = await getSameCategoryCount(userId, listId, categoryId);
          multi = sameCatCount >= multiListingMin;
        }

        const reasons = [];
        if (!ageOk) reasons.push("young");
        if (multi) reasons.push("multi");
        const result = { trusted: reasons.length === 0, reasons };
        verdictCache.set(key, result);
        return result;
      } catch (err) {
        logFetchFailure(err);
        return { trusted: true, reasons: [] }; // fail-open — not cached, SPEC §5.5
      } finally {
        evalSemaphore.release();
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, promise);
    return promise;
  }

  // ---------------------------------------------------------------------
  // DOM layer — ad-card discovery and badge (SPEC §6)
  // ---------------------------------------------------------------------
  function isSearchPage() {
    return location.pathname.startsWith("/recherche");
  }

  const REASON_LABEL = {
    young: "new",
    multi: "multi-listing"
  };

  const REASON_TEXT = {
    young: () => `new account (< ${monthsThreshold} months)`,
    multi: () => `multiple listings in this category`
  };

  function addBadge(card, reasons) {
    if (!card.isConnected) return;
    if (card.querySelector(".lbc-no-trust")) return;

    const badge = document.createElement("div");
    badge.textContent = reasons.map(r => REASON_LABEL[r]).join(" + ");
    badge.className = "lbc-no-trust";
    badge.title = `Seller: ${reasons.map(r => REASON_TEXT[r]()).join(" and ")}`;
    Object.assign(badge.style, {
      color: "white",
      background: "#c0392b",
      fontSize: "12px",
      padding: "2px 6px",
      borderRadius: "4px",
      display: "inline-block",
      marginLeft: "4px"
    });

    const flexContainer = card.querySelector(BADGE_CONTAINER_SELECTOR);
    if (flexContainer) {
      flexContainer.appendChild(badge);
      return;
    }
    const priceEl = card.querySelector(PRICE_SELECTOR) || card;
    priceEl.appendChild(badge);
  }

  const seen = new WeakSet();

  function processNode(card) {
    if (!isSearchPage()) return;
    if (seen.has(card)) return;
    seen.add(card);

    const link = card.querySelector("a[href*='/ad/']");
    if (!link) return;
    const listId = link.pathname.split("/").pop();
    if (!/^\d+$/.test(listId)) return;

    const urlCategoryId = new URL(location.href).searchParams.get("category") || "";

    fetchJson(`https://api.leboncoin.fr/finder/classified/${listId}`)
      .then(data => {
        const { owner } = data;
        if (!owner?.user_id) return;
        const categoryId = String(data.category_id ?? "") || urlCategoryId;
        return evaluateSeller({ userId: owner.user_id, listId, categoryId }).then(
          ({ trusted, reasons }) => {
            if (!trusted) addBadge(card, reasons);
          }
        );
      })
      .catch(logFetchFailure);
  }

  function processAllAds() {
    document.querySelectorAll(CARD_SELECTOR).forEach(processNode);
  }

  processAllAds();

  new MutationObserver(muts => {
    muts.forEach(m => {
      m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (n.matches?.(CARD_SELECTOR)) processNode(n);
        n.querySelectorAll?.(CARD_SELECTOR).forEach(processNode);
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
})();
