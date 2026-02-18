/**
 * LinkedIn Engagement Highlighter - Content Script
 *
 * Reads only visible DOM elements to calculate engagement scores.
 * No network requests. No data storage. No automation.
 * Purely a client-side visual enhancement layer.
 */

(function () {
  "use strict";

  // ─── State ───────────────────────────────────────────────────────────
  let enabled = true;
  let showScores = true;
  let mode = "percentile"; // "percentile" or "threshold"
  let absoluteThreshold = 100;
  // Likes and comments are primary signals; reposts are secondary
  let weights = { likes: 5, comments: 10, reposts: 2 };
  let processedPosts = new WeakSet();
  let debounceTimer = null;

  const DEBOUNCE_MS = 300;

  // ─── Auto-scroll state ───────────────────────────────────────────────
  let autoScrollEnabled = false;
  let autoScrollInterval = null;
  let showMoreCheckInterval = null;
  let autoScrollSpeed = 2;   // px per tick
  let autoScrollTick = 80;   // ms between ticks (varied for natural feel)
  let showMoreHandled = false;

  // ─── Number Parsing ──────────────────────────────────────────────────

  /**
   * Converts abbreviated engagement strings to integers.
   * Handles: "1,234", "1.2K", "3K", "2.5M", "15", etc.
   */
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

  // ─── Post Detection ──────────────────────────────────────────────────

  /**
   * Finds all feed post containers on the page.
   * Uses multiple selector strategies for resilience.
   */
  function findPostContainers() {
    const selectors = [
      'div[data-id] .feed-shared-update-v2',
      '.feed-shared-update-v2',
      'div[data-urn]',
      '[role="article"]',
    ];

    let posts = [];
    for (const selector of selectors) {
      posts = Array.from(document.querySelectorAll(selector));
      if (posts.length > 0) break;
    }

    return posts;
  }

  // ─── Engagement Extraction ───────────────────────────────────────────

  /**
   * Extracts engagement metrics from a single post element.
   * Only reads visible text content from the DOM.
   */
  function extractEngagement(postEl) {
    let likes = 0;
    let comments = 0;
    let reposts = 0;

    // Strategy 1: Look for social counts container
    const socialCounts = postEl.querySelector(
      ".social-details-social-counts"
    );
    if (socialCounts) {
      // Likes/Reactions - typically in a button or span with reaction count
      const reactionEl =
        socialCounts.querySelector(
          '.social-details-social-counts__reactions-count'
        ) ||
        socialCounts.querySelector(
          '[data-control-name="reactions_count"]'
        ) ||
        socialCounts.querySelector(
          'button[aria-label*="reaction"] span'
        );
      if (reactionEl) {
        likes = parseCount(reactionEl.textContent);
      }

      // Comments count
      const commentEls = socialCounts.querySelectorAll(
        'button[aria-label*="comment"], .social-details-social-counts__comments'
      );
      for (const el of commentEls) {
        const label = el.getAttribute("aria-label") || el.textContent || "";
        const numMatch = label.match(/([\d,.]+[KMB]?)\s*comment/i);
        if (numMatch) {
          comments = parseCount(numMatch[1]);
          break;
        }
        const fallbackMatch = label.match(/([\d,.]+[KMB]?)/);
        if (fallbackMatch && label.toLowerCase().includes("comment")) {
          comments = parseCount(fallbackMatch[1]);
          break;
        }
      }

      // Reposts count
      const repostEls = socialCounts.querySelectorAll(
        'button[aria-label*="repost"], .social-details-social-counts__reposts'
      );
      for (const el of repostEls) {
        const label = el.getAttribute("aria-label") || el.textContent || "";
        const numMatch = label.match(/([\d,.]+[KMB]?)\s*repost/i);
        if (numMatch) {
          reposts = parseCount(numMatch[1]);
          break;
        }
        const fallbackMatch = label.match(/([\d,.]+[KMB]?)/);
        if (fallbackMatch && label.toLowerCase().includes("repost")) {
          reposts = parseCount(fallbackMatch[1]);
          break;
        }
      }
    }

    // Strategy 2: Fallback - scan aria-labels on all buttons inside the post
    if (likes === 0 && comments === 0 && reposts === 0) {
      const buttons = postEl.querySelectorAll("button[aria-label]");
      for (const btn of buttons) {
        const label = btn.getAttribute("aria-label") || "";
        const lowerLabel = label.toLowerCase();

        if (lowerLabel.includes("reaction") || lowerLabel.includes("like")) {
          const m = label.match(/([\d,.]+[KMB]?)/);
          if (m) likes = Math.max(likes, parseCount(m[1]));
        }
        if (lowerLabel.includes("comment")) {
          const m = label.match(/([\d,.]+[KMB]?)/);
          if (m) comments = Math.max(comments, parseCount(m[1]));
        }
        if (lowerLabel.includes("repost") || lowerLabel.includes("share")) {
          const m = label.match(/([\d,.]+[KMB]?)/);
          if (m) reposts = Math.max(reposts, parseCount(m[1]));
        }
      }
    }

    // Strategy 3: Look for visible count text near action buttons
    if (likes === 0 && comments === 0 && reposts === 0) {
      const spans = postEl.querySelectorAll("span.social-details-social-counts__reactions-count");
      for (const span of spans) {
        likes = parseCount(span.textContent);
      }

      const allSpans = postEl.querySelectorAll(
        '.social-details-social-counts span'
      );
      for (const span of allSpans) {
        const text = span.textContent.trim().toLowerCase();
        if (text.includes("comment")) {
          const m = text.match(/([\d,.]+[KMB]?)/i);
          if (m) comments = parseCount(m[1]);
        }
        if (text.includes("repost")) {
          const m = text.match(/([\d,.]+[KMB]?)/i);
          if (m) reposts = parseCount(m[1]);
        }
      }
    }

    return { likes, comments, reposts };
  }

  // ─── Post Metadata Extraction ────────────────────────────────────────

  /**
   * Extracts the LinkedIn permalink for a post from its data-urn attribute.
   * Format: https://www.linkedin.com/feed/update/{urn}
   */
  function extractPostUrl(postEl) {
    // Try data-urn on the element itself
    let urn = postEl.getAttribute("data-urn");

    // Try parent or child with data-urn
    if (!urn) {
      const parent = postEl.closest("[data-urn]");
      if (parent) urn = parent.getAttribute("data-urn");
    }
    if (!urn) {
      const child = postEl.querySelector("[data-urn]");
      if (child) urn = child.getAttribute("data-urn");
    }

    // Try data-id as fallback
    if (!urn) {
      const dataIdEl = postEl.closest("[data-id]") || postEl.querySelector("[data-id]");
      if (dataIdEl) urn = dataIdEl.getAttribute("data-id");
    }

    if (urn) {
      return "https://www.linkedin.com/feed/update/" + urn;
    }

    return "";
  }

  /**
   * Extracts the author/actor name from a post element.
   */
  function extractAuthorName(postEl) {
    const selectors = [
      ".feed-shared-actor__name",
      ".update-components-actor__name",
      ".feed-shared-actor__title",
      ".update-components-actor__title",
    ];

    for (const sel of selectors) {
      const el = postEl.querySelector(sel);
      if (el) {
        // Get visible text only (skip screen-reader-only spans)
        const visually = el.querySelector(".visually-hidden");
        if (visually) {
          const clone = el.cloneNode(true);
          const hidden = clone.querySelector(".visually-hidden");
          if (hidden) hidden.remove();
          const name = clone.textContent.trim();
          if (name) return name;
        }
        const name = el.textContent.trim();
        if (name) return name;
      }
    }

    return "";
  }

  // ─── CSV Export ─────────────────────────────────────────────────────

  /**
   * Collects data from all currently visible scored posts and triggers
   * a CSV download. User-initiated, on-demand — no background collection.
   */
  function exportTopPosts(tierFilter) {
    const posts = findPostContainers();
    const rows = [];

    for (const postEl of posts) {
      const engagement = extractEngagement(postEl);
      const score = calculateScore(engagement);
      if (score === 0) continue;

      // Determine tier
      let tier = "—";
      if (postEl.classList.contains("leh-tier1")) tier = "Tier 1 (Gold)";
      else if (postEl.classList.contains("leh-tier2")) tier = "Tier 2 (Blue)";

      // Apply filter: "all" = all scored, "highlighted" = tier 1 & 2 only
      if (tierFilter === "highlighted" && tier === "—") continue;

      rows.push({
        author: extractAuthorName(postEl),
        url: extractPostUrl(postEl),
        score,
        likes: engagement.likes,
        comments: engagement.comments,
        reposts: engagement.reposts,
        tier,
      });
    }

    if (rows.length === 0) {
      showExportFeedback("No posts to export. Scroll to load some posts first.", "warn");
      return;
    }

    // Sort by score descending
    rows.sort((a, b) => b.score - a.score);

    // Build CSV
    const header = ["Author", "Post URL", "Score", "Likes", "Comments", "Reposts", "Tier"];
    const csvLines = [header.join(",")];

    for (const r of rows) {
      csvLines.push([
        csvEscape(r.author),
        csvEscape(r.url),
        r.score,
        r.likes,
        r.comments,
        r.reposts,
        csvEscape(r.tier),
      ].join(","));
    }

    const csvContent = csvLines.join("\n");
    downloadCSV(csvContent, "linkedin-top-posts.csv");
    showExportFeedback(`Exported ${rows.length} post${rows.length !== 1 ? "s" : ""}.`, "success");
  }

  function csvEscape(value) {
    const str = String(value);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function downloadCSV(content, filename) {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function showExportFeedback(message, type) {
    const existing = document.getElementById("leh-export-feedback");
    if (existing) existing.remove();

    const el = document.createElement("div");
    el.id = "leh-export-feedback";
    el.className = "leh-export-feedback leh-export-feedback--" + type;
    el.textContent = message;

    const panel = document.getElementById("leh-panel");
    const body = panel?.querySelector(".leh-panel-body");
    if (body) {
      body.appendChild(el);
      setTimeout(() => el.remove(), 3500);
    }
  }

  // ─── Scoring ─────────────────────────────────────────────────────────

  /**
   * Simple weighted score: likes and comments are primary,
   * reposts are secondary. Higher comment weight reflects
   * that commenting takes more intent than a like.
   *
   * Score = (likes × wL) + (comments × wC) + (reposts × wR)
   */
  function calculateScore(engagement) {
    return (
      engagement.likes * weights.likes +
      engagement.comments * weights.comments +
      engagement.reposts * weights.reposts
    );
  }

  // ─── Highlighting ────────────────────────────────────────────────────

  function clearHighlights() {
    document
      .querySelectorAll(".leh-tier1, .leh-tier2")
      .forEach((el) => {
        el.classList.remove("leh-tier1", "leh-tier2");
      });
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

      for (const { element, score, engagement } of scoredPosts) {
        element.classList.remove("leh-tier1", "leh-tier2");
        if (score >= top10Threshold && score > 0) {
          element.classList.add("leh-tier1");
        } else if (score >= medianThreshold && score > 0) {
          element.classList.add("leh-tier2");
        }
        if (showScores) addScoreBadge(element, score, engagement);
      }
    } else {
      for (const { element, score, engagement } of scoredPosts) {
        element.classList.remove("leh-tier1", "leh-tier2");
        if (score >= absoluteThreshold * 2) {
          element.classList.add("leh-tier1");
        } else if (score >= absoluteThreshold) {
          element.classList.add("leh-tier2");
        }
        if (showScores) addScoreBadge(element, score, engagement);
      }
    }
  }

  function formatCount(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  }

  function addScoreBadge(element, score, engagement) {
    const existing = element.querySelector(".leh-score-badge");
    if (existing) existing.remove();

    if (!showScores) return;

    const badge = document.createElement("div");
    badge.className = "leh-score-badge";

    // Human-readable breakdown: likes · comments · reposts
    const parts = [];
    if (engagement.likes > 0) parts.push(`\u2764\ufe0f ${formatCount(engagement.likes)}`);
    if (engagement.comments > 0) parts.push(`\ud83d\udcac ${formatCount(engagement.comments)}`);
    if (engagement.reposts > 0) parts.push(`\ud83d\udd01 ${formatCount(engagement.reposts)}`);

    const breakdown = parts.length > 0 ? parts.join("  ") : "no data";
    badge.innerHTML = `<span class="leh-badge-score">${score.toLocaleString()}</span><span class="leh-badge-detail">${breakdown}</span>`;

    const computedStyle = window.getComputedStyle(element);
    if (computedStyle.position === "static") {
      element.style.position = "relative";
    }

    element.appendChild(badge);
  }

  // ─── Main Processing ─────────────────────────────────────────────────

  function processAllPosts() {
    if (!enabled) {
      clearHighlights();
      return;
    }

    const posts = findPostContainers();
    const scoredPosts = [];

    for (const postEl of posts) {
      const engagement = extractEngagement(postEl);
      const score = calculateScore(engagement);
      scoredPosts.push({ element: postEl, score, engagement });
    }

    clearHighlights();
    applyHighlights(scoredPosts);
  }

  function debouncedProcess() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processAllPosts, DEBOUNCE_MS);
  }

  // ─── MutationObserver ────────────────────────────────────────────────

  function setupObserver() {
    const feedContainer =
      document.querySelector(".scaffold-finite-scroll__content") ||
      document.querySelector("main") ||
      document.body;

    const observer = new MutationObserver((mutations) => {
      let hasNewPosts = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          hasNewPosts = true;
          break;
        }
      }
      if (hasNewPosts) {
        debouncedProcess();
      }
    });

    observer.observe(feedContainer, {
      childList: true,
      subtree: true,
    });

    return observer;
  }

  // ─── Auto-scroll ─────────────────────────────────────────────────────

  /**
   * Look for LinkedIn's "Show more activity" / "Show more results" button
   * and click it after a polite delay so LinkedIn can load naturally.
   * No CSS hacks — just clicks the button LinkedIn already shows.
   */
  function findShowMoreButton() {
    // Common selectors for LinkedIn's load-more buttons
    const candidates = Array.from(document.querySelectorAll("button, a[role='button']"));
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
    if (btn && !showMoreHandled) {
      showMoreHandled = true;
      // Scroll up just enough so the button is in view, then pause
      btn.scrollIntoView({ behavior: "smooth", block: "center" });

      setTimeout(() => {
        // Only click if auto-scroll is still enabled
        if (!autoScrollEnabled) return;
        btn.click();
        showMoreHandled = false; // allow detecting the next one
        // Wait for content to render before resuming scroll
        setTimeout(() => {
          showMoreHandled = false;
        }, 2000);
      }, 1200);
    }
  }

  function startAutoScroll() {
    if (autoScrollInterval) return;
    showMoreHandled = false;

    let tick = 0;
    autoScrollInterval = setInterval(() => {
      if (!autoScrollEnabled) {
        stopAutoScroll();
        return;
      }

      // Natural variation in scroll speed (±1px, change every ~20 ticks)
      const variance = tick % 23 < 12 ? autoScrollSpeed : autoScrollSpeed + 1;
      window.scrollBy({ top: variance, behavior: "instant" });
      tick++;

      // Check if we've hit the bottom
      const atBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 100;

      if (atBottom) {
        // Pause and look for a "show more" button
        handleShowMore();
      }
    }, autoScrollTick);

    // Separately poll for show-more buttons (catches mid-feed prompts too)
    showMoreCheckInterval = setInterval(() => {
      if (!autoScrollEnabled) return;
      const btn = findShowMoreButton();
      if (btn && !showMoreHandled) {
        handleShowMore();
      }
    }, 3000);
  }

  function stopAutoScroll() {
    if (autoScrollInterval) {
      clearInterval(autoScrollInterval);
      autoScrollInterval = null;
    }
    if (showMoreCheckInterval) {
      clearInterval(showMoreCheckInterval);
      showMoreCheckInterval = null;
    }
  }

  // ─── Control Panel ───────────────────────────────────────────────────

  function createControlPanel() {
    if (document.getElementById("leh-panel")) return;

    const panel = document.createElement("div");
    panel.id = "leh-panel";
    panel.innerHTML = `
      <div class="leh-panel-header">
        <span class="leh-panel-title">Engagement Highlighter</span>
        <button class="leh-panel-toggle-collapse" title="Minimize">&#x2212;</button>
      </div>
      <div class="leh-panel-body">

        <!-- Highlighter section -->
        <div class="leh-control-row">
          <label class="leh-label">
            <input type="checkbox" id="leh-enabled" checked />
            Highlight posts
          </label>
        </div>
        <div class="leh-control-row">
          <label class="leh-label">
            <input type="checkbox" id="leh-show-scores" checked />
            Show score badge
          </label>
        </div>
        <div class="leh-control-row">
          <label class="leh-label">Mode:</label>
          <select id="leh-mode">
            <option value="percentile">Percentile (auto)</option>
            <option value="threshold">Fixed threshold</option>
          </select>
        </div>
        <div class="leh-control-row leh-threshold-row" style="display:none;">
          <label class="leh-label">Threshold:</label>
          <input type="range" id="leh-threshold" min="10" max="5000" value="100" step="10" />
          <span id="leh-threshold-val">100</span>
        </div>

        <div class="leh-section-label">Score weights</div>
        <div class="leh-weight-help">Higher = counts more toward score</div>
        <div class="leh-control-row">
          <label class="leh-label">\u2764\ufe0f Likes</label>
          <input type="number" id="leh-w-likes" value="5" min="0" max="20" step="1" class="leh-num-input" />
        </div>
        <div class="leh-control-row">
          <label class="leh-label">\ud83d\udcac Comments</label>
          <input type="number" id="leh-w-comments" value="10" min="0" max="20" step="1" class="leh-num-input" />
        </div>
        <div class="leh-control-row">
          <label class="leh-label">\ud83d\udd01 Reposts</label>
          <input type="number" id="leh-w-reposts" value="2" min="0" max="20" step="1" class="leh-num-input" />
        </div>
        <button id="leh-recalculate" class="leh-btn">Recalculate</button>

        <!-- Auto-scroll section -->
        <div class="leh-section-label">Auto-scroll</div>
        <div class="leh-control-row">
          <label class="leh-label">
            <input type="checkbox" id="leh-autoscroll" />
            Scroll feed automatically
          </label>
        </div>
        <div class="leh-control-row">
          <label class="leh-label">Speed:</label>
          <input type="range" id="leh-scroll-speed" min="1" max="6" value="2" step="1" />
          <span id="leh-scroll-speed-val">2</span>
        </div>
        <div class="leh-scroll-note">
          Auto-scroll pauses when LinkedIn shows a "Show more" prompt, clicks it, then resumes.
        </div>

        <!-- Export section -->
        <div class="leh-section-label">Export</div>
        <div class="leh-export-note">
          Download a CSV of posts currently visible on the page.
        </div>
        <div class="leh-control-row">
          <label class="leh-label">Include:</label>
          <select id="leh-export-filter">
            <option value="highlighted">Highlighted only</option>
            <option value="all">All scored posts</option>
          </select>
        </div>
        <button id="leh-export" class="leh-btn leh-btn-export">Export Top Posts</button>
      </div>
    `;

    document.body.appendChild(panel);

    // ── Collapse toggle ──
    let collapsed = false;
    const collapseBtn = panel.querySelector(".leh-panel-toggle-collapse");
    const panelBody = panel.querySelector(".leh-panel-body");
    collapseBtn.addEventListener("click", () => {
      collapsed = !collapsed;
      panelBody.style.display = collapsed ? "none" : "block";
      collapseBtn.textContent = collapsed ? "+" : "\u2212";
      panel.classList.toggle("leh-collapsed", collapsed);
    });

    // ── Drag support ──
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    const header = panel.querySelector(".leh-panel-header");

    header.addEventListener("mousedown", (e) => {
      if (e.target === collapseBtn) return;
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
      processAllPosts();
      saveSettings();
    });

    document.getElementById("leh-threshold").addEventListener("input", (e) => {
      absoluteThreshold = parseInt(e.target.value, 10);
      document.getElementById("leh-threshold-val").textContent = absoluteThreshold;
      saveSettings();
    });

    document.getElementById("leh-threshold").addEventListener("change", () => {
      processAllPosts();
    });

    document.getElementById("leh-w-likes").addEventListener("change", (e) => {
      weights.likes = parseFloat(e.target.value) || 0;
      saveSettings();
    });

    document.getElementById("leh-w-comments").addEventListener("change", (e) => {
      weights.comments = parseFloat(e.target.value) || 0;
      saveSettings();
    });

    document.getElementById("leh-w-reposts").addEventListener("change", (e) => {
      weights.reposts = parseFloat(e.target.value) || 0;
      saveSettings();
    });

    document.getElementById("leh-recalculate").addEventListener("click", () => {
      processAllPosts();
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

    // ── Export controls ──
    document.getElementById("leh-export").addEventListener("click", () => {
      const filter = document.getElementById("leh-export-filter").value;
      exportTopPosts(filter);
    });
  }

  // ─── Settings Persistence (local only) ───────────────────────────────

  function saveSettings() {
    try {
      chrome.storage.local.set({
        lehSettings: {
          enabled,
          showScores,
          mode,
          absoluteThreshold,
          weights,
          autoScrollEnabled,
          autoScrollSpeed,
        },
      });
    } catch {
      // storage unavailable - continue without persistence
    }
  }

  function loadSettings() {
    try {
      chrome.storage.local.get("lehSettings", (result) => {
        if (result && result.lehSettings) {
          const s = result.lehSettings;
          enabled = s.enabled ?? true;
          showScores = s.showScores ?? true;
          mode = s.mode ?? "percentile";
          absoluteThreshold = s.absoluteThreshold ?? 100;
          weights = s.weights ?? { likes: 5, comments: 10, reposts: 2 };
          autoScrollSpeed = s.autoScrollSpeed ?? 2;
          // Don't restore autoScrollEnabled — always start with it off

          const enabledEl = document.getElementById("leh-enabled");
          const showScoresEl = document.getElementById("leh-show-scores");
          const modeEl = document.getElementById("leh-mode");
          const thresholdEl = document.getElementById("leh-threshold");
          const thresholdValEl = document.getElementById("leh-threshold-val");
          const wLikesEl = document.getElementById("leh-w-likes");
          const wCommentsEl = document.getElementById("leh-w-comments");
          const wRepostsEl = document.getElementById("leh-w-reposts");
          const thresholdRow = document.querySelector(".leh-threshold-row");
          const scrollSpeedEl = document.getElementById("leh-scroll-speed");
          const scrollSpeedValEl = document.getElementById("leh-scroll-speed-val");

          if (enabledEl) enabledEl.checked = enabled;
          if (showScoresEl) showScoresEl.checked = showScores;
          if (modeEl) modeEl.value = mode;
          if (thresholdEl) thresholdEl.value = absoluteThreshold;
          if (thresholdValEl) thresholdValEl.textContent = absoluteThreshold;
          if (wLikesEl) wLikesEl.value = weights.likes;
          if (wCommentsEl) wCommentsEl.value = weights.comments;
          if (wRepostsEl) wRepostsEl.value = weights.reposts;
          if (thresholdRow) {
            thresholdRow.style.display = mode === "threshold" ? "flex" : "none";
          }
          if (scrollSpeedEl) scrollSpeedEl.value = autoScrollSpeed;
          if (scrollSpeedValEl) scrollSpeedValEl.textContent = autoScrollSpeed;

          processAllPosts();
        }
      });
    } catch {
      // storage unavailable - use defaults
    }
  }

  // ─── Initialization ──────────────────────────────────────────────────

  function init() {
    createControlPanel();
    loadSettings();
    setupObserver();

    setTimeout(processAllPosts, 1000);

    let scrollTimer = null;
    window.addEventListener(
      "scroll",
      () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(processAllPosts, 500);
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
