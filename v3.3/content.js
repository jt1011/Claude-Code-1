/**
 * LinkedIn Engagement Highlighter V3.3 - Content Script
 *
 * V3.3 additions over V3.2:
 * - Bulk Post Caption Copy: one-click copy of all post captions to clipboard,
 *   organized by author with full post text (not just hooks).
 * - Auto-expand "see more": before extraction, automatically clicks LinkedIn's
 *   "…see more" buttons to reveal full post text.
 * - Full caption in export: JSON, CSV, and text exports now include full
 *   post caption (not truncated to 300 chars).
 * - "Copy All Captions" button in both the control panel and the export modal.
 *
 * Works on Feed, Activity, Company, Search, and Profile pages.
 * Reads only visible DOM elements. No network requests. No data collection.
 */

(function () {
  "use strict";

  // ─── State ───────────────────────────────────────────────────────────
  let enabled = true;
  let showScores = true;
  let mode = "percentile";
  let absoluteThreshold = 100;
  let weights = { reactions: 5, comments: 10, reposts: 2 };
  let debounceTimer = null;

  const DEBOUNCE_MS = 300;

  // ─── Date filter ─────────────────────────────────────────────────────
  let dateFilter = "all";
  let customDateFrom = "";
  let customDateTo = "";

  // ─── Auto-scroll ─────────────────────────────────────────────────────
  let autoScrollEnabled = false;
  let autoScrollRafId = null;
  let autoScrollSpeed = 3;
  let lastScrollTime = 0;
  let showMoreHandled = false;
  let showMorePollId = null;

  const SCROLL_SPEEDS = [300, 600, 1200, 2200, 3500, 5500];

  // ─── Cache ───────────────────────────────────────────────────────────
  const scoredCache = new WeakMap();
  let lastScoredPosts = [];

  // ─── Page Type ───────────────────────────────────────────────────────

  function getPageType() {
    const path = window.location.pathname;
    if (path === "/feed" || path === "/feed/" || path === "/" || path === "") return "feed";
    if (path.includes("/recent-activity")) return "activity";
    if (path.startsWith("/company/")) return "company";
    if (path.startsWith("/search/")) return "search";
    if (path.startsWith("/posts/")) return "post";
    if (path.startsWith("/in/")) {
      if (path.includes("/detail/") || path.includes("/overlay/")) return "post";
      return "profile";
    }
    return "feed";
  }

  // ─── Number Helpers ──────────────────────────────────────────────────

  function parseCount(text) {
    if (!text) return 0;
    text = text.trim().replace(/,/g, "");
    const m = text.match(/^([\d.]+)\s*([KMB])?$/i);
    if (!m) return 0;
    const num = parseFloat(m[1]);
    if (isNaN(num)) return 0;
    const mul = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1;
    return Math.round(num * mul);
  }

  function extractFirstNumber(text) {
    if (!text) return 0;
    const m = text.match(/([\d,]+\.?\d*)\s*([KMB])?/i);
    if (!m) return 0;
    return parseCount(m[1].replace(/,/g, "") + (m[2] || ""));
  }

  function formatCount(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  }

  // ════════════════════════════════════════════════════════════════════
  //  POST DETECTION  (V3.2 rewrite — merges ALL strategies)
  // ════════════════════════════════════════════════════════════════════

  function getMainArea() {
    return (
      document.querySelector("main") ||
      document.querySelector(".scaffold-layout__main") ||
      document.querySelector('[role="main"]') ||
      document.body
    );
  }

  function findAllPosts() {
    const main = getMainArea();
    const found = new Set();

    // ── Strategy 1: Known LinkedIn class ──
    main.querySelectorAll(".feed-shared-update-v2").forEach((el) => found.add(el));

    // ── Strategy 2: data-urn for activity / ugcPost ──
    main
      .querySelectorAll('div[data-urn*="urn:li:activity"], div[data-urn*="urn:li:ugcPost"]')
      .forEach((el) => found.add(el));

    // ── Strategy 3: Occludable wrappers (virtual scroll) ──
    main.querySelectorAll(".occludable-update").forEach((wrapper) => {
      const inner = wrapper.querySelector(".feed-shared-update-v2");
      found.add(inner || wrapper);
    });

    // ── Strategy 4: Walk up from social-counts containers ──
    main
      .querySelectorAll('.social-details-social-counts, [class*="social-counts"]')
      .forEach((countEl) => {
        const post = walkUpToPost(countEl, main);
        if (post) found.add(post);
      });

    // ── Strategy 5: Walk up from social-action bars ──
    main
      .querySelectorAll(
        '.feed-shared-social-actions, .social-details-social-activity, [class*="social-action"]'
      )
      .forEach((bar) => {
        const post = walkUpToPost(bar, main);
        if (post) found.add(post);
      });

    // ── Strategy 6: action-button anchor ──
    main.querySelectorAll("button").forEach((btn) => {
      const label = (btn.textContent || "").trim();
      if (label === "Like" || label === "Support" || label === "Celebrate" || label === "Love" || label === "Insightful" || label === "Funny") {
        const post = walkUpToPost(btn, main, 10);
        if (post) found.add(post);
      }
    });

    // ── Strategy 7: text-pattern anchor ──
    main.querySelectorAll("span, button, a").forEach((el) => {
      if (el.children.length > 4) return;
      const t = (el.textContent || "").trim();
      if (t.length > 40) return;
      if (/^\d[\d,]*\s+comments?$/i.test(t) || /^\d[\d,]*\s+reposts?$/i.test(t)) {
        const post = walkUpToPost(el, main);
        if (post) found.add(post);
      }
    });

    return deduplicatePosts(Array.from(found));
  }

  function walkUpToPost(startEl, boundary, maxSteps) {
    maxSteps = maxSteps || 8;
    let el = startEl;
    for (let i = 0; i < maxSteps && el && el !== boundary && el !== document.body; i++) {
      el = el.parentElement;
      if (!el) break;
      if (
        el.getAttribute("data-urn") ||
        el.getAttribute("data-id") ||
        el.classList.contains("feed-shared-update-v2") ||
        el.classList.contains("occludable-update")
      ) {
        return el;
      }
    }
    el = startEl;
    for (let i = 0; i < maxSteps && el && el !== boundary && el !== document.body; i++) {
      el = el.parentElement;
      if (!el) break;
      if (el.offsetHeight >= 150 && el.offsetWidth >= 300) {
        if (el.querySelector("button")) return el;
      }
    }
    return null;
  }

  function deduplicatePosts(elements) {
    elements.sort((a, b) => getDepth(a) - getDepth(b));
    const kept = [];
    for (const el of elements) {
      const dominated = kept.some((k) => k.contains(el) || el.contains(k));
      if (!dominated) kept.push(el);
    }
    return kept.map((el) => ({ element: el, type: "feed" }));
  }

  function getDepth(el) {
    let d = 0;
    let n = el;
    while (n) { n = n.parentElement; d++; }
    return d;
  }

  // ════════════════════════════════════════════════════════════════════
  //  ENGAGEMENT EXTRACTION
  // ════════════════════════════════════════════════════════════════════

  function extractEngagement(postInfo) {
    const post = postInfo.element;
    let reactions = 0;
    let comments = 0;
    let reposts = 0;

    // --- Pass 1: social-counts container ---
    const countsEl = post.querySelector(
      '.social-details-social-counts, [class*="social-counts"]'
    );
    if (countsEl) {
      const rEl =
        countsEl.querySelector(".social-details-social-counts__reactions-count") ||
        countsEl.querySelector('[data-control-name="reactions_count"]') ||
        countsEl.querySelector('button[aria-label*="reaction"] span') ||
        countsEl.querySelector('span[class*="reactions-count"]');
      if (rEl) reactions = extractFirstNumber(rEl.textContent);

      if (reactions === 0) {
        for (const span of countsEl.querySelectorAll("span")) {
          const t = (span.textContent || "").trim();
          const n = extractFirstNumber(t);
          if (n > 0 && !/comment|repost/i.test(t)) { reactions = n; break; }
        }
      }

      for (const el of countsEl.querySelectorAll("button, a, span, li")) {
        const t = (el.textContent || "").trim();
        if (comments === 0) {
          const cm = t.match(/([\d,.]+[KMB]?)\s*comments?/i);
          if (cm) comments = parseCount(cm[1].replace(/,/g, ""));
        }
        if (reposts === 0) {
          const rm = t.match(/([\d,.]+[KMB]?)\s*reposts?/i);
          if (rm) reposts = parseCount(rm[1].replace(/,/g, ""));
        }
      }
    }

    // --- Pass 2: aria-label scan on buttons ---
    if (reactions === 0 && comments === 0 && reposts === 0) {
      for (const btn of post.querySelectorAll("button[aria-label]")) {
        const lbl = (btn.getAttribute("aria-label") || "").toLowerCase();
        const num = (txt) => { const m = txt.match(/([\d,.]+[KMB]?)/i); return m ? parseCount(m[1].replace(/,/g, "")) : 0; };
        if ((lbl.includes("reaction") || lbl.includes("like")) && !lbl.includes("unlike"))
          reactions = Math.max(reactions, num(lbl));
        if (lbl.includes("comment"))
          comments = Math.max(comments, num(lbl));
        if (lbl.includes("repost") || lbl.includes("share"))
          reposts = Math.max(reposts, num(lbl));
      }
    }

    // --- Pass 3: broad text-pattern scan ---
    if (reactions === 0 && comments === 0 && reposts === 0) {
      for (const node of post.querySelectorAll("span, button, a")) {
        if (node.children.length > 5) continue;
        const t = (node.textContent || "").trim();
        if (t.length > 100) continue;
        if (reactions === 0) { const m = t.match(/([\d,.]+[KMB]?)\s*(?:reactions?|likes?)/i); if (m) reactions = parseCount(m[1].replace(/,/g, "")); }
        if (comments === 0) { const m = t.match(/([\d,.]+[KMB]?)\s*comments?/i); if (m) comments = parseCount(m[1].replace(/,/g, "")); }
        if (reposts === 0) { const m = t.match(/([\d,.]+[KMB]?)\s*reposts?/i); if (m) reposts = parseCount(m[1].replace(/,/g, "")); }
      }
    }

    // --- Pass 4: reaction count near emoji images ---
    if (reactions === 0) {
      for (const img of post.querySelectorAll('img[class*="reactions-icon"], img[src*="reactions"], img[alt*="reaction"], img[src*="like"], img[src*="praise"], img[src*="empathy"]')) {
        const parent = img.parentElement;
        if (!parent) continue;
        const n = extractFirstNumber(parent.textContent);
        if (n > 0) { reactions = n; break; }
        const sib = parent.nextElementSibling || parent.parentElement;
        if (sib) { const sn = extractFirstNumber(sib.textContent); if (sn > 0) { reactions = sn; break; } }
      }
    }

    // --- Pass 5: combined "N comments · N reposts" text ---
    if (comments === 0 && reposts === 0) {
      for (const el of post.querySelectorAll("span, button, a")) {
        const t = (el.textContent || "").trim();
        const combined = t.match(/([\d,.]+[KMB]?)\s*comments?\s*[·•]\s*([\d,.]+[KMB]?)\s*reposts?/i);
        if (combined) {
          comments = parseCount(combined[1].replace(/,/g, ""));
          reposts = parseCount(combined[2].replace(/,/g, ""));
          break;
        }
      }
    }

    return { reactions, comments, reposts };
  }

  // ════════════════════════════════════════════════════════════════════
  //  DATE EXTRACTION
  // ════════════════════════════════════════════════════════════════════

  function extractPostDate(postEl) {
    const timeEl = postEl.querySelector("time[datetime]");
    if (timeEl) {
      const d = new Date(timeEl.getAttribute("datetime"));
      if (!isNaN(d.getTime())) return d;
    }

    for (const t of postEl.querySelectorAll("time")) {
      const parsed = parseRelativeTime((t.textContent || "").trim());
      if (parsed) return parsed;
    }

    for (const el of postEl.querySelectorAll(
      '.feed-shared-actor__sub-description, [class*="actor__sub-description"]'
    )) {
      const parsed = parseRelativeTime((el.textContent || "").trim());
      if (parsed) return parsed;
    }

    for (const span of postEl.querySelectorAll("span")) {
      const t = (span.textContent || "").trim();
      if (t.length < 2 || t.length > 20) continue;
      const parsed = parseRelativeTime(t);
      if (parsed) return parsed;
    }

    return null;
  }

  function parseRelativeTime(text) {
    if (!text) return null;
    text = text.toLowerCase().replace(/edited|ago|•|·/g, "").trim();
    if (text === "now" || text === "just now") return new Date();
    const now = Date.now();
    const patterns = [
      [/^(\d+)\s*m(?:in)?s?$/, 60e3],
      [/^(\d+)\s*h(?:r|our)?s?$/, 3600e3],
      [/^(\d+)\s*d(?:ay)?s?$/, 86400e3],
      [/^(\d+)\s*w(?:eek|k)?s?$/, 604800e3],
      [/^(\d+)\s*mo(?:nth)?s?$/, 2592000e3],
      [/^(\d+)\s*y(?:r|ear)?s?$/, 31536000e3],
    ];
    for (const [re, ms] of patterns) {
      const m = text.match(re);
      if (m) return new Date(now - parseInt(m[1], 10) * ms);
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════════════
  //  V3.3 — AUTO-EXPAND "SEE MORE" BUTTONS
  // ════════════════════════════════════════════════════════════════════

  /**
   * Clicks all visible "…see more" buttons within detected posts so that
   * full post text becomes available in the DOM before extraction.
   * Returns a Promise that resolves after all expansions have settled.
   */
  function expandAllSeeMore() {
    const main = getMainArea();
    const seeMoreBtns = [];

    // LinkedIn uses several patterns for the "see more" toggle
    const selectors = [
      'button[class*="see-more"]',
      'button[class*="show-more-text"]',
      'a[class*="see-more"]',
      '[data-control-name="see_more"]',
    ];

    for (const sel of selectors) {
      main.querySelectorAll(sel).forEach((btn) => seeMoreBtns.push(btn));
    }

    // Also catch by text content — LinkedIn sometimes uses generic <button>
    main.querySelectorAll("button, a").forEach((el) => {
      const t = (el.textContent || "").trim().toLowerCase();
      // Match "…see more", "...see more", "see more" but not "Show more results"
      if (
        (t === "see more" || t === "…see more" || t === "...see more" || t === "\u2026see more") &&
        !seeMoreBtns.includes(el)
      ) {
        seeMoreBtns.push(el);
      }
    });

    // Deduplicate
    const unique = [...new Set(seeMoreBtns)];
    let clicked = 0;

    for (const btn of unique) {
      // Only click if the button is visible and inside a post-like container
      if (btn.offsetParent === null) continue;
      try {
        btn.click();
        clicked++;
      } catch { /* ignore click errors */ }
    }

    // Give LinkedIn's JS time to expand the text
    return new Promise((resolve) => setTimeout(resolve, clicked > 0 ? 600 : 0));
  }

  // ════════════════════════════════════════════════════════════════════
  //  POST METADATA — author, URL, caption, hook, media, date
  // ════════════════════════════════════════════════════════════════════

  function extractPostMeta(postInfo) {
    const post = postInfo.element;
    let username = "";
    let displayName = "";
    let postUrl = "";
    let caption = "";
    let fullCaption = "";
    let hook = "";
    let mediaType = "text";
    let date = null;

    // ── Author ──────────────────────────────────────────────────────
    const actorEl = post.querySelector(
      '.feed-shared-actor__name, [class*="actor__name"], .update-components-actor__name'
    );
    if (actorEl) {
      displayName = (actorEl.textContent || "").trim().replace(/\s+/g, " ");
      displayName = displayName.replace(/View .+'s profile/i, "").trim();
    }

    for (const link of post.querySelectorAll('a[href*="/in/"]')) {
      const href = link.getAttribute("href") || "";
      const um = href.match(/\/in\/([A-Za-z0-9_-]+)/);
      if (um) {
        username = um[1];
        if (!displayName) displayName = (link.textContent || "").trim().replace(/\s+/g, " ");
        break;
      }
    }

    if (!username) {
      for (const link of post.querySelectorAll('a[href*="/company/"]')) {
        const href = link.getAttribute("href") || "";
        const cm = href.match(/\/company\/([A-Za-z0-9_-]+)/);
        if (cm) {
          username = cm[1];
          if (!displayName) displayName = (link.textContent || "").trim().replace(/\s+/g, " ");
          break;
        }
      }
    }

    if (!username) {
      const pt = getPageType();
      if (pt === "activity" || pt === "profile") {
        const pm = window.location.pathname.match(/\/in\/([A-Za-z0-9_-]+)/);
        if (pm) username = pm[1];
      }
    }

    // ── Post URL ────────────────────────────────────────────────────
    const urn = post.getAttribute("data-urn") || post.getAttribute("data-id") || "";
    if (urn && urn.includes("urn:li:")) {
      postUrl = "https://www.linkedin.com/feed/update/" + urn;
    }
    if (!postUrl) {
      const timeLink = post.querySelector("time");
      if (timeLink) {
        const aParent = timeLink.closest("a[href]");
        if (aParent) {
          const h = aParent.getAttribute("href") || "";
          postUrl = h.startsWith("http") ? h : "https://www.linkedin.com" + h;
        }
      }
    }
    if (!postUrl) {
      for (const a of post.querySelectorAll('a[href*="/feed/update/"], a[href*="/posts/"]')) {
        const h = a.getAttribute("href") || "";
        postUrl = h.startsWith("http") ? h : "https://www.linkedin.com" + h;
        break;
      }
    }

    // ── Caption (V3.3: full text, no truncation) ──────────────────
    const textEl = post.querySelector(
      '.update-components-text, .feed-shared-text, [class*="update-components-text"]'
    );
    let fullText = "";
    if (textEl) {
      fullText = (textEl.innerText || textEl.textContent || "").trim();
    }
    if (!fullText) {
      for (const span of post.querySelectorAll('span[dir="ltr"], span[dir="auto"]')) {
        const t = (span.innerText || span.textContent || "").trim();
        if (t.length > 30 && t.length < 5000) { fullText = t; break; }
      }
    }

    // Clean up LinkedIn's "...more" suffix
    fullText = fullText.replace(/…see more|\.\.\.see more|…more|\.\.\.more/gi, "").trim();

    // V3.3: keep full caption intact (no 300-char truncation)
    fullCaption = fullText;
    caption = fullText.length > 300 ? fullText.substring(0, 297) + "..." : fullText;

    // ── Hook (first 3 lines) ────────────────────────────────────────
    hook = extractHook(fullText);

    // ── Media type ──────────────────────────────────────────────────
    mediaType = detectMediaType(post);

    // ── Date ────────────────────────────────────────────────────────
    date = extractPostDate(post);

    return {
      username: displayName || username || "",
      postUrl,
      caption,
      fullCaption,
      hook,
      mediaType,
      date,
    };
  }

  function extractHook(fullText) {
    if (!fullText) return "";
    const lines = fullText
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const hookLines = lines.slice(0, 3);
    let result = hookLines.join("\n");
    if (lines.length > 3) result += "...";
    if (result.length > 250) result = result.substring(0, 247) + "...";
    return result;
  }

  function detectMediaType(postEl) {
    if (
      postEl.querySelector(
        'video, [class*="video-player"], [class*="update-components-video"], [data-urn*="video"]'
      )
    )
      return "video";

    if (
      postEl.querySelector(
        '[class*="document"], [class*="update-components-document"], [class*="ssplayer"]'
      )
    )
      return "document";

    if (
      postEl.querySelector(
        '[class*="carousel"], [class*="update-components-carousel"]'
      )
    )
      return "carousel";

    if (
      postEl.querySelector(
        '[class*="article"], [class*="update-components-article"], a[class*="app-aware-link"][href*="http"]'
      )
    ) {
      const articleCard = postEl.querySelector(
        '[class*="update-components-article"], [class*="feed-shared-article"]'
      );
      if (articleCard) return "article";
    }

    const imageContainers = postEl.querySelectorAll(
      '[class*="update-components-image"], [class*="feed-shared-image"], [class*="ivm-image-view-model"]'
    );
    if (imageContainers.length > 0) return "image";

    for (const img of postEl.querySelectorAll("img")) {
      const src = (img.getAttribute("src") || "").toLowerCase();
      const cls = (img.getAttribute("class") || "").toLowerCase();
      if (
        cls.includes("presence") || cls.includes("avatar") ||
        cls.includes("reactions-icon") || cls.includes("ivm-view-attr") ||
        src.includes("profile") || src.includes("emoji") ||
        src.includes("reactions") || src.includes("data:image")
      )
        continue;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w > 200 || h > 200) return "image";
    }

    return "text";
  }

  // ════════════════════════════════════════════════════════════════════
  //  SCORING
  // ════════════════════════════════════════════════════════════════════

  function calculateScore(eng) {
    return eng.reactions * weights.reactions + eng.comments * weights.comments + eng.reposts * weights.reposts;
  }

  // ════════════════════════════════════════════════════════════════════
  //  HIGHLIGHTING
  // ════════════════════════════════════════════════════════════════════

  function clearHighlights() {
    document.querySelectorAll(".leh-tier1, .leh-tier2").forEach((el) => el.classList.remove("leh-tier1", "leh-tier2"));
    document.querySelectorAll(".leh-score-badge").forEach((el) => el.remove());
  }

  function applyHighlights(scored) {
    if (!scored.length) return;
    if (mode === "percentile") {
      const sorted = [...scored].sort((a, b) => b.score - a.score);
      const t10 = sorted[Math.max(0, Math.ceil(sorted.length * 0.1) - 1)]?.score ?? Infinity;
      const tMed = sorted[Math.floor(sorted.length / 2)]?.score ?? 0;
      for (const it of scored) {
        it.element.classList.remove("leh-tier1", "leh-tier2");
        if (it.score >= t10 && it.score > 0) it.element.classList.add("leh-tier1");
        else if (it.score >= tMed && it.score > 0) it.element.classList.add("leh-tier2");
        if (showScores) addScoreBadge(it, scored);
      }
    } else {
      for (const it of scored) {
        it.element.classList.remove("leh-tier1", "leh-tier2");
        if (it.score >= absoluteThreshold * 2) it.element.classList.add("leh-tier1");
        else if (it.score >= absoluteThreshold) it.element.classList.add("leh-tier2");
        if (showScores) addScoreBadge(it, scored);
      }
    }
  }

  function getScoreColor(item, all) {
    if (item.score === 0) return "gray";
    const rank = all.filter((s) => s.score > item.score).length;
    const pct = rank / all.length;
    if (pct < 0.1) return "gold";
    if (pct < 0.3) return "green";
    if (pct < 0.6) return "blue";
    return "gray";
  }

  function addScoreBadge(item, all) {
    const old = item.element.querySelector(".leh-score-badge");
    if (old) old.remove();
    if (!showScores) return;

    const badge = document.createElement("div");
    badge.className = "leh-score-badge leh-color-" + getScoreColor(item, all);

    const parts = [];
    if (item.engagement.reactions > 0) parts.push("\ud83d\udc4d " + formatCount(item.engagement.reactions));
    if (item.engagement.comments > 0) parts.push("\ud83d\udcac " + formatCount(item.engagement.comments));
    if (item.engagement.reposts > 0) parts.push("\ud83d\udd01 " + formatCount(item.engagement.reposts));

    badge.innerHTML =
      '<span class="leh-badge-score">' + item.score.toLocaleString() +
      '</span><span class="leh-badge-detail">' + (parts.join("  ") || "no data") + "</span>";

    if (window.getComputedStyle(item.element).position === "static")
      item.element.style.position = "relative";
    item.element.appendChild(badge);
  }

  // ════════════════════════════════════════════════════════════════════
  //  DATE FILTERING
  // ════════════════════════════════════════════════════════════════════

  function isInDateRange(date) {
    if (dateFilter === "all" || !date) return true;
    const now = Date.now();
    const ranges = { "24h": 864e5, "7d": 6048e5, "30d": 2592e6, "90d": 7776e6 };
    if (ranges[dateFilter]) return date.getTime() >= now - ranges[dateFilter];
    if (dateFilter === "custom") {
      if (customDateFrom && date < new Date(customDateFrom)) return false;
      if (customDateTo && date > new Date(customDateTo + "T23:59:59")) return false;
    }
    return true;
  }

  // ════════════════════════════════════════════════════════════════════
  //  MAIN PROCESSING
  // ════════════════════════════════════════════════════════════════════

  function processAllPosts(forceRefresh) {
    if (!enabled) { clearHighlights(); return; }

    const posts = findAllPosts();
    let hasNew = false;
    const allScored = [];

    for (const pi of posts) {
      const cached = !forceRefresh && scoredCache.get(pi.element);
      if (cached) { allScored.push(cached); continue; }
      hasNew = true;
      const eng = extractEngagement(pi);
      const entry = {
        element: pi.element,
        type: pi.type,
        score: calculateScore(eng),
        engagement: eng,
        date: extractPostDate(pi.element),
      };
      scoredCache.set(pi.element, entry);
      allScored.push(entry);
    }

    if (!hasNew && !forceRefresh && lastScoredPosts.length === allScored.length) return;

    const filtered = allScored.filter((it) => isInDateRange(it.date));

    for (const it of allScored) {
      if (!filtered.includes(it)) {
        it.element.classList.remove("leh-tier1", "leh-tier2");
        const b = it.element.querySelector(".leh-score-badge");
        if (b) b.remove();
        it.element.style.opacity = dateFilter === "all" ? "" : "0.4";
      } else {
        it.element.style.opacity = "";
      }
    }

    lastScoredPosts = allScored;
    clearHighlights();
    applyHighlights(filtered);
    updateFilteredCount(filtered.length, allScored.length);
  }

  function updateFilteredCount(shown, total) {
    const el = document.getElementById("leh-filter-count");
    if (!el) return;
    if (dateFilter === "all") { el.textContent = ""; el.style.display = "none"; }
    else { el.textContent = shown + " of " + total + " posts match filter"; el.style.display = "block"; }
  }

  function debouncedProcess() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processAllPosts, DEBOUNCE_MS);
  }

  // ════════════════════════════════════════════════════════════════════
  //  MUTATION OBSERVER
  // ════════════════════════════════════════════════════════════════════

  function setupObserver() {
    const target = getMainArea();
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.addedNodes.length) { debouncedProcess(); return; }
      }
    });
    obs.observe(target, { childList: true, subtree: true });
    return obs;
  }

  // ════════════════════════════════════════════════════════════════════
  //  SPA NAVIGATION
  // ════════════════════════════════════════════════════════════════════

  let lastUrl = location.href;

  function setupNavigationListener() {
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(() => {
          processAllPosts(true);
          updateExtractCount();
          updatePageIndicator();
        }, 1500);
      }
    }, 500);
  }

  // ════════════════════════════════════════════════════════════════════
  //  AUTO-SCROLL
  // ════════════════════════════════════════════════════════════════════

  function startAutoScroll() {
    if (autoScrollRafId) return;
    lastScrollTime = performance.now();
    showMoreHandled = false;

    function step(now) {
      if (!autoScrollEnabled) { autoScrollRafId = null; return; }
      const dt = now - lastScrollTime;
      lastScrollTime = now;
      const px = (SCROLL_SPEEDS[Math.min(autoScrollSpeed - 1, 5)] * dt) / 1000;
      window.scrollBy({ top: px * (1 + Math.sin(now / 800) * 0.15), behavior: "instant" });
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 150 && !showMoreHandled) handleShowMore();
      autoScrollRafId = requestAnimationFrame(step);
    }

    autoScrollRafId = requestAnimationFrame(step);
    showMorePollId = setInterval(() => {
      if (!autoScrollEnabled) return;
      const btn = findShowMoreButton();
      if (btn && !showMoreHandled) handleShowMore();
    }, 3000);
  }

  function stopAutoScroll() {
    if (autoScrollRafId) { cancelAnimationFrame(autoScrollRafId); autoScrollRafId = null; }
    if (showMorePollId) { clearInterval(showMorePollId); showMorePollId = null; }
  }

  function findShowMoreButton() {
    for (const el of document.querySelectorAll('button, a[role="button"]')) {
      const t = (el.textContent || "").trim().toLowerCase();
      if (t.includes("show more") || t.includes("load more") || t.includes("see more activity") || t.includes("show more results"))
        return el;
    }
    return null;
  }

  function handleShowMore() {
    const btn = findShowMoreButton();
    if (!btn || showMoreHandled) return;
    showMoreHandled = true;
    btn.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      if (!autoScrollEnabled) return;
      btn.click();
      setTimeout(() => { showMoreHandled = false; }, 2000);
    }, 1200);
  }

  // ════════════════════════════════════════════════════════════════════
  //  CONTROL PANEL
  // ════════════════════════════════════════════════════════════════════

  function createControlPanel() {
    if (document.getElementById("leh-panel")) return;
    const panel = document.createElement("div");
    panel.id = "leh-panel";
    panel.innerHTML = `
      <div class="leh-panel-header">
        <div class="leh-header-left">
          <svg class="leh-logo" width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" fill="currentColor"/>
          </svg>
          <span class="leh-panel-title">Engagement Highlighter</span>
          <span class="leh-version">v3.3</span>
        </div>
        <button class="leh-panel-collapse" title="Minimize">\u2212</button>
      </div>
      <div class="leh-panel-body">
        <div id="leh-page-type" class="leh-page-indicator">Feed</div>

        <!-- Highlighter -->
        <div class="leh-section">
          <div class="leh-section-header" data-section="highlighter">
            <span>Highlighter</span><span class="leh-chevron">\u25BE</span>
          </div>
          <div class="leh-section-body">
            <div class="leh-control-row"><span class="leh-label-text">Highlight posts</span><label class="leh-toggle"><input type="checkbox" id="leh-enabled" checked /><span class="leh-toggle-slider"></span></label></div>
            <div class="leh-control-row"><span class="leh-label-text">Score badges</span><label class="leh-toggle"><input type="checkbox" id="leh-show-scores" checked /><span class="leh-toggle-slider"></span></label></div>
            <div class="leh-control-row"><span class="leh-label-text">Mode</span><select id="leh-mode" class="leh-select"><option value="percentile">Percentile (auto)</option><option value="threshold">Fixed threshold</option></select></div>
            <div class="leh-control-row leh-threshold-row" style="display:none;"><span class="leh-label-text">Threshold</span><input type="range" id="leh-threshold" min="10" max="5000" value="100" step="10" class="leh-range" /><span id="leh-threshold-val" class="leh-range-val">100</span></div>
          </div>
        </div>

        <!-- Weights -->
        <div class="leh-section">
          <div class="leh-section-header" data-section="weights">
            <span>Score Weights</span><span class="leh-chevron">\u25BE</span>
          </div>
          <div class="leh-section-body">
            <div class="leh-help-text">Higher = counts more toward score</div>
            <div class="leh-control-row"><span class="leh-label-text">\ud83d\udc4d Reactions</span><input type="number" id="leh-w-reactions" value="5" min="0" max="20" class="leh-num-input" /></div>
            <div class="leh-control-row"><span class="leh-label-text">\ud83d\udcac Comments</span><input type="number" id="leh-w-comments" value="10" min="0" max="20" class="leh-num-input" /></div>
            <div class="leh-control-row"><span class="leh-label-text">\ud83d\udd01 Reposts</span><input type="number" id="leh-w-reposts" value="2" min="0" max="20" class="leh-num-input" /></div>
            <button id="leh-recalculate" class="leh-btn leh-btn-secondary">Recalculate</button>
          </div>
        </div>

        <!-- Date Filter -->
        <div class="leh-section">
          <div class="leh-section-header" data-section="datefilter">
            <span>Date Filter</span><span class="leh-chevron">\u25BE</span>
          </div>
          <div class="leh-section-body">
            <div class="leh-help-text">Filter posts by when they were published</div>
            <select id="leh-date-filter" class="leh-select leh-select-full">
              <option value="all">All time</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
              <option value="custom">Custom range</option>
            </select>
            <div id="leh-date-custom" class="leh-date-custom" style="display:none;">
              <div class="leh-control-row"><span class="leh-label-text">From</span><input type="date" id="leh-date-from" class="leh-date-input" /></div>
              <div class="leh-control-row"><span class="leh-label-text">To</span><input type="date" id="leh-date-to" class="leh-date-input" /></div>
            </div>
            <div id="leh-filter-count" class="leh-filter-count" style="display:none;"></div>
          </div>
        </div>

        <!-- Auto-scroll -->
        <div class="leh-section">
          <div class="leh-section-header" data-section="autoscroll">
            <span>Auto-scroll</span><span class="leh-chevron">\u25BE</span>
          </div>
          <div class="leh-section-body">
            <div class="leh-control-row"><span class="leh-label-text">Enable</span><label class="leh-toggle"><input type="checkbox" id="leh-autoscroll" /><span class="leh-toggle-slider"></span></label></div>
            <div class="leh-control-row"><span class="leh-label-text">Speed</span><input type="range" id="leh-scroll-speed" min="1" max="6" value="3" class="leh-range" /><span id="leh-scroll-speed-val" class="leh-range-val">3</span></div>
            <div class="leh-help-text">Smooth scroll with auto-pause on "Show more" prompts.</div>
          </div>
        </div>

        <!-- Extract & Export -->
        <div class="leh-section">
          <div class="leh-section-header" data-section="extract">
            <span>Extract &amp; Export</span><span class="leh-chevron">\u25BE</span>
          </div>
          <div class="leh-section-body">
            <div class="leh-control-row"><span class="leh-label-text">Show top</span><select id="leh-export-count" class="leh-select"><option value="5">5</option><option value="10" selected>10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="150">150</option><option value="all">All</option></select></div>
            <button id="leh-extract" class="leh-btn leh-btn-primary">Extract Top Posts</button>
            <button id="leh-bulk-copy" class="leh-btn leh-btn-caption">Copy All Captions</button>
            <div id="leh-extract-count" class="leh-help-text"></div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    wireUpPanelEvents(panel);
    updatePageIndicator();
    updateExtractCount();
  }

  function wireUpPanelEvents(panel) {
    // Collapse
    let collapsed = false;
    const collapseBtn = panel.querySelector(".leh-panel-collapse");
    const body = panel.querySelector(".leh-panel-body");
    collapseBtn.addEventListener("click", () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? "none" : "block";
      collapseBtn.textContent = collapsed ? "+" : "\u2212";
      panel.classList.toggle("leh-collapsed", collapsed);
    });

    // Section collapse
    for (const hdr of panel.querySelectorAll(".leh-section-header")) {
      hdr.addEventListener("click", () => {
        const sbody = hdr.nextElementSibling;
        const chev = hdr.querySelector(".leh-chevron");
        const open = sbody.style.display !== "none";
        sbody.style.display = open ? "none" : "block";
        chev.textContent = open ? "\u25B8" : "\u25BE";
        hdr.classList.toggle("leh-section-closed", open);
      });
    }

    // Drag
    let dragging = false, dx = 0, dy = 0;
    const header = panel.querySelector(".leh-panel-header");
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest(".leh-panel-collapse")) return;
      dragging = true;
      dx = e.clientX - panel.getBoundingClientRect().left;
      dy = e.clientY - panel.getBoundingClientRect().top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.right = "auto";
      panel.style.left = (e.clientX - dx) + "px";
      panel.style.top = (e.clientY - dy) + "px";
    });
    document.addEventListener("mouseup", () => { dragging = false; });

    // Controls
    const $ = (id) => document.getElementById(id);

    $("leh-enabled").addEventListener("change", (e) => { enabled = e.target.checked; processAllPosts(); saveSettings(); });
    $("leh-show-scores").addEventListener("change", (e) => { showScores = e.target.checked; processAllPosts(); saveSettings(); });
    $("leh-mode").addEventListener("change", (e) => {
      mode = e.target.value;
      panel.querySelector(".leh-threshold-row").style.display = mode === "threshold" ? "flex" : "none";
      processAllPosts(true); saveSettings();
    });
    $("leh-threshold").addEventListener("input", (e) => { absoluteThreshold = +e.target.value; $("leh-threshold-val").textContent = absoluteThreshold; saveSettings(); });
    $("leh-threshold").addEventListener("change", () => processAllPosts(true));

    $("leh-w-reactions").addEventListener("change", (e) => { weights.reactions = +e.target.value || 0; processAllPosts(true); saveSettings(); });
    $("leh-w-comments").addEventListener("change", (e) => { weights.comments = +e.target.value || 0; processAllPosts(true); saveSettings(); });
    $("leh-w-reposts").addEventListener("change", (e) => { weights.reposts = +e.target.value || 0; processAllPosts(true); saveSettings(); });
    $("leh-recalculate").addEventListener("click", () => processAllPosts(true));

    $("leh-date-filter").addEventListener("change", (e) => {
      dateFilter = e.target.value;
      $("leh-date-custom").style.display = dateFilter === "custom" ? "block" : "none";
      processAllPosts(true); saveSettings();
    });
    $("leh-date-from").addEventListener("change", (e) => { customDateFrom = e.target.value; processAllPosts(true); saveSettings(); });
    $("leh-date-to").addEventListener("change", (e) => { customDateTo = e.target.value; processAllPosts(true); saveSettings(); });

    $("leh-autoscroll").addEventListener("change", (e) => {
      autoScrollEnabled = e.target.checked;
      autoScrollEnabled ? startAutoScroll() : stopAutoScroll();
      saveSettings();
    });
    $("leh-scroll-speed").addEventListener("input", (e) => { autoScrollSpeed = +e.target.value; $("leh-scroll-speed-val").textContent = autoScrollSpeed; saveSettings(); });

    $("leh-extract").addEventListener("click", extractTopPosts);
    $("leh-bulk-copy").addEventListener("click", bulkCopyCaptions);
  }

  // ════════════════════════════════════════════════════════════════════
  //  PAGE INDICATOR & EXTRACT COUNT
  // ════════════════════════════════════════════════════════════════════

  function updatePageIndicator() {
    const el = document.getElementById("leh-page-type");
    if (!el) return;
    const labels = { feed: "Feed", activity: "Activity", company: "Company", search: "Search", profile: "Profile", post: "Post" };
    el.textContent = labels[getPageType()] || getPageType();
  }

  function updateExtractCount() {
    const el = document.getElementById("leh-extract-count");
    if (!el) return;
    const n = findAllPosts().length;
    const ctx = { feed: "in feed", activity: "on activity", company: "on company", search: "in results" }[getPageType()] || "in feed";
    el.textContent = n + " post" + (n !== 1 ? "s" : "") + " detected " + ctx;
  }

  // ════════════════════════════════════════════════════════════════════
  //  V3.3 — BULK COPY CAPTIONS (one-click, from control panel)
  // ════════════════════════════════════════════════════════════════════

  /**
   * Expands all "see more" buttons, extracts full captions from every
   * detected post, and copies them to clipboard organized by author.
   */
  async function bulkCopyCaptions() {
    const btn = document.getElementById("leh-bulk-copy");
    if (btn) { btn.textContent = "Expanding posts..."; btn.disabled = true; }

    // Step 1: auto-expand all "see more" to reveal full text
    await expandAllSeeMore();

    if (btn) btn.textContent = "Extracting...";

    // Step 2: extract all posts
    const posts = findAllPosts();
    const results = [];

    for (const pi of posts) {
      const meta = extractPostMeta(pi);
      const eng = extractEngagement(pi);
      const score = calculateScore(eng);
      if (!isInDateRange(meta.date)) continue;
      results.push({ ...meta, reactions: eng.reactions, comments: eng.comments, reposts: eng.reposts, score });
    }

    // Sort by score (highest first)
    results.sort((a, b) => b.score - a.score);

    if (results.length === 0) {
      if (btn) {
        btn.textContent = "No posts found";
        btn.disabled = false;
        setTimeout(() => { btn.textContent = "Copy All Captions"; }, 2000);
      }
      return;
    }

    // Step 3: build clipboard text — clean, post-by-post format
    const lines = results.map((p, i) => {
      const author = p.username || "Unknown";
      const dateStr = p.date
        ? p.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "Unknown date";
      const captionText = p.fullCaption || p.caption || "(no text)";
      const engLine = [
        p.reactions > 0 ? formatCount(p.reactions) + " reactions" : "",
        p.comments > 0 ? formatCount(p.comments) + " comments" : "",
        p.reposts > 0 ? formatCount(p.reposts) + " reposts" : "",
      ].filter(Boolean).join(", ");

      return "--- Post " + (i + 1) + " ---\n" +
        "Author: " + author + "\n" +
        "Date: " + dateStr + "\n" +
        "Engagement: " + (engLine || "none") + " (Score: " + p.score.toLocaleString() + ")\n" +
        "Media: " + (p.mediaType || "text") + "\n" +
        (p.postUrl ? "URL: " + p.postUrl + "\n" : "") +
        "\n" + captionText;
    });

    const output = "Bulk Post Captions (" + results.length + " posts)\n" +
      "Exported: " + new Date().toLocaleString() + "\n" +
      "Page: " + window.location.href + "\n" +
      "=".repeat(60) + "\n\n" +
      lines.join("\n\n" + "=".repeat(60) + "\n\n");

    try {
      await navigator.clipboard.writeText(output);
      if (btn) {
        btn.textContent = "Copied " + results.length + " posts!";
        btn.classList.add("leh-btn-flash");
        setTimeout(() => {
          btn.textContent = "Copy All Captions";
          btn.classList.remove("leh-btn-flash");
          btn.disabled = false;
        }, 2500);
      }
    } catch {
      // Fallback: show in a temporary textarea for manual copy
      if (btn) {
        btn.textContent = "Copy failed - see modal";
        btn.disabled = false;
        setTimeout(() => { btn.textContent = "Copy All Captions"; }, 2000);
      }
      showCaptionFallbackModal(output);
    }
  }

  /**
   * If clipboard API fails (e.g. permissions), show a modal with the text
   * in a selectable textarea.
   */
  function showCaptionFallbackModal(text) {
    const existing = document.getElementById("leh-caption-fallback");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "leh-caption-fallback";
    overlay.className = "leh-modal-overlay";
    overlay.innerHTML =
      '<div class="leh-modal" style="max-width:700px;">' +
      '<div class="leh-modal-header">' +
      '<span class="leh-modal-title">Copied Captions (select all & copy)</span>' +
      '<button class="leh-modal-close" title="Close">&times;</button>' +
      "</div>" +
      '<div style="padding:16px;">' +
      '<textarea style="width:100%;height:400px;font-family:monospace;font-size:12px;padding:10px;border:1px solid #ddd;border-radius:8px;resize:vertical;" readonly></textarea>' +
      "</div></div>";
    document.body.appendChild(overlay);

    const textarea = overlay.querySelector("textarea");
    textarea.value = text;
    textarea.select();

    overlay.querySelector(".leh-modal-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // ════════════════════════════════════════════════════════════════════
  //  EXTRACT & EXPORT  (V3.3 — full captions, copy captions button)
  // ════════════════════════════════════════════════════════════════════

  async function extractTopPosts() {
    const extractBtn = document.getElementById("leh-extract");
    if (extractBtn) { extractBtn.textContent = "Expanding..."; extractBtn.disabled = true; }

    // V3.3: auto-expand "see more" before extraction
    await expandAllSeeMore();

    if (extractBtn) { extractBtn.textContent = "Extracting..."; }

    const posts = findAllPosts();
    const scored = [];

    for (const pi of posts) {
      const eng = extractEngagement(pi);
      const score = calculateScore(eng);
      const meta = extractPostMeta(pi);
      if (!isInDateRange(meta.date)) continue;
      scored.push({ ...meta, reactions: eng.reactions, comments: eng.comments, reposts: eng.reposts, score });
    }

    scored.sort((a, b) => b.score - a.score);

    const countVal = (document.getElementById("leh-export-count") || {}).value || "10";
    const limit = countVal === "all" ? scored.length : parseInt(countVal, 10);
    const top = scored.slice(0, limit);

    if (extractBtn) {
      extractBtn.textContent = "Extract Top Posts";
      extractBtn.disabled = false;
    }

    updateExtractCount();
    showExportModal(top, scored.length);
  }

  /**
   * V3.3 export modal: full captions, "Copy All Captions" button in modal.
   */
  function showExportModal(posts, totalScored) {
    const existing = document.getElementById("leh-export-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "leh-export-modal";
    overlay.className = "leh-modal-overlay";

    const mediaBadge = (type) => {
      const colors = { image: "#3b82f6", video: "#ef4444", document: "#f59e0b", carousel: "#8b5cf6", article: "#06b6d4", text: "#6b7280" };
      const labels = { image: "IMG", video: "VID", document: "DOC", carousel: "MULTI", article: "LINK", text: "TEXT" };
      return '<span style="background:' + (colors[type] || "#6b7280") + ';color:#fff;padding:2px 6px;border-radius:4px;font-size:9px;font-weight:700;letter-spacing:.04em;">' + (labels[type] || "TEXT") + "</span>";
    };

    let rows = "";
    posts.forEach((p, i) => {
      const esc = (s) => (s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const author = esc(p.username) || "Unknown";
      const dateStr = p.date
        ? p.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "\u2014";

      // V3.3: show full caption in modal, not just hook
      const captionDisplay = p.fullCaption
        ? '<span class="leh-modal-hook">' + esc(p.fullCaption).replace(/\n/g, "<br>") + "</span>"
        : '<span class="leh-modal-hook leh-hook-empty">No text</span>';

      const link = p.postUrl
        ? '<a href="' + p.postUrl + '" target="_blank" rel="noopener noreferrer" class="leh-modal-link">View</a>'
        : "\u2014";

      rows +=
        "<tr>" +
        '<td class="leh-modal-rank">' + (i + 1) + "</td>" +
        '<td class="leh-modal-user">' + author + "</td>" +
        '<td class="leh-modal-date">' + dateStr + "</td>" +
        '<td class="leh-modal-metrics">' + formatCount(p.reactions) + "</td>" +
        '<td class="leh-modal-metrics">' + formatCount(p.comments) + "</td>" +
        '<td class="leh-modal-metrics">' + formatCount(p.reposts) + "</td>" +
        '<td class="leh-modal-score">' + p.score.toLocaleString() + "</td>" +
        '<td class="leh-modal-media">' + mediaBadge(p.mediaType) + "</td>" +
        '<td class="leh-modal-link-cell">' + link + "</td>" +
        "</tr>" +
        '<tr class="leh-hook-row"><td></td><td colspan="8">' + captionDisplay + "</td></tr>";
    });

    const pageLabel = getPageType() === "activity" ? "Activity" : getPageType() === "company" ? "Company" : "Feed";

    overlay.innerHTML =
      '<div class="leh-modal">' +
      '<div class="leh-modal-header">' +
      '<span class="leh-modal-title">Top ' + posts.length + " Posts from " + pageLabel + " (" + totalScored + " scored)</span>" +
      '<button class="leh-modal-close" title="Close">&times;</button>' +
      "</div>" +
      '<div class="leh-modal-actions">' +
      '<button id="leh-copy-text" class="leh-btn leh-btn-sm">Copy Text</button>' +
      '<button id="leh-copy-json" class="leh-btn leh-btn-sm">Copy JSON</button>' +
      '<button id="leh-download-csv" class="leh-btn leh-btn-sm">Download CSV</button>' +
      '<button id="leh-modal-copy-captions" class="leh-btn leh-btn-sm leh-btn-caption-sm">Copy All Captions</button>' +
      "</div>" +
      '<div class="leh-modal-body">' +
      (posts.length === 0
        ? '<div class="leh-modal-empty">No posts found. Try scrolling through the feed first to load more posts.</div>'
        : '<table class="leh-modal-table"><thead><tr>' +
          "<th>#</th><th>Author</th><th>Date</th><th>Reacts</th><th>Cmts</th><th>Reposts</th><th>Score</th><th>Media</th><th>Link</th>" +
          "</tr></thead><tbody>" + rows + "</tbody></table>") +
      "</div></div>";

    document.body.appendChild(overlay);

    // Close
    overlay.querySelector(".leh-modal-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    // ── Copy Text ──
    document.getElementById("leh-copy-text").addEventListener("click", () => {
      const lines = posts.map((p, i) => {
        const parts = [];
        if (p.reactions > 0) parts.push(formatCount(p.reactions) + " reactions");
        if (p.comments > 0) parts.push(formatCount(p.comments) + " comments");
        if (p.reposts > 0) parts.push(formatCount(p.reposts) + " reposts");
        const dateStr = p.date ? p.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Unknown date";
        const author = p.username || "Unknown";
        let line = (i + 1) + ". " + author + "\n   Date: " + dateStr + " | Media: " + (p.mediaType || "text") + " | Score: " + p.score.toLocaleString() + " (" + parts.join(", ") + ")";
        if (p.hook) line += '\n   Hook: "' + p.hook.replace(/\n/g, " / ") + '"';
        if (p.postUrl) line += "\n   " + p.postUrl;
        return line;
      });
      const text = "Top " + posts.length + " Posts by " + (posts[0]?.username || "Authors") + "\n" + "=".repeat(50) + "\n\n" + lines.join("\n\n");
      navigator.clipboard.writeText(text).then(() => flashButton("leh-copy-text", "Copied!"));
    });

    // ── Copy JSON ── (V3.3: includes fullCaption)
    document.getElementById("leh-copy-json").addEventListener("click", () => {
      const data = posts.map((p, i) => ({
        rank: i + 1,
        author: p.username || null,
        date: p.date ? p.date.toISOString() : null,
        hook: p.hook || null,
        fullCaption: p.fullCaption || null,
        mediaType: p.mediaType || "text",
        postUrl: p.postUrl || null,
        reactions: p.reactions,
        comments: p.comments,
        reposts: p.reposts,
        score: p.score,
      }));
      navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => flashButton("leh-copy-json", "Copied!"));
    });

    // ── Download CSV ── (V3.3: includes full caption)
    document.getElementById("leh-download-csv").addEventListener("click", () => {
      const esc = (v) => { const s = String(v ?? ""); return s.includes(",") || s.includes('"') || s.includes("\n") ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const hdr = "Rank,Author,Date,Reactions,Comments,Reposts,Score,Hook,Full Caption,Media Type,Post URL";
      const csvRows = posts.map((p, i) => [
        i + 1,
        esc(p.username || ""),
        p.date ? p.date.toISOString().slice(0, 10) : "",
        p.reactions, p.comments, p.reposts, p.score,
        esc(p.hook || ""),
        esc(p.fullCaption || ""),
        esc(p.mediaType || "text"),
        esc(p.postUrl || ""),
      ].join(","));
      const csv = hdr + "\n" + csvRows.join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "linkedin-top-posts-" + new Date().toISOString().slice(0, 10) + ".csv";
      a.click();
      URL.revokeObjectURL(url);
      flashButton("leh-download-csv", "Downloaded!");
    });

    // ── Copy All Captions (modal button) ──
    document.getElementById("leh-modal-copy-captions").addEventListener("click", () => {
      const captionLines = posts.map((p, i) => {
        const author = p.username || "Unknown";
        const dateStr = p.date
          ? p.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
          : "Unknown date";
        const captionText = p.fullCaption || p.caption || "(no text)";
        const engLine = [
          p.reactions > 0 ? formatCount(p.reactions) + " reactions" : "",
          p.comments > 0 ? formatCount(p.comments) + " comments" : "",
          p.reposts > 0 ? formatCount(p.reposts) + " reposts" : "",
        ].filter(Boolean).join(", ");

        return "--- Post " + (i + 1) + " ---\n" +
          "Author: " + author + "\n" +
          "Date: " + dateStr + "\n" +
          "Engagement: " + (engLine || "none") + " (Score: " + p.score.toLocaleString() + ")\n" +
          "Media: " + (p.mediaType || "text") + "\n" +
          (p.postUrl ? "URL: " + p.postUrl + "\n" : "") +
          "\n" + captionText;
      });

      const output = "Bulk Post Captions (" + posts.length + " posts)\n" +
        "Exported: " + new Date().toLocaleString() + "\n" +
        "Page: " + window.location.href + "\n" +
        "=".repeat(60) + "\n\n" +
        captionLines.join("\n\n" + "=".repeat(60) + "\n\n");

      navigator.clipboard.writeText(output).then(() => flashButton("leh-modal-copy-captions", "Copied!"));
    });
  }

  function flashButton(id, text) {
    const btn = document.getElementById(id);
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = text;
    btn.classList.add("leh-btn-flash");
    setTimeout(() => { btn.textContent = orig; btn.classList.remove("leh-btn-flash"); }, 1500);
  }

  // ════════════════════════════════════════════════════════════════════
  //  SETTINGS PERSISTENCE
  // ════════════════════════════════════════════════════════════════════

  function saveSettings() {
    try {
      chrome.storage.local.set({
        lehSettingsV33: { enabled, showScores, mode, absoluteThreshold, weights, autoScrollSpeed, dateFilter, customDateFrom, customDateTo },
      });
    } catch { /* storage unavailable */ }
  }

  function loadSettings() {
    try {
      chrome.storage.local.get("lehSettingsV33", (res) => {
        if (!res?.lehSettingsV33) {
          // Migrate from V3.2 settings if available
          chrome.storage.local.get("lehSettingsV32", (res2) => {
            if (res2?.lehSettingsV32) applySettings(res2.lehSettingsV32);
          });
          return;
        }
        applySettings(res.lehSettingsV33);
      });
    } catch { /* storage unavailable */ }
  }

  function applySettings(s) {
    enabled = s.enabled ?? true;
    showScores = s.showScores ?? true;
    mode = s.mode ?? "percentile";
    absoluteThreshold = s.absoluteThreshold ?? 100;
    weights = s.weights ?? { reactions: 5, comments: 10, reposts: 2 };
    autoScrollSpeed = s.autoScrollSpeed ?? 3;
    dateFilter = s.dateFilter ?? "all";
    customDateFrom = s.customDateFrom ?? "";
    customDateTo = s.customDateTo ?? "";

    const $ = (id) => document.getElementById(id);
    const el = $("leh-enabled"); if (el) el.checked = enabled;
    const ss = $("leh-show-scores"); if (ss) ss.checked = showScores;
    const md = $("leh-mode"); if (md) md.value = mode;
    const th = $("leh-threshold"); if (th) th.value = absoluteThreshold;
    const tv = $("leh-threshold-val"); if (tv) tv.textContent = absoluteThreshold;
    const wr = $("leh-w-reactions"); if (wr) wr.value = weights.reactions;
    const wc = $("leh-w-comments"); if (wc) wc.value = weights.comments;
    const wp = $("leh-w-reposts"); if (wp) wp.value = weights.reposts;
    const tr = document.querySelector(".leh-threshold-row"); if (tr) tr.style.display = mode === "threshold" ? "flex" : "none";
    const sp = $("leh-scroll-speed"); if (sp) sp.value = autoScrollSpeed;
    const sv = $("leh-scroll-speed-val"); if (sv) sv.textContent = autoScrollSpeed;
    const df = $("leh-date-filter"); if (df) df.value = dateFilter;
    const dfrom = $("leh-date-from"); if (dfrom) dfrom.value = customDateFrom;
    const dto = $("leh-date-to"); if (dto) dto.value = customDateTo;
    const dc = $("leh-date-custom"); if (dc) dc.style.display = dateFilter === "custom" ? "block" : "none";

    processAllPosts();
  }

  // ════════════════════════════════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════════════════════════════════

  function init() {
    createControlPanel();
    loadSettings();
    setupObserver();
    setupNavigationListener();

    setTimeout(processAllPosts, 800);
    setTimeout(() => { processAllPosts(); updateExtractCount(); }, 2500);
    setTimeout(() => { processAllPosts(true); updateExtractCount(); }, 5000);

    let scrollTimer = null;
    window.addEventListener("scroll", () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => { processAllPosts(); updateExtractCount(); }, 200);
    }, { passive: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
