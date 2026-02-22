/**
 * LinkedIn Engagement Highlighter V3 - Content Script
 *
 * Works on Feed, Activity, Company, and Search pages.
 * Features: 4-tier highlighting, score badges, date filtering,
 * extract & export with preview, smooth auto-scroll.
 *
 * Reads only visible DOM elements. No network requests.
 * No data collection. Purely a client-side visual layer.
 */

(function () {
  "use strict";

  // ─── State ───────────────────────────────────────────────────────────
  let enabled = true;
  let showScores = true;
  let mode = "percentile"; // "percentile" or "threshold"
  let absoluteThreshold = 100;
  let weights = { reactions: 5, comments: 10, reposts: 2 };
  let debounceTimer = null;

  const DEBOUNCE_MS = 300;

  // ─── Date filter state ───────────────────────────────────────────────
  let dateFilter = "all"; // "all" | "24h" | "7d" | "30d" | "90d" | "custom"
  let customDateFrom = "";
  let customDateTo = "";

  // ─── Auto-scroll state ───────────────────────────────────────────────
  let autoScrollEnabled = false;
  let autoScrollRafId = null;
  let autoScrollSpeed = 3;
  let lastScrollTime = 0;
  let showMoreHandled = false;

  const SCROLL_SPEEDS = [300, 600, 1200, 2200, 3500, 5500];

  // ─── Scoring cache ──────────────────────────────────────────────────
  const scoredCache = new WeakMap();
  let lastScoredPosts = [];

  // ─── Page Type Detection ────────────────────────────────────────────

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

  // ─── Number Parsing ─────────────────────────────────────────────────

  function parseCount(text) {
    if (!text) return 0;
    text = text.trim().replace(/,/g, "");
    const multipliers = { K: 1_000, M: 1_000_000, B: 1_000_000_000 };
    const match = text.match(/^([\d.]+)\s*([KMB])?$/i);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    if (isNaN(num)) return 0;
    const suffix = (match[2] || "").toUpperCase();
    return Math.round(num * (multipliers[suffix] || 1));
  }

  function extractFirstNumber(text) {
    if (!text) return 0;
    const match = text.match(/([\d,]+\.?\d*)\s*([KMB])?/i);
    if (!match) return 0;
    return parseCount(match[1].replace(/,/g, "") + (match[2] || ""));
  }

  function formatCount(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  }

  // ─── Post Detection ─────────────────────────────────────────────────

  /**
   * Unified post finder. Returns array of { element, type }.
   * Uses multiple selector strategies for resilience against LinkedIn DOM changes.
   */
  function findAllPosts() {
    const mainArea =
      document.querySelector("main") ||
      document.querySelector(".scaffold-layout__main") ||
      document.querySelector('[role="main"]') ||
      document.body;

    let posts = [];

    // Strategy 1: Known LinkedIn post class
    posts = Array.from(mainArea.querySelectorAll(".feed-shared-update-v2"));
    if (posts.length > 0) return deduplicatePosts(posts);

    // Strategy 2: Data URN attributes (activity posts)
    posts = Array.from(
      mainArea.querySelectorAll(
        'div[data-urn*="urn:li:activity"], div[data-urn*="urn:li:ugcPost"]'
      )
    );
    if (posts.length > 0) return deduplicatePosts(posts);

    // Strategy 3: Occludable update wrappers (LinkedIn's virtual scroll)
    posts = Array.from(mainArea.querySelectorAll(".occludable-update"));
    if (posts.length > 0) {
      // Get the inner post container if available
      const inner = posts
        .map((p) => p.querySelector(".feed-shared-update-v2") || p)
        .filter(Boolean);
      if (inner.length > 0) return deduplicatePosts(inner);
    }

    // Strategy 4: Walk up from social action bars
    const socialBars = mainArea.querySelectorAll(
      '.feed-shared-social-actions, .social-details-social-activity, [class*="social-action"]'
    );
    if (socialBars.length > 0) {
      const containers = [];
      for (const bar of socialBars) {
        let container = bar.parentElement;
        for (let i = 0; i < 6 && container; i++) {
          if (
            container.getAttribute("data-urn") ||
            container.getAttribute("data-id") ||
            container.classList.contains("feed-shared-update-v2") ||
            container.classList.contains("occludable-update")
          ) {
            containers.push(container);
            break;
          }
          container = container.parentElement;
        }
      }
      if (containers.length > 0) return deduplicatePosts(containers);
    }

    // Strategy 5: Walk up from social counts
    const countEls = mainArea.querySelectorAll(
      '.social-details-social-counts, [class*="social-counts"]'
    );
    if (countEls.length > 0) {
      const containers = [];
      for (const el of countEls) {
        let container = el;
        for (let i = 0; i < 7; i++) {
          container = container.parentElement;
          if (!container || container === mainArea || container === document.body) break;
          if (
            container.getAttribute("data-urn") ||
            container.getAttribute("data-id") ||
            container.classList.contains("feed-shared-update-v2")
          ) {
            containers.push(container);
            break;
          }
        }
      }
      if (containers.length > 0) return deduplicatePosts(containers);
    }

    // Strategy 6: Generic structural detection
    // Look for containers in main that have multiple buttons (social actions)
    const allDivs = mainArea.querySelectorAll(":scope > div > div");
    const candidates = [];
    for (const div of allDivs) {
      const buttons = div.querySelectorAll("button");
      if (buttons.length >= 3) {
        // Check if any button text suggests social actions
        let hasSocialAction = false;
        for (const btn of buttons) {
          const text = (btn.textContent || "").trim().toLowerCase();
          const label = (btn.getAttribute("aria-label") || "").toLowerCase();
          if (
            text.includes("like") || text.includes("comment") ||
            text.includes("repost") || text.includes("send") ||
            label.includes("like") || label.includes("comment") ||
            label.includes("react")
          ) {
            hasSocialAction = true;
            break;
          }
        }
        if (hasSocialAction) candidates.push(div);
      }
    }
    if (candidates.length > 0) return deduplicatePosts(candidates);

    return [];
  }

  /**
   * Removes nested/duplicate containers and returns { element, type } array.
   */
  function deduplicatePosts(elements) {
    const unique = elements.filter((el, idx) => {
      // Remove duplicates
      if (elements.indexOf(el) !== idx) return false;
      // Remove nested: if another element contains this one, skip it
      return !elements.some((other) => other !== el && other.contains(el));
    });
    return unique.map((el) => ({ element: el, type: "feed" }));
  }

  // ─── Engagement Extraction ──────────────────────────────────────────

  function extractEngagement(postInfo) {
    const postEl = postInfo.element;
    let reactions = 0;
    let comments = 0;
    let reposts = 0;

    // Strategy 1: Social counts container (most reliable)
    const socialCounts = postEl.querySelector(
      '.social-details-social-counts, [class*="social-counts"]'
    );
    if (socialCounts) {
      // Reactions count
      const reactionEl =
        socialCounts.querySelector(
          '.social-details-social-counts__reactions-count'
        ) ||
        socialCounts.querySelector('[data-control-name="reactions_count"]') ||
        socialCounts.querySelector('button[aria-label*="reaction"] span') ||
        socialCounts.querySelector('span[class*="reactions-count"]');
      if (reactionEl) {
        reactions = extractFirstNumber(reactionEl.textContent);
      }

      // If no specific element found, look at first numeric span in counts
      if (reactions === 0) {
        const spans = socialCounts.querySelectorAll("span");
        for (const span of spans) {
          const text = (span.textContent || "").trim();
          const num = extractFirstNumber(text);
          if (num > 0 && !text.toLowerCase().includes("comment") && !text.toLowerCase().includes("repost")) {
            reactions = num;
            break;
          }
        }
      }

      // Comments count
      const commentEls = socialCounts.querySelectorAll(
        'button[aria-label*="comment"], li[class*="comments"], button[class*="comments"]'
      );
      for (const el of commentEls) {
        const label = el.getAttribute("aria-label") || el.textContent || "";
        const numMatch = label.match(/([\d,.]+[KMB]?)\s*comment/i);
        if (numMatch) {
          comments = parseCount(numMatch[1].replace(/,/g, ""));
          break;
        }
        const fallback = label.match(/([\d,.]+[KMB]?)/);
        if (fallback && label.toLowerCase().includes("comment")) {
          comments = parseCount(fallback[1].replace(/,/g, ""));
          break;
        }
      }

      // Reposts count
      const repostEls = socialCounts.querySelectorAll(
        'button[aria-label*="repost"], li[class*="reposts"], button[class*="reposts"]'
      );
      for (const el of repostEls) {
        const label = el.getAttribute("aria-label") || el.textContent || "";
        const numMatch = label.match(/([\d,.]+[KMB]?)\s*repost/i);
        if (numMatch) {
          reposts = parseCount(numMatch[1].replace(/,/g, ""));
          break;
        }
        const fallback = label.match(/([\d,.]+[KMB]?)/);
        if (fallback && label.toLowerCase().includes("repost")) {
          reposts = parseCount(fallback[1].replace(/,/g, ""));
          break;
        }
      }

      // Fallback: scan all text in social counts for comment/repost patterns
      if (comments === 0 || reposts === 0) {
        const allCountEls = socialCounts.querySelectorAll("button, a, span, li");
        for (const el of allCountEls) {
          const text = (el.textContent || "").trim();
          if (comments === 0) {
            const cm = text.match(/([\d,.]+[KMB]?)\s*comment/i);
            if (cm) comments = parseCount(cm[1].replace(/,/g, ""));
          }
          if (reposts === 0) {
            const rm = text.match(/([\d,.]+[KMB]?)\s*repost/i);
            if (rm) reposts = parseCount(rm[1].replace(/,/g, ""));
          }
        }
      }
    }

    // Strategy 2: Scan all buttons with aria-labels
    if (reactions === 0 && comments === 0 && reposts === 0) {
      const buttons = postEl.querySelectorAll("button[aria-label]");
      for (const btn of buttons) {
        const label = (btn.getAttribute("aria-label") || "").toLowerCase();

        if (
          (label.includes("reaction") || label.includes("like")) &&
          !label.includes("unlike")
        ) {
          const m = label.match(/([\d,.]+[KMB]?)/i);
          if (m) reactions = Math.max(reactions, parseCount(m[1].replace(/,/g, "")));
        }
        if (label.includes("comment")) {
          const m = label.match(/([\d,.]+[KMB]?)/i);
          if (m) comments = Math.max(comments, parseCount(m[1].replace(/,/g, "")));
        }
        if (label.includes("repost") || label.includes("share")) {
          const m = label.match(/([\d,.]+[KMB]?)/i);
          if (m) reposts = Math.max(reposts, parseCount(m[1].replace(/,/g, "")));
        }
      }
    }

    // Strategy 3: Broad text scan for engagement patterns
    if (reactions === 0 && comments === 0 && reposts === 0) {
      const textNodes = postEl.querySelectorAll("span, button, a");
      for (const node of textNodes) {
        if (node.children.length > 5) continue;
        const text = (node.textContent || "").trim();
        if (text.length > 100) continue;

        if (reactions === 0) {
          const rm = text.match(/([\d,.]+[KMB]?)\s*(?:reactions?|likes?)/i);
          if (rm) reactions = parseCount(rm[1].replace(/,/g, ""));
        }
        if (comments === 0) {
          const cm = text.match(/([\d,.]+[KMB]?)\s*comments?/i);
          if (cm) comments = parseCount(cm[1].replace(/,/g, ""));
        }
        if (reposts === 0) {
          const rp = text.match(/([\d,.]+[KMB]?)\s*reposts?/i);
          if (rp) reposts = parseCount(rp[1].replace(/,/g, ""));
        }
      }
    }

    // Strategy 4: Look for the reactions count near emoji images
    if (reactions === 0) {
      const imgs = postEl.querySelectorAll(
        'img[class*="reactions-icon"], img[src*="reactions"], img[alt*="reaction"]'
      );
      for (const img of imgs) {
        const parent = img.parentElement;
        if (parent) {
          const text = (parent.textContent || "").trim();
          const num = extractFirstNumber(text);
          if (num > 0) {
            reactions = num;
            break;
          }
          // Check siblings
          const sibling = parent.nextElementSibling || parent.parentElement;
          if (sibling) {
            const sibText = (sibling.textContent || "").trim();
            const sibNum = extractFirstNumber(sibText);
            if (sibNum > 0) {
              reactions = sibNum;
              break;
            }
          }
        }
      }
    }

    return { reactions, comments, reposts };
  }

  // ─── Date Extraction ────────────────────────────────────────────────

  /**
   * Extracts the post date from <time> elements or relative time text.
   * Returns a Date object or null.
   */
  function extractPostDate(postEl) {
    // Strategy 1: <time> element with datetime attribute
    const timeEl = postEl.querySelector("time[datetime]");
    if (timeEl) {
      const dt = timeEl.getAttribute("datetime");
      if (dt) {
        const date = new Date(dt);
        if (!isNaN(date.getTime())) return date;
      }
    }

    // Strategy 2: <time> element text content (relative time)
    const timeEls = postEl.querySelectorAll("time");
    for (const t of timeEls) {
      const text = (t.textContent || "").trim().toLowerCase();
      const parsed = parseRelativeTime(text);
      if (parsed) return parsed;
    }

    // Strategy 3: Scan for relative time patterns in actor description
    const descEls = postEl.querySelectorAll(
      '.feed-shared-actor__sub-description, [class*="actor__sub-description"], span[class*="update-components-actor"]'
    );
    for (const el of descEls) {
      const text = (el.textContent || "").trim().toLowerCase();
      const parsed = parseRelativeTime(text);
      if (parsed) return parsed;
    }

    // Strategy 4: Broader scan for time patterns
    const spans = postEl.querySelectorAll("span");
    for (const span of spans) {
      const text = (span.textContent || "").trim();
      if (text.length > 20 || text.length < 2) continue;
      const parsed = parseRelativeTime(text.toLowerCase());
      if (parsed) return parsed;
    }

    return null;
  }

  /**
   * Parses LinkedIn's relative time strings into Date objects.
   * Handles: "2d", "1w", "3mo", "1yr", "5h", "30m", "Just now", "2d ago", etc.
   */
  function parseRelativeTime(text) {
    if (!text) return null;
    text = text.trim().toLowerCase().replace("ago", "").replace("edited", "").replace("•", "").trim();

    if (text === "now" || text === "just now") return new Date();

    const now = new Date();
    let match;

    // Minutes
    match = text.match(/^(\d+)\s*m(?:in)?s?$/);
    if (match) return new Date(now.getTime() - parseInt(match[1]) * 60 * 1000);

    // Hours
    match = text.match(/^(\d+)\s*h(?:r|our)?s?$/);
    if (match) return new Date(now.getTime() - parseInt(match[1]) * 3600 * 1000);

    // Days
    match = text.match(/^(\d+)\s*d(?:ay)?s?$/);
    if (match) return new Date(now.getTime() - parseInt(match[1]) * 86400 * 1000);

    // Weeks
    match = text.match(/^(\d+)\s*w(?:eek|k)?s?$/);
    if (match) return new Date(now.getTime() - parseInt(match[1]) * 7 * 86400 * 1000);

    // Months
    match = text.match(/^(\d+)\s*mo(?:nth)?s?$/);
    if (match) return new Date(now.getTime() - parseInt(match[1]) * 30 * 86400 * 1000);

    // Years
    match = text.match(/^(\d+)\s*y(?:r|ear)?s?$/);
    if (match) return new Date(now.getTime() - parseInt(match[1]) * 365 * 86400 * 1000);

    return null;
  }

  // ─── Post Metadata Extraction ───────────────────────────────────────

  function extractPostMeta(postInfo) {
    const postEl = postInfo.element;
    let username = "";
    let displayName = "";
    let postUrl = "";
    let caption = "";
    let date = null;

    // ── Username / Display Name ──
    // Strategy 1: Actor name element
    const actorEl = postEl.querySelector(
      '.feed-shared-actor__name, [class*="actor__name"], .update-components-actor__name'
    );
    if (actorEl) {
      displayName = (actorEl.textContent || "").trim().replace(/\s+/g, " ");
    }

    // Strategy 2: Profile link
    const profileLinks = postEl.querySelectorAll('a[href*="/in/"]');
    for (const link of profileLinks) {
      const href = link.getAttribute("href") || "";
      const userMatch = href.match(/\/in\/([A-Za-z0-9_-]+)/);
      if (userMatch) {
        username = userMatch[1];
        if (!displayName) {
          displayName = (link.textContent || "").trim().replace(/\s+/g, " ");
        }
        break;
      }
    }

    // Strategy 3: Company page link
    if (!username) {
      const companyLinks = postEl.querySelectorAll('a[href*="/company/"]');
      for (const link of companyLinks) {
        const href = link.getAttribute("href") || "";
        const compMatch = href.match(/\/company\/([A-Za-z0-9_-]+)/);
        if (compMatch) {
          username = compMatch[1];
          if (!displayName) {
            displayName = (link.textContent || "").trim().replace(/\s+/g, " ");
          }
          break;
        }
      }
    }

    // On activity pages, the profile owner is the author
    if (!username) {
      const pageType = getPageType();
      if (pageType === "activity" || pageType === "profile") {
        const pathMatch = window.location.pathname.match(/\/in\/([A-Za-z0-9_-]+)/);
        if (pathMatch) username = pathMatch[1];
      }
    }

    // ── Post URL ──
    // Strategy 1: data-urn attribute → construct URL
    const urn = postEl.getAttribute("data-urn") || postEl.getAttribute("data-id") || "";
    if (urn && urn.includes("urn:li:")) {
      postUrl = "https://www.linkedin.com/feed/update/" + urn;
    }

    // Strategy 2: Timestamp link
    if (!postUrl) {
      const timeLink = postEl.querySelector("time");
      if (timeLink) {
        const parentLink = timeLink.closest("a[href]");
        if (parentLink) {
          const href = parentLink.getAttribute("href") || "";
          postUrl = href.startsWith("http")
            ? href
            : "https://www.linkedin.com" + href;
        }
      }
    }

    // Strategy 3: Any permalink-like link
    if (!postUrl) {
      const postLinks = postEl.querySelectorAll(
        'a[href*="/feed/update/"], a[href*="/posts/"]'
      );
      for (const link of postLinks) {
        const href = link.getAttribute("href") || "";
        postUrl = href.startsWith("http")
          ? href
          : "https://www.linkedin.com" + href;
        break;
      }
    }

    // ── Caption / Post Text ──
    const textEl = postEl.querySelector(
      '.update-components-text, .feed-shared-text, [class*="update-components-text"]'
    );
    if (textEl) {
      caption = (textEl.textContent || "").trim().replace(/\s+/g, " ");
      if (caption.length > 200) caption = caption.substring(0, 197) + "...";
    }

    if (!caption) {
      const dirSpans = postEl.querySelectorAll('span[dir="ltr"], span[dir="auto"]');
      for (const span of dirSpans) {
        const text = (span.textContent || "").trim();
        if (text.length > 20 && text.length < 2000) {
          caption = text.length > 200 ? text.substring(0, 197) + "..." : text;
          break;
        }
      }
    }

    // ── Date ──
    date = extractPostDate(postEl);

    return {
      username: username || displayName || "",
      postUrl,
      caption,
      date,
    };
  }

  // ─── Scoring ────────────────────────────────────────────────────────

  function calculateScore(engagement) {
    return (
      engagement.reactions * weights.reactions +
      engagement.comments * weights.comments +
      engagement.reposts * weights.reposts
    );
  }

  // ─── Highlighting ───────────────────────────────────────────────────

  function clearHighlights() {
    document
      .querySelectorAll(".leh-tier1, .leh-tier2")
      .forEach((el) => el.classList.remove("leh-tier1", "leh-tier2"));
    document
      .querySelectorAll(".leh-score-badge")
      .forEach((el) => el.remove());
  }

  function applyHighlights(scoredPosts) {
    if (scoredPosts.length === 0) return;

    if (mode === "percentile") {
      const sorted = [...scoredPosts].sort((a, b) => b.score - a.score);
      const top10Index = Math.max(1, Math.ceil(sorted.length * 0.1));
      const medianIndex = Math.floor(sorted.length / 2);
      const top10Threshold = sorted[top10Index - 1]?.score ?? Infinity;
      const medianThreshold = sorted[medianIndex]?.score ?? 0;

      for (const item of scoredPosts) {
        item.element.classList.remove("leh-tier1", "leh-tier2");
        if (item.score >= top10Threshold && item.score > 0) {
          item.element.classList.add("leh-tier1");
        } else if (item.score >= medianThreshold && item.score > 0) {
          item.element.classList.add("leh-tier2");
        }
        if (showScores) addScoreBadge(item, scoredPosts);
      }
    } else {
      for (const item of scoredPosts) {
        item.element.classList.remove("leh-tier1", "leh-tier2");
        if (item.score >= absoluteThreshold * 2) {
          item.element.classList.add("leh-tier1");
        } else if (item.score >= absoluteThreshold) {
          item.element.classList.add("leh-tier2");
        }
        if (showScores) addScoreBadge(item, scoredPosts);
      }
    }
  }

  /**
   * 4-tier color system: gold (top 10%), green (top 30%), blue (top 60%), gray (rest)
   */
  function getScoreColor(item, allScored) {
    if (item.score === 0) return "gray";
    const rank = allScored.filter((s) => s.score > item.score).length;
    const pct = rank / allScored.length;
    if (pct < 0.1) return "gold";
    if (pct < 0.3) return "green";
    if (pct < 0.6) return "blue";
    return "gray";
  }

  function addScoreBadge(item, allScored) {
    const existing = item.element.querySelector(".leh-score-badge");
    if (existing) existing.remove();
    if (!showScores) return;

    const badge = document.createElement("div");
    const colorTier = allScored ? getScoreColor(item, allScored) : "gray";
    badge.className = "leh-score-badge leh-color-" + colorTier;

    const parts = [];
    if (item.engagement.reactions > 0)
      parts.push("\ud83d\udc4d " + formatCount(item.engagement.reactions));
    if (item.engagement.comments > 0)
      parts.push("\ud83d\udcac " + formatCount(item.engagement.comments));
    if (item.engagement.reposts > 0)
      parts.push("\ud83d\udd01 " + formatCount(item.engagement.reposts));

    const breakdown = parts.length > 0 ? parts.join("  ") : "no data";
    badge.innerHTML =
      '<span class="leh-badge-score">' +
      item.score.toLocaleString() +
      '</span><span class="leh-badge-detail">' +
      breakdown +
      "</span>";

    const computedStyle = window.getComputedStyle(item.element);
    if (computedStyle.position === "static") {
      item.element.style.position = "relative";
    }

    item.element.appendChild(badge);
  }

  // ─── Date Filtering ─────────────────────────────────────────────────

  function isPostInDateRange(date) {
    if (dateFilter === "all" || !date) return true;

    const now = new Date();
    let cutoff;

    switch (dateFilter) {
      case "24h":
        cutoff = new Date(now.getTime() - 24 * 3600 * 1000);
        break;
      case "7d":
        cutoff = new Date(now.getTime() - 7 * 86400 * 1000);
        break;
      case "30d":
        cutoff = new Date(now.getTime() - 30 * 86400 * 1000);
        break;
      case "90d":
        cutoff = new Date(now.getTime() - 90 * 86400 * 1000);
        break;
      case "custom": {
        const from = customDateFrom ? new Date(customDateFrom) : null;
        const to = customDateTo ? new Date(customDateTo + "T23:59:59") : null;
        if (from && date < from) return false;
        if (to && date > to) return false;
        return true;
      }
      default:
        return true;
    }

    return date >= cutoff;
  }

  // ─── Main Processing ────────────────────────────────────────────────

  function processAllPosts(forceRefresh) {
    if (!enabled) {
      clearHighlights();
      return;
    }

    const posts = findAllPosts();
    let hasNew = false;
    const allScored = [];

    for (const postInfo of posts) {
      const cached = !forceRefresh && scoredCache.get(postInfo.element);
      if (cached) {
        allScored.push(cached);
        continue;
      }

      hasNew = true;
      const engagement = extractEngagement(postInfo);
      const score = calculateScore(engagement);
      const date = extractPostDate(postInfo.element);
      const entry = {
        element: postInfo.element,
        type: postInfo.type,
        score,
        engagement,
        date,
      };
      scoredCache.set(postInfo.element, entry);
      allScored.push(entry);
    }

    if (!hasNew && !forceRefresh && lastScoredPosts.length === allScored.length) {
      return;
    }

    // Apply date filter
    const filtered = allScored.filter((item) => isPostInDateRange(item.date));

    // Dim posts that are outside the date range (but don't remove badges from them)
    for (const item of allScored) {
      if (!filtered.includes(item)) {
        item.element.classList.remove("leh-tier1", "leh-tier2");
        const existingBadge = item.element.querySelector(".leh-score-badge");
        if (existingBadge) existingBadge.remove();
        item.element.style.opacity = dateFilter === "all" ? "" : "0.4";
      } else {
        item.element.style.opacity = "";
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
    if (dateFilter === "all") {
      el.textContent = "";
      el.style.display = "none";
    } else {
      el.textContent = shown + " of " + total + " posts match filter";
      el.style.display = "block";
    }
  }

  function debouncedProcess() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processAllPosts, DEBOUNCE_MS);
  }

  // ─── MutationObserver ───────────────────────────────────────────────

  function setupObserver() {
    const feedContainer =
      document.querySelector("main") ||
      document.querySelector(".scaffold-layout__main") ||
      document.querySelector(".scaffold-finite-scroll__content") ||
      document.body;

    const observer = new MutationObserver((mutations) => {
      let hasNewContent = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          hasNewContent = true;
          break;
        }
      }
      if (hasNewContent) debouncedProcess();
    });

    observer.observe(feedContainer, { childList: true, subtree: true });
    return observer;
  }

  // ─── SPA Navigation ────────────────────────────────────────────────

  let lastUrl = window.location.href;

  function setupNavigationListener() {
    setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        setTimeout(() => {
          processAllPosts(true);
          updateExtractCount();
          updatePageIndicator();
        }, 1500);
      }
    }, 500);
  }

  // ─── Auto-scroll ───────────────────────────────────────────────────

  function startAutoScroll() {
    if (autoScrollRafId) return;
    lastScrollTime = performance.now();
    showMoreHandled = false;

    function scrollStep(now) {
      if (!autoScrollEnabled) {
        autoScrollRafId = null;
        return;
      }

      const delta = now - lastScrollTime;
      lastScrollTime = now;
      const pxPerSec = SCROLL_SPEEDS[Math.min(autoScrollSpeed - 1, 5)] || 1200;
      const px = (pxPerSec * delta) / 1000;
      const variance = 1 + Math.sin(now / 800) * 0.15;
      window.scrollBy({ top: px * variance, behavior: "instant" });

      // Check for bottom / show more
      const atBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 150;
      if (atBottom && !showMoreHandled) {
        handleShowMore();
      }

      autoScrollRafId = requestAnimationFrame(scrollStep);
    }

    autoScrollRafId = requestAnimationFrame(scrollStep);

    // Periodically check for show-more buttons mid-feed
    if (!autoScrollEnabled._pollId) {
      autoScrollEnabled._pollId = setInterval(() => {
        if (!autoScrollEnabled) return;
        const btn = findShowMoreButton();
        if (btn && !showMoreHandled) handleShowMore();
      }, 3000);
    }
  }

  function stopAutoScroll() {
    if (autoScrollRafId) {
      cancelAnimationFrame(autoScrollRafId);
      autoScrollRafId = null;
    }
    if (autoScrollEnabled._pollId) {
      clearInterval(autoScrollEnabled._pollId);
      autoScrollEnabled._pollId = null;
    }
  }

  function findShowMoreButton() {
    const candidates = Array.from(
      document.querySelectorAll('button, a[role="button"]')
    );
    for (const el of candidates) {
      const text = (el.textContent || "").trim().toLowerCase();
      if (
        text.includes("show more") ||
        text.includes("load more") ||
        text.includes("see more activity") ||
        text.includes("show more results")
      ) {
        return el;
      }
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
      setTimeout(() => {
        showMoreHandled = false;
      }, 2000);
    }, 1200);
  }

  // ─── Control Panel ─────────────────────────────────────────────────

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
        </div>
        <button class="leh-panel-collapse" title="Minimize">\u2212</button>
      </div>
      <div class="leh-panel-body">
        <div id="leh-page-type" class="leh-page-indicator">Feed</div>

        <!-- Section: Highlighter -->
        <div class="leh-section">
          <div class="leh-section-header" data-section="highlighter">
            <span>Highlighter</span>
            <span class="leh-chevron">\u25BE</span>
          </div>
          <div class="leh-section-body">
            <div class="leh-control-row">
              <span class="leh-label-text">Highlight posts</span>
              <label class="leh-toggle">
                <input type="checkbox" id="leh-enabled" checked />
                <span class="leh-toggle-slider"></span>
              </label>
            </div>
            <div class="leh-control-row">
              <span class="leh-label-text">Score badges</span>
              <label class="leh-toggle">
                <input type="checkbox" id="leh-show-scores" checked />
                <span class="leh-toggle-slider"></span>
              </label>
            </div>
            <div class="leh-control-row">
              <span class="leh-label-text">Mode</span>
              <select id="leh-mode" class="leh-select">
                <option value="percentile">Percentile (auto)</option>
                <option value="threshold">Fixed threshold</option>
              </select>
            </div>
            <div class="leh-control-row leh-threshold-row" style="display:none;">
              <span class="leh-label-text">Threshold</span>
              <input type="range" id="leh-threshold" min="10" max="5000" value="100" step="10" class="leh-range" />
              <span id="leh-threshold-val" class="leh-range-val">100</span>
            </div>
          </div>
        </div>

        <!-- Section: Score Weights -->
        <div class="leh-section">
          <div class="leh-section-header" data-section="weights">
            <span>Score Weights</span>
            <span class="leh-chevron">\u25BE</span>
          </div>
          <div class="leh-section-body">
            <div class="leh-help-text">Higher = counts more toward score</div>
            <div class="leh-control-row">
              <span class="leh-label-text">\ud83d\udc4d Reactions</span>
              <input type="number" id="leh-w-reactions" value="5" min="0" max="20" step="1" class="leh-num-input" />
            </div>
            <div class="leh-control-row">
              <span class="leh-label-text">\ud83d\udcac Comments</span>
              <input type="number" id="leh-w-comments" value="10" min="0" max="20" step="1" class="leh-num-input" />
            </div>
            <div class="leh-control-row">
              <span class="leh-label-text">\ud83d\udd01 Reposts</span>
              <input type="number" id="leh-w-reposts" value="2" min="0" max="20" step="1" class="leh-num-input" />
            </div>
            <button id="leh-recalculate" class="leh-btn leh-btn-secondary">Recalculate</button>
          </div>
        </div>

        <!-- Section: Date Filter -->
        <div class="leh-section">
          <div class="leh-section-header" data-section="datefilter">
            <span>Date Filter</span>
            <span class="leh-chevron">\u25BE</span>
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
              <div class="leh-control-row">
                <span class="leh-label-text">From</span>
                <input type="date" id="leh-date-from" class="leh-date-input" />
              </div>
              <div class="leh-control-row">
                <span class="leh-label-text">To</span>
                <input type="date" id="leh-date-to" class="leh-date-input" />
              </div>
            </div>
            <div id="leh-filter-count" class="leh-filter-count" style="display:none;"></div>
          </div>
        </div>

        <!-- Section: Auto-scroll -->
        <div class="leh-section">
          <div class="leh-section-header" data-section="autoscroll">
            <span>Auto-scroll</span>
            <span class="leh-chevron">\u25BE</span>
          </div>
          <div class="leh-section-body">
            <div class="leh-control-row">
              <span class="leh-label-text">Enable</span>
              <label class="leh-toggle">
                <input type="checkbox" id="leh-autoscroll" />
                <span class="leh-toggle-slider"></span>
              </label>
            </div>
            <div class="leh-control-row">
              <span class="leh-label-text">Speed</span>
              <input type="range" id="leh-scroll-speed" min="1" max="6" value="3" step="1" class="leh-range" />
              <span id="leh-scroll-speed-val" class="leh-range-val">3</span>
            </div>
            <div class="leh-help-text">Smooth scroll with auto-pause on "Show more" prompts. Speed 1 = gentle, 6 = turbo.</div>
          </div>
        </div>

        <!-- Section: Extract & Export -->
        <div class="leh-section">
          <div class="leh-section-header" data-section="extract">
            <span>Extract &amp; Export</span>
            <span class="leh-chevron">\u25BE</span>
          </div>
          <div class="leh-section-body">
            <div class="leh-control-row">
              <span class="leh-label-text">Show top</span>
              <select id="leh-export-count" class="leh-select">
                <option value="5">5 posts</option>
                <option value="10" selected>10 posts</option>
                <option value="25">25 posts</option>
                <option value="50">50 posts</option>
                <option value="100">100 posts</option>
                <option value="150">150 posts</option>
                <option value="all">All scored</option>
              </select>
            </div>
            <button id="leh-extract" class="leh-btn leh-btn-primary">Extract Top Posts</button>
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
    // ── Collapse panel ──
    let collapsed = false;
    const collapseBtn = panel.querySelector(".leh-panel-collapse");
    const panelBody = panel.querySelector(".leh-panel-body");

    collapseBtn.addEventListener("click", () => {
      collapsed = !collapsed;
      panelBody.style.display = collapsed ? "none" : "block";
      collapseBtn.textContent = collapsed ? "+" : "\u2212";
      panel.classList.toggle("leh-collapsed", collapsed);
    });

    // ── Section collapse ──
    const sectionHeaders = panel.querySelectorAll(".leh-section-header");
    for (const header of sectionHeaders) {
      header.addEventListener("click", () => {
        const body = header.nextElementSibling;
        const chevron = header.querySelector(".leh-chevron");
        const isOpen = body.style.display !== "none";
        body.style.display = isOpen ? "none" : "block";
        chevron.textContent = isOpen ? "\u25B8" : "\u25BE";
        header.classList.toggle("leh-section-closed", isOpen);
      });
    }

    // ── Drag support ──
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    const header = panel.querySelector(".leh-panel-header");

    header.addEventListener("mousedown", (e) => {
      if (e.target.closest(".leh-panel-collapse")) return;
      isDragging = true;
      dragOffsetX = e.clientX - panel.getBoundingClientRect().left;
      dragOffsetY = e.clientY - panel.getBoundingClientRect().top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      panel.style.right = "auto";
      panel.style.left = e.clientX - dragOffsetX + "px";
      panel.style.top = e.clientY - dragOffsetY + "px";
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
    });

    // ── Highlighter controls ──
    document.getElementById("leh-enabled").addEventListener("change", (e) => {
      enabled = e.target.checked;
      processAllPosts();
      saveSettings();
    });

    document.getElementById("leh-show-scores").addEventListener("change", (e) => {
      showScores = e.target.checked;
      processAllPosts();
      saveSettings();
    });

    document.getElementById("leh-mode").addEventListener("change", (e) => {
      mode = e.target.value;
      const thresholdRow = panel.querySelector(".leh-threshold-row");
      thresholdRow.style.display = mode === "threshold" ? "flex" : "none";
      processAllPosts(true);
      saveSettings();
    });

    document.getElementById("leh-threshold").addEventListener("input", (e) => {
      absoluteThreshold = parseInt(e.target.value, 10);
      document.getElementById("leh-threshold-val").textContent = absoluteThreshold;
      saveSettings();
    });

    document.getElementById("leh-threshold").addEventListener("change", () => {
      processAllPosts(true);
    });

    // ── Weight controls ──
    document.getElementById("leh-w-reactions").addEventListener("change", (e) => {
      weights.reactions = parseFloat(e.target.value) || 0;
      processAllPosts(true);
      saveSettings();
    });

    document.getElementById("leh-w-comments").addEventListener("change", (e) => {
      weights.comments = parseFloat(e.target.value) || 0;
      processAllPosts(true);
      saveSettings();
    });

    document.getElementById("leh-w-reposts").addEventListener("change", (e) => {
      weights.reposts = parseFloat(e.target.value) || 0;
      processAllPosts(true);
      saveSettings();
    });

    document.getElementById("leh-recalculate").addEventListener("click", () => {
      processAllPosts(true);
    });

    // ── Date filter controls ──
    document.getElementById("leh-date-filter").addEventListener("change", (e) => {
      dateFilter = e.target.value;
      const customSection = document.getElementById("leh-date-custom");
      customSection.style.display = dateFilter === "custom" ? "block" : "none";
      processAllPosts(true);
      saveSettings();
    });

    document.getElementById("leh-date-from").addEventListener("change", (e) => {
      customDateFrom = e.target.value;
      processAllPosts(true);
      saveSettings();
    });

    document.getElementById("leh-date-to").addEventListener("change", (e) => {
      customDateTo = e.target.value;
      processAllPosts(true);
      saveSettings();
    });

    // ── Auto-scroll controls ──
    document.getElementById("leh-autoscroll").addEventListener("change", (e) => {
      autoScrollEnabled = e.target.checked;
      if (autoScrollEnabled) {
        startAutoScroll();
      } else {
        stopAutoScroll();
      }
      saveSettings();
    });

    document.getElementById("leh-scroll-speed").addEventListener("input", (e) => {
      autoScrollSpeed = parseInt(e.target.value, 10);
      document.getElementById("leh-scroll-speed-val").textContent = autoScrollSpeed;
      saveSettings();
    });

    // ── Extract ──
    document.getElementById("leh-extract").addEventListener("click", () => {
      extractTopPosts();
    });
  }

  // ─── Page Indicator ─────────────────────────────────────────────────

  function updatePageIndicator() {
    const el = document.getElementById("leh-page-type");
    if (!el) return;
    const pageType = getPageType();
    const labels = {
      feed: "Feed",
      activity: "Activity",
      company: "Company",
      search: "Search",
      profile: "Profile",
      post: "Post",
    };
    el.textContent = labels[pageType] || pageType;
  }

  // ─── Extract & Export ───────────────────────────────────────────────

  function updateExtractCount() {
    const countEl = document.getElementById("leh-extract-count");
    if (!countEl) return;
    const posts = findAllPosts();
    const pageType = getPageType();
    const label =
      pageType === "activity" ? "on activity" :
      pageType === "company" ? "on company" :
      pageType === "search" ? "in results" :
      "in feed";
    countEl.textContent =
      posts.length + " post" + (posts.length !== 1 ? "s" : "") + " detected " + label;
  }

  function extractTopPosts() {
    const posts = findAllPosts();
    const scored = [];

    for (const postInfo of posts) {
      const engagement = extractEngagement(postInfo);
      const score = calculateScore(engagement);
      const meta = extractPostMeta(postInfo);

      // Apply date filter
      if (!isPostInDateRange(meta.date)) continue;

      scored.push({
        ...meta,
        reactions: engagement.reactions,
        comments: engagement.comments,
        reposts: engagement.reposts,
        score,
      });
    }

    scored.sort((a, b) => b.score - a.score);

    const countSel = document.getElementById("leh-export-count");
    const countVal = countSel ? countSel.value : "10";
    const limit = countVal === "all" ? scored.length : parseInt(countVal, 10);
    const topPosts = scored.slice(0, limit);

    updateExtractCount();
    showExportModal(topPosts, scored.length);
  }

  function showExportModal(posts, totalScored) {
    const existing = document.getElementById("leh-export-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "leh-export-modal";
    overlay.className = "leh-modal-overlay";

    let tableRows = "";
    posts.forEach((p, i) => {
      const user = p.username || "unknown";
      const link = p.postUrl
        ? '<a href="' +
          p.postUrl +
          '" target="_blank" rel="noopener noreferrer" class="leh-modal-link">' +
          (p.postUrl.length > 50 ? p.postUrl.substring(0, 47) + "..." : p.postUrl) +
          "</a>"
        : "N/A";
      const dateStr = p.date
        ? p.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "\u2014";
      const cap = p.caption
        ? '<span class="leh-modal-caption">' +
          p.caption.replace(/</g, "&lt;").replace(/>/g, "&gt;") +
          "</span>"
        : "";

      tableRows +=
        "<tr>" +
        '<td class="leh-modal-rank">' + (i + 1) + "</td>" +
        '<td class="leh-modal-user">' + user.replace(/</g, "&lt;") + "</td>" +
        '<td class="leh-modal-metrics">' + formatCount(p.reactions) + "</td>" +
        '<td class="leh-modal-metrics">' + formatCount(p.comments) + "</td>" +
        '<td class="leh-modal-metrics">' + formatCount(p.reposts) + "</td>" +
        '<td class="leh-modal-score">' + p.score.toLocaleString() + "</td>" +
        '<td class="leh-modal-date">' + dateStr + "</td>" +
        '<td class="leh-modal-link-cell">' + link + "</td>" +
        "</tr>" +
        (cap
          ? '<tr class="leh-caption-row"><td></td><td colspan="7">' + cap + "</td></tr>"
          : "");
    });

    overlay.innerHTML =
      '<div class="leh-modal">' +
      '<div class="leh-modal-header">' +
      '<span class="leh-modal-title">Top ' +
      posts.length +
      " Posts (of " +
      totalScored +
      " scored)</span>" +
      '<button class="leh-modal-close" title="Close">&times;</button>' +
      "</div>" +
      '<div class="leh-modal-actions">' +
      '<button id="leh-copy-text" class="leh-btn leh-btn-sm">Copy as Text</button>' +
      '<button id="leh-copy-json" class="leh-btn leh-btn-sm">Copy JSON</button>' +
      '<button id="leh-download-csv" class="leh-btn leh-btn-sm">Download CSV</button>' +
      "</div>" +
      '<div class="leh-modal-body">' +
      '<table class="leh-modal-table">' +
      "<thead><tr>" +
      "<th>#</th><th>Author</th><th>Reactions</th><th>Comments</th><th>Reposts</th><th>Score</th><th>Date</th><th>Link</th>" +
      "</tr></thead>" +
      "<tbody>" +
      tableRows +
      "</tbody></table>" +
      (posts.length === 0
        ? '<div class="leh-modal-empty">No posts found. Try scrolling through the feed first to load more posts.</div>'
        : "") +
      "</div>" +
      "</div>";

    document.body.appendChild(overlay);

    // ── Close ──
    overlay.querySelector(".leh-modal-close").addEventListener("click", () => {
      overlay.remove();
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // ── Copy as Text ──
    document.getElementById("leh-copy-text").addEventListener("click", () => {
      const lines = posts.map((p, i) => {
        const parts = [];
        if (p.reactions > 0) parts.push(formatCount(p.reactions) + " reactions");
        if (p.comments > 0) parts.push(formatCount(p.comments) + " comments");
        if (p.reposts > 0) parts.push(formatCount(p.reposts) + " reposts");
        const dateStr = p.date
          ? " [" + p.date.toLocaleDateString() + "]"
          : "";
        let line =
          (i + 1) +
          ". " +
          (p.username || "unknown") +
          " \u2014 Score: " +
          p.score.toLocaleString() +
          " (" +
          parts.join(", ") +
          ")" +
          dateStr;
        if (p.postUrl) line += "\n   " + p.postUrl;
        if (p.caption) line += '\n   "' + p.caption + '"';
        return line;
      });
      const text =
        "LinkedIn Top " +
        posts.length +
        " Posts\n" +
        "=".repeat(40) +
        "\n\n" +
        lines.join("\n\n");
      navigator.clipboard.writeText(text).then(() => {
        flashButton("leh-copy-text", "Copied!");
      });
    });

    // ── Copy JSON ──
    document.getElementById("leh-copy-json").addEventListener("click", () => {
      const data = posts.map((p, i) => ({
        rank: i + 1,
        author: p.username || null,
        postUrl: p.postUrl || null,
        caption: p.caption || null,
        date: p.date ? p.date.toISOString() : null,
        reactions: p.reactions,
        comments: p.comments,
        reposts: p.reposts,
        score: p.score,
      }));
      navigator.clipboard
        .writeText(JSON.stringify(data, null, 2))
        .then(() => {
          flashButton("leh-copy-json", "Copied!");
        });
    });

    // ── Download CSV ──
    document.getElementById("leh-download-csv").addEventListener("click", () => {
      const csvHeader =
        "Rank,Author,Reactions,Comments,Reposts,Score,Date,Post URL,Caption";
      const rows = posts.map((p, i) => {
        const escapeCsv = (val) => {
          const s = String(val ?? "");
          return s.includes(",") || s.includes('"') || s.includes("\n")
            ? '"' + s.replace(/"/g, '""') + '"'
            : s;
        };
        return [
          i + 1,
          escapeCsv(p.username || ""),
          p.reactions,
          p.comments,
          p.reposts,
          p.score,
          p.date ? p.date.toISOString().slice(0, 10) : "",
          escapeCsv(p.postUrl || ""),
          escapeCsv(p.caption || ""),
        ].join(",");
      });
      const csv = csvHeader + "\n" + rows.join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        "linkedin-top-posts-" +
        new Date().toISOString().slice(0, 10) +
        ".csv";
      a.click();
      URL.revokeObjectURL(url);
      flashButton("leh-download-csv", "Downloaded!");
    });
  }

  function flashButton(id, text) {
    const btn = document.getElementById(id);
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = text;
    btn.classList.add("leh-btn-flash");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("leh-btn-flash");
    }, 1500);
  }

  // ─── Settings Persistence ──────────────────────────────────────────

  function saveSettings() {
    try {
      chrome.storage.local.set({
        lehSettingsV3: {
          enabled,
          showScores,
          mode,
          absoluteThreshold,
          weights,
          autoScrollSpeed,
          dateFilter,
          customDateFrom,
          customDateTo,
        },
      });
    } catch {
      // storage unavailable
    }
  }

  function loadSettings() {
    try {
      chrome.storage.local.get("lehSettingsV3", (result) => {
        if (!result || !result.lehSettingsV3) return;
        const s = result.lehSettingsV3;

        enabled = s.enabled ?? true;
        showScores = s.showScores ?? true;
        mode = s.mode ?? "percentile";
        absoluteThreshold = s.absoluteThreshold ?? 100;
        weights = s.weights ?? { reactions: 5, comments: 10, reposts: 2 };
        autoScrollSpeed = s.autoScrollSpeed ?? 3;
        dateFilter = s.dateFilter ?? "all";
        customDateFrom = s.customDateFrom ?? "";
        customDateTo = s.customDateTo ?? "";

        // Update UI
        const el = (id) => document.getElementById(id);

        const enabledEl = el("leh-enabled");
        const showScoresEl = el("leh-show-scores");
        const modeEl = el("leh-mode");
        const thresholdEl = el("leh-threshold");
        const thresholdValEl = el("leh-threshold-val");
        const wReactionsEl = el("leh-w-reactions");
        const wCommentsEl = el("leh-w-comments");
        const wRepostsEl = el("leh-w-reposts");
        const thresholdRow = document.querySelector(".leh-threshold-row");
        const scrollSpeedEl = el("leh-scroll-speed");
        const scrollSpeedValEl = el("leh-scroll-speed-val");
        const dateFilterEl = el("leh-date-filter");
        const dateFromEl = el("leh-date-from");
        const dateToEl = el("leh-date-to");
        const dateCustom = el("leh-date-custom");

        if (enabledEl) enabledEl.checked = enabled;
        if (showScoresEl) showScoresEl.checked = showScores;
        if (modeEl) modeEl.value = mode;
        if (thresholdEl) thresholdEl.value = absoluteThreshold;
        if (thresholdValEl) thresholdValEl.textContent = absoluteThreshold;
        if (wReactionsEl) wReactionsEl.value = weights.reactions;
        if (wCommentsEl) wCommentsEl.value = weights.comments;
        if (wRepostsEl) wRepostsEl.value = weights.reposts;
        if (thresholdRow) {
          thresholdRow.style.display = mode === "threshold" ? "flex" : "none";
        }
        if (scrollSpeedEl) scrollSpeedEl.value = autoScrollSpeed;
        if (scrollSpeedValEl) scrollSpeedValEl.textContent = autoScrollSpeed;
        if (dateFilterEl) dateFilterEl.value = dateFilter;
        if (dateFromEl) dateFromEl.value = customDateFrom;
        if (dateToEl) dateToEl.value = customDateTo;
        if (dateCustom) {
          dateCustom.style.display = dateFilter === "custom" ? "block" : "none";
        }

        processAllPosts();
      });
    } catch {
      // storage unavailable
    }
  }

  // ─── Initialization ────────────────────────────────────────────────

  function init() {
    createControlPanel();
    loadSettings();
    setupObserver();
    setupNavigationListener();

    // Initial scans (delayed to let LinkedIn finish rendering)
    setTimeout(processAllPosts, 1000);
    setTimeout(() => {
      processAllPosts();
      updateExtractCount();
    }, 3000);

    let scrollTimer = null;
    window.addEventListener(
      "scroll",
      () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          processAllPosts();
          updateExtractCount();
        }, 200);
      },
      { passive: true }
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
