/**
 * LinkedIn Engagement Highlighter V4.0 - Content Script
 *
 * V4.0 — Complete rewrite:
 * - Sidebar UI (replaces floating panel) — pushes LinkedIn content left
 * - Persistent data store (survives DOM recycling from virtual scroll)
 * - Search posts by keyword
 * - Filter by media type (text, image, video, document, carousel, article)
 * - Bidirectional auto-scroll (up / down / pause)
 * - Fixed engagement display: shows individual metrics, not bloated score
 * - Live refresh: MutationObserver + periodic re-scan
 * - Export from data store (no more "no data" bug)
 * - Post bookmarks, quick-copy, engagement trends, keyboard shortcuts
 *
 * Works on Feed, Activity, Company, Search, and Profile pages.
 * No network requests. No data collection. Fully client-side.
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

  // Date filter
  let dateFilter = "all";
  let customDateFrom = "";
  let customDateTo = "";

  // Media filter (set of active types, empty = all)
  let mediaFilterActive = new Set();

  // Search
  let searchQuery = "";
  let searchDebounceTimer = null;

  // Auto-scroll
  let autoScrollEnabled = false;
  let autoScrollRafId = null;
  let autoScrollSpeed = 3;
  let autoScrollDirection = "down"; // "down" | "up" | "paused"
  let lastScrollTime = 0;
  let showMoreHandled = false;
  let showMorePollId = null;
  const SCROLL_SPEEDS = [300, 600, 1200, 2200, 3500, 5500];

  // Sidebar
  let sidebarOpen = true;

  // Session
  const sessionStart = Date.now();

  // ─── PERSISTENT DATA STORE ─────────────────────────────────────────
  // Key: post URN or generated ID. Survives DOM recycling.
  const postStore = new Map();
  const MAX_STORE_SIZE = 500;

  function getPostKey(el) {
    const urn = el.getAttribute("data-urn") || el.getAttribute("data-id") || "";
    if (urn && urn.includes("urn:li:")) return urn;
    // Generate stable key from content hash
    const text = (el.textContent || "").substring(0, 200).trim();
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return "leh-gen-" + hash;
  }

  // ─── Page Type ─────────────────────────────────────────────────────
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

  // ─── Number Helpers ────────────────────────────────────────────────
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
  //  POST DETECTION (multi-strategy)
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

    // Strategy 1: Known LinkedIn class
    main.querySelectorAll(".feed-shared-update-v2").forEach((el) => found.add(el));

    // Strategy 2: data-urn for activity / ugcPost
    main
      .querySelectorAll('div[data-urn*="urn:li:activity"], div[data-urn*="urn:li:ugcPost"]')
      .forEach((el) => found.add(el));

    // Strategy 3: Occludable wrappers (virtual scroll)
    main.querySelectorAll(".occludable-update").forEach((wrapper) => {
      const inner = wrapper.querySelector(".feed-shared-update-v2");
      found.add(inner || wrapper);
    });

    // Strategy 4: Walk up from social-counts containers
    main
      .querySelectorAll('.social-details-social-counts, [class*="social-counts"]')
      .forEach((countEl) => {
        const post = walkUpToPost(countEl, main);
        if (post) found.add(post);
      });

    // Strategy 5: Walk up from social-action bars
    main
      .querySelectorAll(
        '.feed-shared-social-actions, .social-details-social-activity, [class*="social-action"]'
      )
      .forEach((bar) => {
        const post = walkUpToPost(bar, main);
        if (post) found.add(post);
      });

    // Strategy 6: action-button anchor
    main.querySelectorAll("button").forEach((btn) => {
      const label = (btn.textContent || "").trim();
      if (label === "Like" || label === "Support" || label === "Celebrate" ||
          label === "Love" || label === "Insightful" || label === "Funny") {
        const post = walkUpToPost(btn, main, 10);
        if (post) found.add(post);
      }
    });

    // Strategy 7: text-pattern anchor
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

    // Pass 1: social-counts container
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

    // Pass 2: aria-label scan on buttons
    if (reactions === 0 && comments === 0 && reposts === 0) {
      for (const btn of post.querySelectorAll("button[aria-label]")) {
        const lbl = (btn.getAttribute("aria-label") || "").toLowerCase();
        const num = (txt) => {
          const m = txt.match(/([\d,.]+[KMB]?)/i);
          return m ? parseCount(m[1].replace(/,/g, "")) : 0;
        };
        if ((lbl.includes("reaction") || lbl.includes("like")) && !lbl.includes("unlike"))
          reactions = Math.max(reactions, num(lbl));
        if (lbl.includes("comment"))
          comments = Math.max(comments, num(lbl));
        if (lbl.includes("repost") || lbl.includes("share"))
          reposts = Math.max(reposts, num(lbl));
      }
    }

    // Pass 3: broad text-pattern scan
    if (reactions === 0 && comments === 0 && reposts === 0) {
      for (const node of post.querySelectorAll("span, button, a")) {
        if (node.children.length > 5) continue;
        const t = (node.textContent || "").trim();
        if (t.length > 100) continue;
        if (reactions === 0) {
          const m = t.match(/([\d,.]+[KMB]?)\s*(?:reactions?|likes?)/i);
          if (m) reactions = parseCount(m[1].replace(/,/g, ""));
        }
        if (comments === 0) {
          const m = t.match(/([\d,.]+[KMB]?)\s*comments?/i);
          if (m) comments = parseCount(m[1].replace(/,/g, ""));
        }
        if (reposts === 0) {
          const m = t.match(/([\d,.]+[KMB]?)\s*reposts?/i);
          if (m) reposts = parseCount(m[1].replace(/,/g, ""));
        }
      }
    }

    // Pass 4: reaction count near emoji images
    if (reactions === 0) {
      for (const img of post.querySelectorAll('img[class*="reactions-icon"], img[src*="reactions"], img[alt*="reaction"], img[src*="like"], img[src*="praise"], img[src*="empathy"]')) {
        const parent = img.parentElement;
        if (!parent) continue;
        const n = extractFirstNumber(parent.textContent);
        if (n > 0) { reactions = n; break; }
        const sib = parent.nextElementSibling || parent.parentElement;
        if (sib) {
          const sn = extractFirstNumber(sib.textContent);
          if (sn > 0) { reactions = sn; break; }
        }
      }
    }

    // Pass 5: combined text
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
  //  AUTO-EXPAND "SEE MORE"
  // ════════════════════════════════════════════════════════════════════

  function expandAllSeeMore() {
    const main = getMainArea();
    const seeMoreBtns = [];
    const selectors = [
      'button[class*="see-more"]',
      'button[class*="show-more-text"]',
      'a[class*="see-more"]',
      '[data-control-name="see_more"]',
    ];
    for (const sel of selectors) {
      main.querySelectorAll(sel).forEach((btn) => seeMoreBtns.push(btn));
    }
    main.querySelectorAll("button, a").forEach((el) => {
      const t = (el.textContent || "").trim().toLowerCase();
      if (
        (t === "see more" || t === "\u2026see more" || t === "...see more" || t === "\u2026see more") &&
        !seeMoreBtns.includes(el)
      ) {
        seeMoreBtns.push(el);
      }
    });
    const unique = [...new Set(seeMoreBtns)];
    let clicked = 0;
    for (const btn of unique) {
      if (btn.offsetParent === null) continue;
      try { btn.click(); clicked++; } catch {}
    }
    return new Promise((resolve) => setTimeout(resolve, clicked > 0 ? 600 : 0));
  }

  // ════════════════════════════════════════════════════════════════════
  //  POST METADATA
  // ════════════════════════════════════════════════════════════════════

  function extractPostMeta(postInfo) {
    const post = postInfo.element;
    let username = "";
    let displayName = "";
    let postUrl = "";
    let fullCaption = "";
    let hook = "";
    let mediaType = "text";
    let date = null;

    // Author
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

    // Post URL
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

    // Caption (full text, no truncation)
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
    fullText = fullText.replace(/\u2026see more|\.\.\.see more|\u2026more|\.\.\.more/gi, "").trim();
    fullCaption = fullText;

    // Hook (first 3 lines)
    hook = extractHook(fullText);

    // Media type
    mediaType = detectMediaType(post);

    // Date
    date = extractPostDate(post);

    return {
      username: displayName || username || "",
      postUrl,
      caption: fullText.length > 300 ? fullText.substring(0, 297) + "..." : fullText,
      fullCaption,
      hook,
      mediaType,
      date,
    };
  }

  function extractHook(fullText) {
    if (!fullText) return "";
    const lines = fullText.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const hookLines = lines.slice(0, 3);
    let result = hookLines.join("\n");
    if (lines.length > 3) result += "...";
    if (result.length > 250) result = result.substring(0, 247) + "...";
    return result;
  }

  function detectMediaType(postEl) {
    if (postEl.querySelector('video, [class*="video-player"], [class*="update-components-video"], [data-urn*="video"]'))
      return "video";
    if (postEl.querySelector('[class*="document"], [class*="update-components-document"], [class*="ssplayer"]'))
      return "document";
    if (postEl.querySelector('[class*="carousel"], [class*="update-components-carousel"]'))
      return "carousel";
    if (postEl.querySelector('[class*="update-components-article"], [class*="feed-shared-article"]'))
      return "article";
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
      ) continue;
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
  //  DATE & MEDIA FILTERING
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

  function matchesMediaFilter(mediaType) {
    if (mediaFilterActive.size === 0) return true;
    return mediaFilterActive.has(mediaType);
  }

  function matchesSearch(postData) {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      (postData.fullCaption || "").toLowerCase().includes(q) ||
      (postData.username || "").toLowerCase().includes(q) ||
      (postData.hook || "").toLowerCase().includes(q)
    );
  }

  // ════════════════════════════════════════════════════════════════════
  //  HIGHLIGHTING
  // ════════════════════════════════════════════════════════════════════

  function clearHighlights() {
    document.querySelectorAll(".leh-tier1, .leh-tier2").forEach((el) =>
      el.classList.remove("leh-tier1", "leh-tier2")
    );
    document.querySelectorAll(".leh-score-badge").forEach((el) => el.remove());
  }

  function applyHighlights(scored) {
    if (!scored.length) return;
    if (mode === "percentile") {
      const sorted = [...scored].sort((a, b) => b.score - a.score);
      const t10 = sorted[Math.max(0, Math.ceil(sorted.length * 0.1) - 1)]?.score ?? Infinity;
      const tMed = sorted[Math.floor(sorted.length / 2)]?.score ?? 0;
      for (const it of scored) {
        if (!it.element) continue;
        it.element.classList.remove("leh-tier1", "leh-tier2");
        if (it.score >= t10 && it.score > 0) it.element.classList.add("leh-tier1");
        else if (it.score >= tMed && it.score > 0) it.element.classList.add("leh-tier2");
        if (showScores) addScoreBadge(it, scored);
      }
    } else {
      for (const it of scored) {
        if (!it.element) continue;
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

  // V4.0: Badge shows individual metrics (not bloated score)
  function addScoreBadge(item, all) {
    if (!item.element) return;
    const old = item.element.querySelector(".leh-score-badge");
    if (old) old.remove();
    if (!showScores) return;

    const badge = document.createElement("div");
    badge.className = "leh-score-badge leh-color-" + getScoreColor(item, all);

    const eng = item.engagement;
    const key = item.key || "";

    // Individual metrics row — the PRIMARY display (fixes bloated number bug)
    let metricsHtml = '<div class="leh-badge-metrics">';
    if (eng.reactions > 0) metricsHtml += '<span class="leh-badge-metric">\u{1F44D} ' + formatCount(eng.reactions) + '</span>';
    if (eng.comments > 0) metricsHtml += '<span class="leh-badge-metric">\u{1F4AC} ' + formatCount(eng.comments) + '</span>';
    if (eng.reposts > 0) metricsHtml += '<span class="leh-badge-metric">\u{1F501} ' + formatCount(eng.reposts) + '</span>';
    if (eng.reactions === 0 && eng.comments === 0 && eng.reposts === 0) {
      metricsHtml += '<span class="leh-badge-metric">no data</span>';
    }
    metricsHtml += '</div>';

    // Score as small secondary line
    const scoreLine = '<div class="leh-badge-score-line">Score: ' + item.score.toLocaleString() + '</div>';

    // Action buttons (bookmark + copy)
    const bookmarked = postStore.get(key)?.bookmarked ? " leh-bookmarked" : "";
    const actionsHtml = '<div class="leh-badge-actions">' +
      '<button class="leh-badge-btn' + bookmarked + '" data-action="bookmark" data-key="' + key + '" title="Bookmark">\u2606</button>' +
      '<button class="leh-badge-btn" data-action="copy" data-key="' + key + '" title="Copy post">\u{1F4CB}</button>' +
      '</div>';

    badge.innerHTML = metricsHtml + scoreLine + actionsHtml;

    // Wire badge button events
    badge.querySelectorAll(".leh-badge-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.getAttribute("data-action");
        const k = btn.getAttribute("data-key");
        if (action === "bookmark") {
          const pd = postStore.get(k);
          if (pd) {
            pd.bookmarked = !pd.bookmarked;
            btn.classList.toggle("leh-bookmarked", pd.bookmarked);
            btn.textContent = pd.bookmarked ? "\u2605" : "\u2606";
            updateSidebar();
            saveSettings();
          }
        } else if (action === "copy") {
          const pd = postStore.get(k);
          if (pd) {
            const text = "Author: " + (pd.username || "Unknown") + "\n" +
              "Date: " + (pd.date ? pd.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Unknown") + "\n" +
              "Reactions: " + formatCount(pd.engagement.reactions) + " | Comments: " + formatCount(pd.engagement.comments) + " | Reposts: " + formatCount(pd.engagement.reposts) + "\n" +
              (pd.postUrl ? "URL: " + pd.postUrl + "\n" : "") +
              "\n" + (pd.fullCaption || "(no text)");
            navigator.clipboard.writeText(text).then(() => {
              btn.textContent = "\u2713";
              setTimeout(() => { btn.textContent = "\u{1F4CB}"; }, 1200);
            });
          }
        }
      });
    });

    if (window.getComputedStyle(item.element).position === "static")
      item.element.style.position = "relative";
    item.element.appendChild(badge);
  }

  // ════════════════════════════════════════════════════════════════════
  //  MAIN PROCESSING — with persistent data store
  // ════════════════════════════════════════════════════════════════════

  function processAllPosts(forceRefresh) {
    if (!enabled) { clearHighlights(); return; }

    const posts = findAllPosts();
    const visibleEntries = [];

    for (const pi of posts) {
      const key = getPostKey(pi.element);
      const existing = postStore.get(key);

      if (existing && !forceRefresh) {
        // Update DOM reference (may have changed due to virtual scroll)
        existing.element = pi.element;
        existing.lastSeen = Date.now();
        visibleEntries.push(existing);
        continue;
      }

      const eng = extractEngagement(pi);
      const meta = extractPostMeta(pi);
      const score = calculateScore(eng);

      // Engagement trend detection
      let previousEngagement = null;
      if (existing) {
        previousEngagement = { ...existing.engagement };
      }

      const entry = {
        key,
        element: pi.element,
        type: pi.type,
        score,
        engagement: eng,
        previousEngagement,
        date: meta.date,
        username: meta.username,
        postUrl: meta.postUrl,
        caption: meta.caption,
        fullCaption: meta.fullCaption,
        hook: meta.hook,
        mediaType: meta.mediaType,
        firstSeen: existing ? existing.firstSeen : Date.now(),
        lastSeen: Date.now(),
        bookmarked: existing ? existing.bookmarked : false,
      };

      // Cap store size
      if (postStore.size >= MAX_STORE_SIZE && !postStore.has(key)) {
        // Remove oldest entry
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [k, v] of postStore) {
          if (v.lastSeen < oldestTime && !v.bookmarked) {
            oldestTime = v.lastSeen;
            oldestKey = k;
          }
        }
        if (oldestKey) postStore.delete(oldestKey);
      }

      postStore.set(key, entry);
      visibleEntries.push(entry);
    }

    // Apply filters to visible entries
    const filtered = visibleEntries.filter((it) =>
      isInDateRange(it.date) && matchesMediaFilter(it.mediaType)
    );

    // Dim non-matching visible posts
    for (const it of visibleEntries) {
      if (!it.element) continue;
      if (!filtered.includes(it)) {
        it.element.classList.remove("leh-tier1", "leh-tier2");
        const b = it.element.querySelector(".leh-score-badge");
        if (b) b.remove();
        it.element.style.opacity = "0.4";
      } else {
        it.element.style.opacity = "";
      }
    }

    clearHighlights();
    applyHighlights(filtered);
    updateSidebar();
  }

  function debouncedProcess() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processAllPosts, DEBOUNCE_MS);
  }

  // ════════════════════════════════════════════════════════════════════
  //  MUTATION OBSERVER — improved for v4.0
  // ════════════════════════════════════════════════════════════════════

  function setupObserver() {
    const target = getMainArea();
    const obs = new MutationObserver((muts) => {
      let shouldProcess = false;
      for (const m of muts) {
        if (m.addedNodes.length > 0) { shouldProcess = true; break; }
        if (m.type === "attributes" && m.attributeName === "data-urn") { shouldProcess = true; break; }
      }
      if (shouldProcess) debouncedProcess();
    });
    obs.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-urn", "data-id"] });

    // Periodic re-scan to catch anything the observer misses
    setInterval(() => {
      if (enabled) processAllPosts();
    }, 2000);

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
          updateSidebar();
        }, 1500);
      }
    }, 500);
  }

  // ════════════════════════════════════════════════════════════════════
  //  AUTO-SCROLL — v4.0: bidirectional
  // ════════════════════════════════════════════════════════════════════

  function startAutoScroll() {
    if (autoScrollRafId) return;
    lastScrollTime = performance.now();
    showMoreHandled = false;

    function step(now) {
      if (!autoScrollEnabled || autoScrollDirection === "paused") {
        autoScrollRafId = requestAnimationFrame(step);
        return;
      }
      const dt = now - lastScrollTime;
      lastScrollTime = now;
      const basePx = (SCROLL_SPEEDS[Math.min(autoScrollSpeed - 1, 5)] * dt) / 1000;
      const direction = autoScrollDirection === "up" ? -1 : 1;
      const px = basePx * direction * (1 + Math.sin(now / 800) * 0.15);
      window.scrollBy({ top: px, behavior: "instant" });

      // Auto-click "Show more" when scrolling down and near bottom
      if (autoScrollDirection === "down" &&
          window.innerHeight + window.scrollY >= document.body.scrollHeight - 150 &&
          !showMoreHandled) {
        handleShowMore();
      }
      autoScrollRafId = requestAnimationFrame(step);
    }

    autoScrollRafId = requestAnimationFrame(step);
    showMorePollId = setInterval(() => {
      if (!autoScrollEnabled || autoScrollDirection !== "down") return;
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
      if (t.includes("show more") || t.includes("load more") ||
          t.includes("see more activity") || t.includes("show more results"))
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
  //  SIDEBAR UI
  // ════════════════════════════════════════════════════════════════════

  function createSidebar() {
    if (document.getElementById("leh-sidebar")) return;

    // Toggle tab (always visible)
    const tab = document.createElement("button");
    tab.id = "leh-sidebar-tab";
    tab.innerHTML = '<span class="leh-tab-icon">\u{1F4CA}</span><span class="leh-tab-label">LEH</span>';
    tab.addEventListener("click", toggleSidebar);
    document.body.appendChild(tab);

    // Sidebar
    const sidebar = document.createElement("div");
    sidebar.id = "leh-sidebar";
    sidebar.innerHTML = buildSidebarHTML();
    document.body.appendChild(sidebar);

    wireUpSidebarEvents(sidebar);

    if (sidebarOpen) {
      document.body.classList.add("leh-sidebar-open");
    } else {
      sidebar.classList.add("leh-closed");
    }

    updateSidebar();
  }

  function toggleSidebar() {
    const sidebar = document.getElementById("leh-sidebar");
    if (!sidebar) return;
    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle("leh-closed", !sidebarOpen);
    document.body.classList.toggle("leh-sidebar-open", sidebarOpen);
    saveSettings();
  }

  function buildSidebarHTML() {
    const pageLabels = { feed: "Feed", activity: "Activity", company: "Company", search: "Search", profile: "Profile", post: "Post" };
    const pageLabel = pageLabels[getPageType()] || "Feed";

    return '' +
    '<div class="leh-sidebar-header">' +
      '<div class="leh-header-left">' +
        '<svg class="leh-logo" width="18" height="18" viewBox="0 0 24 24" fill="none">' +
          '<path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" fill="currentColor"/>' +
        '</svg>' +
        '<span class="leh-sidebar-title">Engagement Highlighter</span>' +
        '<span class="leh-version-badge">v4.0</span>' +
      '</div>' +
      '<button class="leh-header-close" title="Close sidebar">&times;</button>' +
    '</div>' +

    // Stats bar
    '<div class="leh-stats-bar">' +
      '<div class="leh-stat"><span id="leh-stat-total" class="leh-stat-value">0</span><span class="leh-stat-label">Total</span></div>' +
      '<div class="leh-stat"><span id="leh-stat-visible" class="leh-stat-value">0</span><span class="leh-stat-label">Visible</span></div>' +
      '<div class="leh-stat"><span id="leh-stat-avg" class="leh-stat-value">0</span><span class="leh-stat-label">Avg Score</span></div>' +
      '<div class="leh-stat"><span id="leh-stat-session" class="leh-stat-value">0m</span><span class="leh-stat-label">Session</span></div>' +
    '</div>' +

    // Search
    '<div class="leh-search-box">' +
      '<div class="leh-search-input-wrap">' +
        '<span class="leh-search-icon">\u{1F50D}</span>' +
        '<input type="text" id="leh-search" class="leh-search-input" placeholder="Search posts by keyword, author..." />' +
        '<button id="leh-search-clear" class="leh-search-clear">&times;</button>' +
      '</div>' +
      '<div id="leh-search-count" class="leh-search-count"></div>' +
    '</div>' +

    // Media filter chips
    '<div class="leh-filter-bar">' +
      '<div class="leh-filter-label">Media Type</div>' +
      '<div class="leh-filter-chips" id="leh-media-chips">' +
        '<button class="leh-chip leh-chip-active" data-media="all">All</button>' +
        '<button class="leh-chip" data-media="text">TEXT <span class="leh-chip-count" id="leh-count-text">(0)</span></button>' +
        '<button class="leh-chip" data-media="image">IMG <span class="leh-chip-count" id="leh-count-image">(0)</span></button>' +
        '<button class="leh-chip" data-media="video">VID <span class="leh-chip-count" id="leh-count-video">(0)</span></button>' +
        '<button class="leh-chip" data-media="document">DOC <span class="leh-chip-count" id="leh-count-document">(0)</span></button>' +
        '<button class="leh-chip" data-media="carousel">MULTI <span class="leh-chip-count" id="leh-count-carousel">(0)</span></button>' +
        '<button class="leh-chip" data-media="article">LINK <span class="leh-chip-count" id="leh-count-article">(0)</span></button>' +
      '</div>' +
    '</div>' +

    // Page indicator
    '<div id="leh-page-type" class="leh-page-indicator">' + pageLabel + '</div>' +

    // Scrollable body
    '<div class="leh-sidebar-body">' +

      // Post list
      '<div id="leh-post-list" class="leh-post-list"></div>' +

      // Settings section
      '<div class="leh-section">' +
        '<div class="leh-section-header" data-section="highlighter">' +
          '<span>Highlighter Settings</span><span class="leh-chevron">\u25BE</span>' +
        '</div>' +
        '<div class="leh-section-body">' +
          '<div class="leh-control-row"><span class="leh-label-text">Highlight posts</span><label class="leh-toggle"><input type="checkbox" id="leh-enabled" checked /><span class="leh-toggle-slider"></span></label></div>' +
          '<div class="leh-control-row"><span class="leh-label-text">Score badges</span><label class="leh-toggle"><input type="checkbox" id="leh-show-scores" checked /><span class="leh-toggle-slider"></span></label></div>' +
          '<div class="leh-control-row"><span class="leh-label-text">Mode</span><select id="leh-mode" class="leh-select"><option value="percentile">Percentile (auto)</option><option value="threshold">Fixed threshold</option></select></div>' +
          '<div class="leh-control-row leh-threshold-row" style="display:none;"><span class="leh-label-text">Threshold</span><input type="range" id="leh-threshold" min="10" max="5000" value="100" step="10" class="leh-range" /><span id="leh-threshold-val" class="leh-range-val">100</span></div>' +
        '</div>' +
      '</div>' +

      // Weights section
      '<div class="leh-section">' +
        '<div class="leh-section-header" data-section="weights">' +
          '<span>Score Weights</span><span class="leh-chevron">\u25BE</span>' +
        '</div>' +
        '<div class="leh-section-body">' +
          '<div class="leh-help-text">Higher = counts more toward score</div>' +
          '<div class="leh-control-row"><span class="leh-label-text">\u{1F44D} Reactions</span><input type="number" id="leh-w-reactions" value="5" min="0" max="20" class="leh-num-input" /></div>' +
          '<div class="leh-control-row"><span class="leh-label-text">\u{1F4AC} Comments</span><input type="number" id="leh-w-comments" value="10" min="0" max="20" class="leh-num-input" /></div>' +
          '<div class="leh-control-row"><span class="leh-label-text">\u{1F501} Reposts</span><input type="number" id="leh-w-reposts" value="2" min="0" max="20" class="leh-num-input" /></div>' +
          '<button id="leh-recalculate" class="leh-btn leh-btn-secondary">Recalculate</button>' +
        '</div>' +
      '</div>' +

      // Date filter section
      '<div class="leh-section">' +
        '<div class="leh-section-header" data-section="datefilter">' +
          '<span>Date Filter</span><span class="leh-chevron">\u25BE</span>' +
        '</div>' +
        '<div class="leh-section-body">' +
          '<select id="leh-date-filter" class="leh-select leh-select-full">' +
            '<option value="all">All time</option>' +
            '<option value="24h">Last 24 hours</option>' +
            '<option value="7d">Last 7 days</option>' +
            '<option value="30d">Last 30 days</option>' +
            '<option value="90d">Last 90 days</option>' +
            '<option value="custom">Custom range</option>' +
          '</select>' +
          '<div id="leh-date-custom" class="leh-date-custom" style="display:none;">' +
            '<div class="leh-control-row"><span class="leh-label-text">From</span><input type="date" id="leh-date-from" class="leh-date-input" /></div>' +
            '<div class="leh-control-row"><span class="leh-label-text">To</span><input type="date" id="leh-date-to" class="leh-date-input" /></div>' +
          '</div>' +
          '<div id="leh-filter-count" class="leh-filter-count" style="display:none;"></div>' +
        '</div>' +
      '</div>' +

      // Auto-scroll section
      '<div class="leh-section">' +
        '<div class="leh-section-header" data-section="autoscroll">' +
          '<span>Auto-scroll</span><span class="leh-chevron">\u25BE</span>' +
        '</div>' +
        '<div class="leh-section-body">' +
          '<div class="leh-control-row"><span class="leh-label-text">Enable</span><label class="leh-toggle"><input type="checkbox" id="leh-autoscroll" /><span class="leh-toggle-slider"></span></label></div>' +
          '<div class="leh-control-row"><span class="leh-label-text">Direction</span>' +
            '<div class="leh-scroll-dir-btns">' +
              '<button class="leh-scroll-dir-btn leh-dir-active" data-dir="down">\u25BC Down</button>' +
              '<button class="leh-scroll-dir-btn" data-dir="up">\u25B2 Up</button>' +
              '<button class="leh-scroll-dir-btn" data-dir="paused">\u23F8 Pause</button>' +
            '</div>' +
          '</div>' +
          '<div class="leh-control-row"><span class="leh-label-text">Speed</span><input type="range" id="leh-scroll-speed" min="1" max="6" value="3" class="leh-range" /><span id="leh-scroll-speed-val" class="leh-range-val">3</span></div>' +
        '</div>' +
      '</div>' +

      // Export section
      '<div class="leh-section">' +
        '<div class="leh-section-header" data-section="extract">' +
          '<span>Extract &amp; Export</span><span class="leh-chevron">\u25BE</span>' +
        '</div>' +
        '<div class="leh-section-body">' +
          '<div class="leh-control-row"><span class="leh-label-text">Show top</span><select id="leh-export-count" class="leh-select"><option value="5">5</option><option value="10" selected>10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="all">All</option></select></div>' +
          '<button id="leh-extract" class="leh-btn leh-btn-primary">Extract Top Posts</button>' +
          '<button id="leh-bulk-copy" class="leh-btn leh-btn-caption">Copy All Captions</button>' +
          '<button id="leh-export-bookmarks" class="leh-btn leh-btn-secondary">Export Bookmarked</button>' +
          '<div id="leh-extract-count" class="leh-help-text"></div>' +
        '</div>' +
      '</div>' +

      // Shortcuts
      '<div class="leh-section">' +
        '<div class="leh-section-header" data-section="shortcuts">' +
          '<span>Keyboard Shortcuts</span><span class="leh-chevron">\u25BE</span>' +
        '</div>' +
        '<div class="leh-section-body" style="display:none;">' +
          '<div class="leh-help-text" style="line-height:2;">' +
            '<kbd>Ctrl+Shift+L</kbd> Toggle sidebar<br>' +
            '<kbd>Ctrl+Shift+S</kbd> Start/stop scroll<br>' +
            '<kbd>Ctrl+Shift+E</kbd> Extract top posts<br>' +
            '<kbd>Ctrl+Shift+F</kbd> Focus search<br>' +
          '</div>' +
        '</div>' +
      '</div>' +

    '</div>'; // end sidebar-body
  }

  // ════════════════════════════════════════════════════════════════════
  //  SIDEBAR EVENTS
  // ════════════════════════════════════════════════════════════════════

  function wireUpSidebarEvents(sidebar) {
    const $ = (id) => document.getElementById(id);

    // Close button
    sidebar.querySelector(".leh-header-close").addEventListener("click", toggleSidebar);

    // Section collapse
    for (const hdr of sidebar.querySelectorAll(".leh-section-header")) {
      hdr.addEventListener("click", () => {
        const sbody = hdr.nextElementSibling;
        const chev = hdr.querySelector(".leh-chevron");
        const open = sbody.style.display !== "none";
        sbody.style.display = open ? "none" : "block";
        if (chev) chev.textContent = open ? "\u25B8" : "\u25BE";
      });
    }

    // Search
    $("leh-search").addEventListener("input", (e) => {
      const val = e.target.value;
      $("leh-search-clear").style.display = val ? "block" : "none";
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        searchQuery = val.trim();
        updateSidebar();
      }, 200);
    });

    $("leh-search-clear").addEventListener("click", () => {
      $("leh-search").value = "";
      $("leh-search-clear").style.display = "none";
      searchQuery = "";
      updateSidebar();
    });

    // Media filter chips
    sidebar.querySelectorAll("#leh-media-chips .leh-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const media = chip.getAttribute("data-media");
        if (media === "all") {
          mediaFilterActive.clear();
          sidebar.querySelectorAll("#leh-media-chips .leh-chip").forEach((c) =>
            c.classList.toggle("leh-chip-active", c.getAttribute("data-media") === "all")
          );
        } else {
          // Toggle this chip
          const allChip = sidebar.querySelector('#leh-media-chips .leh-chip[data-media="all"]');
          if (mediaFilterActive.has(media)) {
            mediaFilterActive.delete(media);
          } else {
            mediaFilterActive.add(media);
          }
          chip.classList.toggle("leh-chip-active", mediaFilterActive.has(media));
          allChip.classList.toggle("leh-chip-active", mediaFilterActive.size === 0);
        }
        processAllPosts(true);
      });
    });

    // Highlighter controls
    $("leh-enabled").addEventListener("change", (e) => { enabled = e.target.checked; processAllPosts(); saveSettings(); });
    $("leh-show-scores").addEventListener("change", (e) => { showScores = e.target.checked; processAllPosts(); saveSettings(); });
    $("leh-mode").addEventListener("change", (e) => {
      mode = e.target.value;
      sidebar.querySelector(".leh-threshold-row").style.display = mode === "threshold" ? "flex" : "none";
      processAllPosts(true); saveSettings();
    });
    $("leh-threshold").addEventListener("input", (e) => {
      absoluteThreshold = +e.target.value;
      $("leh-threshold-val").textContent = absoluteThreshold;
      saveSettings();
    });
    $("leh-threshold").addEventListener("change", () => processAllPosts(true));

    // Weights
    $("leh-w-reactions").addEventListener("change", (e) => { weights.reactions = +e.target.value || 0; processAllPosts(true); saveSettings(); });
    $("leh-w-comments").addEventListener("change", (e) => { weights.comments = +e.target.value || 0; processAllPosts(true); saveSettings(); });
    $("leh-w-reposts").addEventListener("change", (e) => { weights.reposts = +e.target.value || 0; processAllPosts(true); saveSettings(); });
    $("leh-recalculate").addEventListener("click", () => processAllPosts(true));

    // Date filter
    $("leh-date-filter").addEventListener("change", (e) => {
      dateFilter = e.target.value;
      $("leh-date-custom").style.display = dateFilter === "custom" ? "block" : "none";
      processAllPosts(true); saveSettings();
    });
    $("leh-date-from").addEventListener("change", (e) => { customDateFrom = e.target.value; processAllPosts(true); saveSettings(); });
    $("leh-date-to").addEventListener("change", (e) => { customDateTo = e.target.value; processAllPosts(true); saveSettings(); });

    // Auto-scroll
    $("leh-autoscroll").addEventListener("change", (e) => {
      autoScrollEnabled = e.target.checked;
      if (autoScrollEnabled) startAutoScroll(); else stopAutoScroll();
      saveSettings();
    });

    // Direction buttons
    sidebar.querySelectorAll(".leh-scroll-dir-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        autoScrollDirection = btn.getAttribute("data-dir");
        sidebar.querySelectorAll(".leh-scroll-dir-btn").forEach((b) =>
          b.classList.toggle("leh-dir-active", b.getAttribute("data-dir") === autoScrollDirection)
        );
        saveSettings();
      });
    });

    $("leh-scroll-speed").addEventListener("input", (e) => {
      autoScrollSpeed = +e.target.value;
      $("leh-scroll-speed-val").textContent = autoScrollSpeed;
      saveSettings();
    });

    // Export buttons
    $("leh-extract").addEventListener("click", extractTopPosts);
    $("leh-bulk-copy").addEventListener("click", bulkCopyCaptions);
    $("leh-export-bookmarks").addEventListener("click", exportBookmarked);
  }

  // ════════════════════════════════════════════════════════════════════
  //  SIDEBAR UPDATE — post cards, stats, filter counts
  // ════════════════════════════════════════════════════════════════════

  function updateSidebar() {
    const $ = (id) => document.getElementById(id);

    if (!$("leh-stat-total")) return;

    // Stats
    const total = postStore.size;
    const visible = findAllPosts().length;
    let totalScore = 0;
    for (const [, v] of postStore) totalScore += v.score;
    const avg = total > 0 ? Math.round(totalScore / total) : 0;
    const mins = Math.floor((Date.now() - sessionStart) / 60000);

    $("leh-stat-total").textContent = total;
    $("leh-stat-visible").textContent = visible;
    $("leh-stat-avg").textContent = formatCount(avg);
    $("leh-stat-session").textContent = mins < 60 ? mins + "m" : Math.floor(mins / 60) + "h" + (mins % 60) + "m";

    // Media chip counts
    const mediaCounts = { text: 0, image: 0, video: 0, document: 0, carousel: 0, article: 0 };
    for (const [, v] of postStore) {
      if (mediaCounts[v.mediaType] !== undefined) mediaCounts[v.mediaType]++;
    }
    for (const type of Object.keys(mediaCounts)) {
      const el = $("leh-count-" + type);
      if (el) el.textContent = "(" + mediaCounts[type] + ")";
    }

    // Page indicator
    const pageLabels = { feed: "Feed", activity: "Activity", company: "Company", search: "Search", profile: "Profile", post: "Post" };
    const pageEl = $("leh-page-type");
    if (pageEl) pageEl.textContent = pageLabels[getPageType()] || getPageType();

    // Extract count
    const extractCount = $("leh-extract-count");
    if (extractCount) {
      const ctx = { feed: "in feed", activity: "on activity", company: "on company", search: "in results" }[getPageType()] || "in feed";
      extractCount.textContent = total + " post" + (total !== 1 ? "s" : "") + " in store, " + visible + " visible " + ctx;
    }

    // Date filter count
    const filterCountEl = $("leh-filter-count");
    if (filterCountEl) {
      if (dateFilter === "all" && mediaFilterActive.size === 0) {
        filterCountEl.style.display = "none";
      } else {
        let matched = 0;
        for (const [, v] of postStore) {
          if (isInDateRange(v.date) && matchesMediaFilter(v.mediaType)) matched++;
        }
        filterCountEl.textContent = matched + " of " + total + " posts match filters";
        filterCountEl.style.display = "block";
      }
    }

    // Post list — from data store (not DOM)
    updatePostList();
  }

  function updatePostList() {
    const container = document.getElementById("leh-post-list");
    if (!container) return;

    // Get all posts from store, apply filters
    const posts = [];
    for (const [key, data] of postStore) {
      if (!isInDateRange(data.date)) continue;
      if (!matchesMediaFilter(data.mediaType)) continue;
      if (!matchesSearch(data)) continue;
      posts.push({ key, ...data });
    }

    // Sort by score
    posts.sort((a, b) => b.score - a.score);

    // Search count
    const searchCountEl = document.getElementById("leh-search-count");
    if (searchCountEl) {
      if (searchQuery) {
        searchCountEl.textContent = posts.length + " post" + (posts.length !== 1 ? "s" : "") + ' match "' + searchQuery + '"';
      } else {
        searchCountEl.textContent = "";
      }
    }

    // Limit display to 50 cards for performance
    const display = posts.slice(0, 50);

    if (display.length === 0) {
      container.innerHTML = '<div class="leh-empty-state">' +
        '<div class="leh-empty-icon">\u{1F50D}</div>' +
        (searchQuery ? 'No posts match "' + escHtml(searchQuery) + '"' : 'No posts detected yet. Scroll through the feed to load posts.') +
        '</div>';
      return;
    }

    let html = "";
    for (const p of display) {
      const author = escHtml(p.username || "Unknown");
      const dateStr = p.date
        ? p.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "\u2014";
      const hookText = escHtml(p.hook || p.caption || "");
      const highlightedHook = searchQuery ? highlightSearch(hookText, searchQuery) : hookText;
      const highlightedAuthor = searchQuery ? highlightSearch(author, searchQuery) : author;

      const mediaClass = "leh-media-" + (p.mediaType || "text");
      const mediaLabels = { image: "IMG", video: "VID", document: "DOC", carousel: "MULTI", article: "LINK", text: "TEXT" };
      const mediaLabel = mediaLabels[p.mediaType] || "TEXT";

      // Trend indicators
      let reactTrend = "";
      let commentTrend = "";
      let repostTrend = "";
      if (p.previousEngagement) {
        if (p.engagement.reactions > p.previousEngagement.reactions) reactTrend = '<span class="leh-metric-trend-up">\u2191</span>';
        else if (p.engagement.reactions < p.previousEngagement.reactions) reactTrend = '<span class="leh-metric-trend-down">\u2193</span>';
        if (p.engagement.comments > p.previousEngagement.comments) commentTrend = '<span class="leh-metric-trend-up">\u2191</span>';
        if (p.engagement.reposts > p.previousEngagement.reposts) repostTrend = '<span class="leh-metric-trend-up">\u2191</span>';
      }

      const bookmarkIcon = p.bookmarked ? "\u2605" : "\u2606";
      const bookmarkClass = p.bookmarked ? " leh-bookmarked" : "";

      html += '<div class="leh-post-card" data-key="' + p.key + '">' +
        '<div class="leh-post-card-header">' +
          '<span class="leh-post-card-author">' + highlightedAuthor + '</span>' +
          '<span class="leh-post-card-date">' + dateStr + '</span>' +
        '</div>' +
        '<div class="leh-post-card-hook">' + highlightedHook + '</div>' +
        '<div class="leh-post-card-metrics">' +
          '<span class="leh-metric">\u{1F44D} <span class="leh-metric-value">' + formatCount(p.engagement.reactions) + '</span>' + reactTrend + '</span>' +
          '<span class="leh-metric">\u{1F4AC} <span class="leh-metric-value">' + formatCount(p.engagement.comments) + '</span>' + commentTrend + '</span>' +
          '<span class="leh-metric">\u{1F501} <span class="leh-metric-value">' + formatCount(p.engagement.reposts) + '</span>' + repostTrend + '</span>' +
        '</div>' +
        '<div class="leh-post-card-footer">' +
          '<span class="leh-post-card-score">Score: ' + p.score.toLocaleString() + '</span>' +
          '<span class="leh-post-card-media ' + mediaClass + '">' + mediaLabel + '</span>' +
          '<div class="leh-post-card-actions">' +
            '<button class="leh-card-btn' + bookmarkClass + '" data-action="bookmark" data-key="' + p.key + '" title="Bookmark">' + bookmarkIcon + '</button>' +
            '<button class="leh-card-btn" data-action="copy" data-key="' + p.key + '" title="Copy">\u{1F4CB}</button>' +
            (p.postUrl ? '<a href="' + p.postUrl + '" target="_blank" rel="noopener" class="leh-card-btn" title="View">\u{1F517}</a>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    }

    container.innerHTML = html;

    // Wire card events
    container.querySelectorAll(".leh-post-card").forEach((card) => {
      // Click card to scroll to post
      card.addEventListener("click", (e) => {
        if (e.target.closest(".leh-card-btn, a")) return;
        const key = card.getAttribute("data-key");
        const pd = postStore.get(key);
        if (pd && pd.element && pd.element.isConnected) {
          pd.element.scrollIntoView({ behavior: "smooth", block: "center" });
          pd.element.style.transition = "box-shadow 0.3s";
          pd.element.style.boxShadow = "0 0 20px rgba(10, 102, 194, 0.5)";
          setTimeout(() => { pd.element.style.boxShadow = ""; }, 2000);
        }
      });
    });

    container.querySelectorAll(".leh-card-btn[data-action]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.getAttribute("data-action");
        const key = btn.getAttribute("data-key");
        if (action === "bookmark") {
          const pd = postStore.get(key);
          if (pd) {
            pd.bookmarked = !pd.bookmarked;
            btn.classList.toggle("leh-bookmarked", pd.bookmarked);
            btn.textContent = pd.bookmarked ? "\u2605" : "\u2606";
            saveSettings();
          }
        } else if (action === "copy") {
          const pd = postStore.get(key);
          if (pd) {
            const text = "Author: " + (pd.username || "Unknown") + "\n" +
              "Reactions: " + formatCount(pd.engagement.reactions) + " | Comments: " + formatCount(pd.engagement.comments) + " | Reposts: " + formatCount(pd.engagement.reposts) + "\n" +
              (pd.postUrl ? "URL: " + pd.postUrl + "\n" : "") +
              "\n" + (pd.fullCaption || "(no text)");
            navigator.clipboard.writeText(text).then(() => {
              btn.textContent = "\u2713";
              setTimeout(() => { btn.textContent = "\u{1F4CB}"; }, 1200);
            });
          }
        }
      });
    });
  }

  function escHtml(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function highlightSearch(text, query) {
    if (!query) return text;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp("(" + escaped + ")", "gi"), '<span class="leh-search-match">$1</span>');
  }

  // ════════════════════════════════════════════════════════════════════
  //  BULK COPY CAPTIONS
  // ════════════════════════════════════════════════════════════════════

  async function bulkCopyCaptions() {
    const btn = document.getElementById("leh-bulk-copy");
    if (btn) { btn.textContent = "Expanding posts..."; btn.disabled = true; }

    await expandAllSeeMore();
    if (btn) btn.textContent = "Extracting...";

    // Use data store (not live DOM) — fixes "no data" bug
    processAllPosts(true);

    const results = [];
    for (const [, data] of postStore) {
      if (!isInDateRange(data.date)) continue;
      if (!matchesMediaFilter(data.mediaType)) continue;
      results.push(data);
    }
    results.sort((a, b) => b.score - a.score);

    if (results.length === 0) {
      if (btn) {
        btn.textContent = "No posts found";
        btn.disabled = false;
        setTimeout(() => { btn.textContent = "Copy All Captions"; }, 2000);
      }
      return;
    }

    const lines = results.map((p, i) => {
      const author = p.username || "Unknown";
      const dateStr = p.date
        ? p.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "Unknown date";
      const captionText = p.fullCaption || p.caption || "(no text)";
      const engLine = [
        p.engagement.reactions > 0 ? formatCount(p.engagement.reactions) + " reactions" : "",
        p.engagement.comments > 0 ? formatCount(p.engagement.comments) + " comments" : "",
        p.engagement.reposts > 0 ? formatCount(p.engagement.reposts) + " reposts" : "",
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
      if (btn) {
        btn.textContent = "Copy failed - see modal";
        btn.disabled = false;
        setTimeout(() => { btn.textContent = "Copy All Captions"; }, 2000);
      }
      showFallbackModal(output);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  EXPORT BOOKMARKED
  // ════════════════════════════════════════════════════════════════════

  function exportBookmarked() {
    const bookmarked = [];
    for (const [, data] of postStore) {
      if (data.bookmarked) bookmarked.push(data);
    }
    bookmarked.sort((a, b) => b.score - a.score);

    if (bookmarked.length === 0) {
      const btn = document.getElementById("leh-export-bookmarks");
      if (btn) {
        btn.textContent = "No bookmarks";
        setTimeout(() => { btn.textContent = "Export Bookmarked"; }, 2000);
      }
      return;
    }

    showExportModal(bookmarked, bookmarked.length);
  }

  // ════════════════════════════════════════════════════════════════════
  //  EXTRACT & EXPORT — v4.0: uses data store
  // ════════════════════════════════════════════════════════════════════

  async function extractTopPosts() {
    const extractBtn = document.getElementById("leh-extract");
    if (extractBtn) { extractBtn.textContent = "Expanding..."; extractBtn.disabled = true; }

    await expandAllSeeMore();
    if (extractBtn) extractBtn.textContent = "Extracting...";

    // Refresh store from current DOM
    processAllPosts(true);

    // Pull from data store (fixes "no data" bug)
    const scored = [];
    for (const [, data] of postStore) {
      if (!isInDateRange(data.date)) continue;
      if (!matchesMediaFilter(data.mediaType)) continue;
      scored.push(data);
    }
    scored.sort((a, b) => b.score - a.score);

    const countVal = (document.getElementById("leh-export-count") || {}).value || "10";
    const limit = countVal === "all" ? scored.length : parseInt(countVal, 10);
    const top = scored.slice(0, limit);

    if (extractBtn) {
      extractBtn.textContent = "Extract Top Posts";
      extractBtn.disabled = false;
    }

    showExportModal(top, scored.length);
  }

  function showExportModal(posts, totalScored) {
    const existing = document.getElementById("leh-export-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "leh-export-modal";
    overlay.className = "leh-modal-overlay";

    const mediaBadge = (type) => {
      const colors = { image: "#3b82f6", video: "#ef4444", document: "#f59e0b", carousel: "#8b5cf6", article: "#06b6d4", text: "#6b7280" };
      const labels = { image: "IMG", video: "VID", document: "DOC", carousel: "MULTI", article: "LINK", text: "TEXT" };
      return '<span style="background:' + (colors[type] || "#6b7280") + ';color:#fff;padding:2px 6px;border-radius:4px;font-size:9px;font-weight:700;">' + (labels[type] || "TEXT") + "</span>";
    };

    let rows = "";
    posts.forEach((p, i) => {
      const author = escHtml(p.username) || "Unknown";
      const dateStr = p.date
        ? p.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "\u2014";
      const captionDisplay = p.fullCaption
        ? '<span class="leh-modal-hook">' + escHtml(p.fullCaption).replace(/\n/g, "<br>") + "</span>"
        : '<span class="leh-modal-hook leh-hook-empty">No text</span>';
      const link = p.postUrl
        ? '<a href="' + p.postUrl + '" target="_blank" rel="noopener noreferrer" class="leh-modal-link">View</a>'
        : "\u2014";

      rows +=
        "<tr>" +
        '<td class="leh-modal-rank">' + (i + 1) + "</td>" +
        '<td class="leh-modal-user">' + author + "</td>" +
        '<td class="leh-modal-date">' + dateStr + "</td>" +
        '<td class="leh-modal-metrics">' + formatCount(p.engagement.reactions) + "</td>" +
        '<td class="leh-modal-metrics">' + formatCount(p.engagement.comments) + "</td>" +
        '<td class="leh-modal-metrics">' + formatCount(p.engagement.reposts) + "</td>" +
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
        ? '<div class="leh-modal-empty">No posts found. Scroll through the feed to load posts into the data store.</div>'
        : '<table class="leh-modal-table"><thead><tr>' +
          "<th>#</th><th>Author</th><th>Date</th><th>Reacts</th><th>Cmts</th><th>Reposts</th><th>Score</th><th>Media</th><th>Link</th>" +
          "</tr></thead><tbody>" + rows + "</tbody></table>") +
      "</div></div>";

    document.body.appendChild(overlay);

    overlay.querySelector(".leh-modal-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    // Copy Text
    document.getElementById("leh-copy-text").addEventListener("click", () => {
      const lines = posts.map((p, i) => {
        const parts = [];
        if (p.engagement.reactions > 0) parts.push(formatCount(p.engagement.reactions) + " reactions");
        if (p.engagement.comments > 0) parts.push(formatCount(p.engagement.comments) + " comments");
        if (p.engagement.reposts > 0) parts.push(formatCount(p.engagement.reposts) + " reposts");
        const dateStr = p.date ? p.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Unknown date";
        let line = (i + 1) + ". " + (p.username || "Unknown") + "\n   Date: " + dateStr + " | Media: " + (p.mediaType || "text") + " | Score: " + p.score.toLocaleString() + " (" + parts.join(", ") + ")";
        if (p.hook) line += '\n   Hook: "' + p.hook.replace(/\n/g, " / ") + '"';
        if (p.postUrl) line += "\n   " + p.postUrl;
        return line;
      });
      const text = "Top " + posts.length + " Posts\n" + "=".repeat(50) + "\n\n" + lines.join("\n\n");
      navigator.clipboard.writeText(text).then(() => flashButton("leh-copy-text", "Copied!"));
    });

    // Copy JSON
    document.getElementById("leh-copy-json").addEventListener("click", () => {
      const data = posts.map((p, i) => ({
        rank: i + 1,
        author: p.username || null,
        date: p.date ? p.date.toISOString() : null,
        hook: p.hook || null,
        fullCaption: p.fullCaption || null,
        mediaType: p.mediaType || "text",
        postUrl: p.postUrl || null,
        reactions: p.engagement.reactions,
        comments: p.engagement.comments,
        reposts: p.engagement.reposts,
        score: p.score,
      }));
      navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => flashButton("leh-copy-json", "Copied!"));
    });

    // Download CSV
    document.getElementById("leh-download-csv").addEventListener("click", () => {
      const esc = (v) => { const s = String(v ?? ""); return s.includes(",") || s.includes('"') || s.includes("\n") ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const hdr = "Rank,Author,Date,Reactions,Comments,Reposts,Score,Hook,Full Caption,Media Type,Post URL";
      const csvRows = posts.map((p, i) => [
        i + 1, esc(p.username || ""),
        p.date ? p.date.toISOString().slice(0, 10) : "",
        p.engagement.reactions, p.engagement.comments, p.engagement.reposts, p.score,
        esc(p.hook || ""), esc(p.fullCaption || ""),
        esc(p.mediaType || "text"), esc(p.postUrl || ""),
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

    // Copy All Captions (modal)
    document.getElementById("leh-modal-copy-captions").addEventListener("click", () => {
      const captionLines = posts.map((p, i) => {
        const captionText = p.fullCaption || p.caption || "(no text)";
        const engLine = [
          p.engagement.reactions > 0 ? formatCount(p.engagement.reactions) + " reactions" : "",
          p.engagement.comments > 0 ? formatCount(p.engagement.comments) + " comments" : "",
          p.engagement.reposts > 0 ? formatCount(p.engagement.reposts) + " reposts" : "",
        ].filter(Boolean).join(", ");
        return "--- Post " + (i + 1) + " ---\n" +
          "Author: " + (p.username || "Unknown") + "\n" +
          "Engagement: " + (engLine || "none") + "\n\n" + captionText;
      });
      const output = "Bulk Captions (" + posts.length + " posts)\n" + "=".repeat(60) + "\n\n" +
        captionLines.join("\n\n" + "=".repeat(60) + "\n\n");
      navigator.clipboard.writeText(output).then(() => flashButton("leh-modal-copy-captions", "Copied!"));
    });
  }

  function showFallbackModal(text) {
    const existing = document.getElementById("leh-caption-fallback");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.id = "leh-caption-fallback";
    overlay.className = "leh-modal-overlay";
    overlay.innerHTML =
      '<div class="leh-modal" style="max-width:700px;">' +
      '<div class="leh-modal-header">' +
      '<span class="leh-modal-title">Copied Captions (select all &amp; copy)</span>' +
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
      // Save bookmarks as array of keys
      const bookmarkedKeys = [];
      for (const [key, data] of postStore) {
        if (data.bookmarked) bookmarkedKeys.push(key);
      }
      chrome.storage.local.set({
        lehSettingsV40: {
          enabled, showScores, mode, absoluteThreshold, weights,
          autoScrollSpeed, autoScrollDirection, dateFilter, customDateFrom, customDateTo,
          sidebarOpen, bookmarkedKeys,
        },
      });
    } catch {}
  }

  function loadSettings() {
    try {
      chrome.storage.local.get("lehSettingsV40", (res) => {
        if (!res?.lehSettingsV40) {
          // Try migrating from v3.3
          chrome.storage.local.get("lehSettingsV33", (res2) => {
            if (res2?.lehSettingsV33) applySettings(res2.lehSettingsV33);
          });
          return;
        }
        applySettings(res.lehSettingsV40);
      });
    } catch {}
  }

  function applySettings(s) {
    enabled = s.enabled ?? true;
    showScores = s.showScores ?? true;
    mode = s.mode ?? "percentile";
    absoluteThreshold = s.absoluteThreshold ?? 100;
    weights = s.weights ?? { reactions: 5, comments: 10, reposts: 2 };
    autoScrollSpeed = s.autoScrollSpeed ?? 3;
    autoScrollDirection = s.autoScrollDirection ?? "down";
    dateFilter = s.dateFilter ?? "all";
    customDateFrom = s.customDateFrom ?? "";
    customDateTo = s.customDateTo ?? "";
    sidebarOpen = s.sidebarOpen ?? true;

    // Restore bookmarks
    if (s.bookmarkedKeys) {
      for (const key of s.bookmarkedKeys) {
        const pd = postStore.get(key);
        if (pd) pd.bookmarked = true;
      }
    }

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

    // Scroll direction buttons
    document.querySelectorAll(".leh-scroll-dir-btn").forEach((btn) =>
      btn.classList.toggle("leh-dir-active", btn.getAttribute("data-dir") === autoScrollDirection)
    );

    // Sidebar state
    const sidebar = document.getElementById("leh-sidebar");
    if (sidebar) {
      sidebar.classList.toggle("leh-closed", !sidebarOpen);
      document.body.classList.toggle("leh-sidebar-open", sidebarOpen);
    }

    processAllPosts();
  }

  // ════════════════════════════════════════════════════════════════════
  //  KEYBOARD SHORTCUTS
  // ════════════════════════════════════════════════════════════════════

  function setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      // Don't trigger shortcuts when typing in inputs
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;

      if (e.ctrlKey && e.shiftKey && e.key === "L") {
        e.preventDefault();
        toggleSidebar();
      }
      if (e.ctrlKey && e.shiftKey && e.key === "S") {
        e.preventDefault();
        const el = document.getElementById("leh-autoscroll");
        if (el) {
          el.checked = !el.checked;
          el.dispatchEvent(new Event("change"));
        }
      }
      if (e.ctrlKey && e.shiftKey && e.key === "E") {
        e.preventDefault();
        extractTopPosts();
      }
      if (e.ctrlKey && e.shiftKey && e.key === "F") {
        e.preventDefault();
        if (!sidebarOpen) toggleSidebar();
        const searchEl = document.getElementById("leh-search");
        if (searchEl) searchEl.focus();
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════════════════════════════════

  function init() {
    createSidebar();
    loadSettings();
    setupObserver();
    setupNavigationListener();
    setupKeyboardShortcuts();

    setTimeout(processAllPosts, 800);
    setTimeout(() => processAllPosts(), 2500);
    setTimeout(() => processAllPosts(true), 5000);

    // Update session timer every 30s
    setInterval(() => {
      const el = document.getElementById("leh-stat-session");
      if (!el) return;
      const mins = Math.floor((Date.now() - sessionStart) / 60000);
      el.textContent = mins < 60 ? mins + "m" : Math.floor(mins / 60) + "h" + (mins % 60) + "m";
    }, 30000);

    // Scroll listener for processing new posts
    let scrollTimer = null;
    window.addEventListener("scroll", () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => processAllPosts(), 200);
    }, { passive: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
