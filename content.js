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
  let weights = { reactions: 1, comments: 3, reposts: 4 };
  let processedPosts = new WeakSet();
  let debounceTimer = null;

  const DEBOUNCE_MS = 300;

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
    let reactions = 0;
    let comments = 0;
    let reposts = 0;

    // Strategy 1: Look for social counts container
    const socialCounts = postEl.querySelector(
      ".social-details-social-counts"
    );
    if (socialCounts) {
      // Reactions - typically in a button or span with reaction count
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
        reactions = parseCount(reactionEl.textContent);
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
        // Fallback: just parse any number found
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
    if (reactions === 0 && comments === 0 && reposts === 0) {
      const buttons = postEl.querySelectorAll("button[aria-label]");
      for (const btn of buttons) {
        const label = btn.getAttribute("aria-label") || "";
        const lowerLabel = label.toLowerCase();

        if (lowerLabel.includes("reaction") || lowerLabel.includes("like")) {
          const m = label.match(/([\d,.]+[KMB]?)/);
          if (m) reactions = Math.max(reactions, parseCount(m[1]));
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
    if (reactions === 0 && comments === 0 && reposts === 0) {
      const spans = postEl.querySelectorAll("span.social-details-social-counts__reactions-count");
      for (const span of spans) {
        reactions = parseCount(span.textContent);
      }

      // Generic search for comment/repost counts in text
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

    return { reactions, comments, reposts };
  }

  // ─── Scoring ─────────────────────────────────────────────────────────

  function calculateScore(engagement) {
    return (
      engagement.reactions * weights.reactions +
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
      // Sort by score descending
      const sorted = [...scoredPosts].sort((a, b) => b.score - a.score);
      const top10Index = Math.max(1, Math.ceil(sorted.length * 0.1));
      const medianIndex = Math.floor(sorted.length / 2);
      const top10Threshold = sorted[top10Index - 1]?.score ?? Infinity;
      const medianThreshold = sorted[medianIndex]?.score ?? 0;

      for (const { element, score } of scoredPosts) {
        element.classList.remove("leh-tier1", "leh-tier2");
        if (score >= top10Threshold && score > 0) {
          element.classList.add("leh-tier1");
        } else if (score >= medianThreshold && score > 0) {
          element.classList.add("leh-tier2");
        }
        if (showScores) addScoreBadge(element, score);
      }
    } else {
      // Absolute threshold mode
      for (const { element, score } of scoredPosts) {
        element.classList.remove("leh-tier1", "leh-tier2");
        if (score >= absoluteThreshold * 2) {
          element.classList.add("leh-tier1");
        } else if (score >= absoluteThreshold) {
          element.classList.add("leh-tier2");
        }
        if (showScores) addScoreBadge(element, score);
      }
    }
  }

  function addScoreBadge(element, score) {
    // Remove existing badge
    const existing = element.querySelector(".leh-score-badge");
    if (existing) existing.remove();

    if (!showScores) return;

    const badge = document.createElement("div");
    badge.className = "leh-score-badge";
    badge.textContent = `Score: ${score.toLocaleString()}`;

    // Ensure the post is positioned for absolute placement
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

      // Skip posts with zero engagement (might be sponsored or newly loaded)
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

  // ─── Control Panel ───────────────────────────────────────────────────

  function createControlPanel() {
    // Prevent duplicate panels
    if (document.getElementById("leh-panel")) return;

    const panel = document.createElement("div");
    panel.id = "leh-panel";
    panel.innerHTML = `
      <div class="leh-panel-header">
        <span class="leh-panel-title">Engagement Highlighter</span>
        <button class="leh-panel-toggle-collapse" title="Minimize">&#x2212;</button>
      </div>
      <div class="leh-panel-body">
        <div class="leh-control-row">
          <label class="leh-label">
            <input type="checkbox" id="leh-enabled" checked />
            Enabled
          </label>
        </div>
        <div class="leh-control-row">
          <label class="leh-label">
            <input type="checkbox" id="leh-show-scores" checked />
            Show Scores
          </label>
        </div>
        <div class="leh-control-row">
          <label class="leh-label">Mode:</label>
          <select id="leh-mode">
            <option value="percentile">Percentile</option>
            <option value="threshold">Threshold</option>
          </select>
        </div>
        <div class="leh-control-row leh-threshold-row" style="display:none;">
          <label class="leh-label">Threshold:</label>
          <input type="range" id="leh-threshold" min="10" max="5000" value="100" step="10" />
          <span id="leh-threshold-val">100</span>
        </div>
        <div class="leh-section-label">Weights</div>
        <div class="leh-control-row">
          <label class="leh-label">Reactions:</label>
          <input type="number" id="leh-w-reactions" value="1" min="0" max="20" step="0.5" class="leh-num-input" />
        </div>
        <div class="leh-control-row">
          <label class="leh-label">Comments:</label>
          <input type="number" id="leh-w-comments" value="3" min="0" max="20" step="0.5" class="leh-num-input" />
        </div>
        <div class="leh-control-row">
          <label class="leh-label">Reposts:</label>
          <input type="number" id="leh-w-reposts" value="4" min="0" max="20" step="0.5" class="leh-num-input" />
        </div>
        <button id="leh-recalculate" class="leh-btn">Recalculate</button>
      </div>
    `;

    document.body.appendChild(panel);

    // ── Panel collapse toggle ──
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

    // ── Event listeners ──
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

    document.getElementById("leh-w-reactions").addEventListener("change", (e) => {
      weights.reactions = parseFloat(e.target.value) || 0;
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
          weights = s.weights ?? { reactions: 1, comments: 3, reposts: 4 };

          // Update UI to match loaded settings
          const enabledEl = document.getElementById("leh-enabled");
          const showScoresEl = document.getElementById("leh-show-scores");
          const modeEl = document.getElementById("leh-mode");
          const thresholdEl = document.getElementById("leh-threshold");
          const thresholdValEl = document.getElementById("leh-threshold-val");
          const wReactionsEl = document.getElementById("leh-w-reactions");
          const wCommentsEl = document.getElementById("leh-w-comments");
          const wRepostsEl = document.getElementById("leh-w-reposts");
          const thresholdRow = document.querySelector(".leh-threshold-row");

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

    // Initial processing after a short delay to let the feed render
    setTimeout(processAllPosts, 1000);

    // Also reprocess on scroll (debounced) to catch lazy-loaded content
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

  // Wait for the page to be ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
