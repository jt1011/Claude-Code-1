/**
 * Instagram Engagement Highlighter - Content Script
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
  // Likes and comments are primary signals; saves/shares are secondary
  let weights = { likes: 5, comments: 10, views: 2 };
  let processedPosts = new WeakSet();
  let debounceTimer = null;

  const DEBOUNCE_MS = 300;

  // ─── Auto-scroll state ───────────────────────────────────────────────
  let autoScrollEnabled = false;
  let autoScrollInterval = null;
  let autoScrollSpeed = 2;   // px per tick
  let autoScrollTick = 80;   // ms between ticks

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

  /**
   * Extracts a number from a text string that may contain engagement info.
   * e.g. "1,234 likes" → 1234, "View all 56 comments" → 56
   */
  function extractNumber(text) {
    if (!text) return 0;
    // Match numbers with optional K/M/B suffix
    const match = text.match(/([\d,]+\.?\d*)\s*([KMB])?/i);
    if (!match) return 0;
    return parseCount(match[1] + (match[2] || ""));
  }

  // ─── Post Detection ──────────────────────────────────────────────────

  /**
   * Finds all feed post containers on the page.
   * Instagram uses article elements for posts. We use multiple
   * selector strategies for resilience against DOM changes.
   */
  function findPostContainers() {
    const selectors = [
      // Primary: Instagram feed posts are article elements
      'article[role="presentation"]',
      // Fallback: any article element in the main feed area
      'main article',
      // Generic article fallback
      'article',
    ];

    let posts = [];
    for (const selector of selectors) {
      posts = Array.from(document.querySelectorAll(selector));
      if (posts.length > 0) break;
    }

    // Filter out nested articles (Instagram sometimes nests them)
    // Keep only top-level post articles
    const filtered = posts.filter((post) => {
      return !posts.some(
        (other) => other !== post && other.contains(post)
      );
    });

    return filtered.length > 0 ? filtered : posts;
  }

  // ─── Engagement Extraction ───────────────────────────────────────────

  /**
   * Extracts engagement metrics from a single post element.
   * Only reads visible text content from the DOM.
   *
   * Instagram engagement patterns:
   * - Likes: "X likes", "Liked by username and X others"
   * - Comments: "View all X comments", or individual comment elements
   * - Views: "X views" (for video/reel posts)
   */
  function extractEngagement(postEl) {
    let likes = 0;
    let comments = 0;
    let views = 0;

    // Strategy 1: Look for likes section
    // Instagram shows likes as links/buttons with text like "X likes"
    // or "Liked by username and X others"
    const allLinks = postEl.querySelectorAll('a, button, span, div');
    for (const el of allLinks) {
      const text = (el.textContent || "").trim();
      const lowerText = text.toLowerCase();

      // Skip if element has too many children (container element, not a leaf)
      if (el.children.length > 5) continue;

      // Likes detection
      if (likes === 0) {
        // Pattern: "X likes"
        const likesMatch = text.match(/([\d,]+\.?\d*[KMB]?)\s*likes?/i);
        if (likesMatch) {
          likes = Math.max(likes, parseCount(likesMatch[1]));
        }

        // Pattern: "Liked by username and X others"
        const othersMatch = text.match(/and\s+([\d,]+\.?\d*[KMB]?)\s*others?/i);
        if (othersMatch) {
          likes = Math.max(likes, parseCount(othersMatch[1]) + 1);
        }

        // Pattern: "Liked by username and others" (no count visible)
        if (lowerText.includes("liked by") && likes === 0) {
          // Check for aria-label or title with count
          const ariaLabel = el.getAttribute("aria-label") || "";
          const countMatch = ariaLabel.match(/([\d,]+\.?\d*[KMB]?)/);
          if (countMatch) {
            likes = Math.max(likes, parseCount(countMatch[1]));
          }
        }
      }

      // Comments detection
      if (comments === 0) {
        // Pattern: "View all X comments"
        const commentsMatch = text.match(/(?:View\s+all\s+)?([\d,]+\.?\d*[KMB]?)\s*comments?/i);
        if (commentsMatch) {
          comments = Math.max(comments, parseCount(commentsMatch[1]));
        }
      }

      // Views detection (for videos/reels)
      if (views === 0) {
        // Pattern: "X views"
        const viewsMatch = text.match(/([\d,]+\.?\d*[KMB]?)\s*views?/i);
        if (viewsMatch) {
          views = Math.max(views, parseCount(viewsMatch[1]));
        }

        // Pattern: "X plays"
        const playsMatch = text.match(/([\d,]+\.?\d*[KMB]?)\s*plays?/i);
        if (playsMatch) {
          views = Math.max(views, parseCount(playsMatch[1]));
        }
      }
    }

    // Strategy 2: Check aria-labels on interactive elements
    if (likes === 0 && comments === 0 && views === 0) {
      const interactiveEls = postEl.querySelectorAll('[aria-label], [title]');
      for (const el of interactiveEls) {
        const label = (el.getAttribute("aria-label") || el.getAttribute("title") || "").toLowerCase();

        if (label.includes("like") && !label.includes("unlike")) {
          const m = label.match(/([\d,]+\.?\d*[KMB]?)/i);
          if (m) likes = Math.max(likes, parseCount(m[1]));
        }
        if (label.includes("comment")) {
          const m = label.match(/([\d,]+\.?\d*[KMB]?)/i);
          if (m) comments = Math.max(comments, parseCount(m[1]));
        }
        if (label.includes("view") || label.includes("play")) {
          const m = label.match(/([\d,]+\.?\d*[KMB]?)/i);
          if (m) views = Math.max(views, parseCount(m[1]));
        }
      }
    }

    // Strategy 3: Look for the like count section specifically
    // Instagram sometimes uses a section below the image for engagement
    if (likes === 0) {
      const sections = postEl.querySelectorAll('section');
      for (const section of sections) {
        const text = (section.textContent || "").trim();
        const likesMatch = text.match(/([\d,]+\.?\d*[KMB]?)\s*likes?/i);
        if (likesMatch) {
          likes = parseCount(likesMatch[1]);
          break;
        }
        const othersMatch = text.match(/and\s+([\d,]+\.?\d*[KMB]?)\s*others?/i);
        if (othersMatch) {
          likes = parseCount(othersMatch[1]) + 1;
          break;
        }
      }
    }

    // Strategy 4: Count visible comment elements as fallback
    if (comments === 0) {
      // Instagram renders individual comments as list items or divs
      const commentEls = postEl.querySelectorAll('ul > li, [role="button"]');
      let commentCount = 0;
      for (const el of commentEls) {
        const text = (el.textContent || "").trim();
        // A comment typically contains a username followed by text
        if (text.length > 5 && text.length < 2000 && !text.includes("like") && !text.includes("view")) {
          // Check if it looks like a comment (has an anchor/username link)
          if (el.querySelector('a') && el.textContent.length > 10) {
            commentCount++;
          }
        }
      }
      if (commentCount > 0) {
        comments = commentCount;
      }
    }

    return { likes, comments, views };
  }

  // ─── Post Metadata Extraction ────────────────────────────────────────

  /**
   * Extracts metadata from a post element: username, post URL, caption snippet.
   * Only reads visible DOM content — no network requests.
   */
  function extractPostMeta(postEl) {
    let username = "";
    let postUrl = "";
    let caption = "";

    // ── Username ──
    // Instagram post headers contain an anchor with href like "/username/"
    // Usually the first link in the post header area
    const headerLinks = postEl.querySelectorAll('header a[href], a[role="link"]');
    for (const link of headerLinks) {
      const href = link.getAttribute("href") || "";
      // Match /<username>/ pattern (not /p/, /reel/, /explore/, etc.)
      const userMatch = href.match(/^\/([A-Za-z0-9_.]+)\/?$/);
      if (userMatch) {
        username = userMatch[1];
        break;
      }
    }

    // Fallback: look for any link that looks like a profile link
    if (!username) {
      const allLinks = postEl.querySelectorAll('a[href]');
      for (const link of allLinks) {
        const href = link.getAttribute("href") || "";
        const userMatch = href.match(/^\/([A-Za-z0-9_.]+)\/?$/);
        if (userMatch && !["p", "reel", "explore", "stories", "accounts", "directory"].includes(userMatch[1])) {
          username = userMatch[1];
          break;
        }
      }
    }

    // ── Post URL ──
    // Instagram post links contain /p/<shortcode>/ or /reel/<shortcode>/
    const postLinks = postEl.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    for (const link of postLinks) {
      const href = link.getAttribute("href") || "";
      if (href.includes("/p/") || href.includes("/reel/")) {
        postUrl = href.startsWith("http") ? href : "https://www.instagram.com" + href;
        break;
      }
    }

    // Fallback: look at time element's parent link (Instagram wraps timestamps in post links)
    if (!postUrl) {
      const timeEl = postEl.querySelector("time");
      if (timeEl) {
        const parentLink = timeEl.closest("a[href]");
        if (parentLink) {
          const href = parentLink.getAttribute("href") || "";
          postUrl = href.startsWith("http") ? href : "https://www.instagram.com" + href;
        }
      }
    }

    // ── Caption ──
    // Captions are typically in a span inside the area below the image,
    // often following the username link
    const captionCandidates = postEl.querySelectorAll('span, div');
    for (const el of captionCandidates) {
      const text = (el.textContent || "").trim();
      // Skip very short strings, engagement text, timestamps
      if (text.length < 20) continue;
      if (/^\d+\s*(likes?|comments?|views?|plays?)/i.test(text)) continue;
      if (/^(View all|Liked by|Load more)/i.test(text)) continue;
      if (el.closest("header")) continue;
      // Skip if this element has many child elements (it's a container)
      if (el.children.length > 3) continue;

      // Take first substantial text block as caption
      caption = text.length > 150 ? text.substring(0, 147) + "..." : text;
      break;
    }

    return { username, postUrl, caption };
  }

  // ─── Scoring ─────────────────────────────────────────────────────────

  /**
   * Weighted engagement score. Comments weighted highest (more intent).
   * Views used as a secondary signal for video content.
   *
   * Score = (likes × wL) + (comments × wC) + (views × wV)
   */
  function calculateScore(engagement) {
    return (
      engagement.likes * weights.likes +
      engagement.comments * weights.comments +
      engagement.views * weights.views
    );
  }

  // ─── Highlighting ────────────────────────────────────────────────────

  function clearHighlights() {
    document
      .querySelectorAll(".ieh-tier1, .ieh-tier2")
      .forEach((el) => {
        el.classList.remove("ieh-tier1", "ieh-tier2");
      });
    document
      .querySelectorAll(".ieh-score-badge")
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
        element.classList.remove("ieh-tier1", "ieh-tier2");
        if (score >= top10Threshold && score > 0) {
          element.classList.add("ieh-tier1");
        } else if (score >= medianThreshold && score > 0) {
          element.classList.add("ieh-tier2");
        }
        if (showScores) addScoreBadge(element, score, engagement);
      }
    } else {
      for (const { element, score, engagement } of scoredPosts) {
        element.classList.remove("ieh-tier1", "ieh-tier2");
        if (score >= absoluteThreshold * 2) {
          element.classList.add("ieh-tier1");
        } else if (score >= absoluteThreshold) {
          element.classList.add("ieh-tier2");
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
    const existing = element.querySelector(".ieh-score-badge");
    if (existing) existing.remove();

    if (!showScores) return;

    const badge = document.createElement("div");
    badge.className = "ieh-score-badge";

    const parts = [];
    if (engagement.likes > 0) parts.push(`\u2764\ufe0f ${formatCount(engagement.likes)}`);
    if (engagement.comments > 0) parts.push(`\ud83d\udcac ${formatCount(engagement.comments)}`);
    if (engagement.views > 0) parts.push(`\ud83d\udc41 ${formatCount(engagement.views)}`);

    const breakdown = parts.length > 0 ? parts.join("  ") : "no data";
    badge.innerHTML = `<span class="ieh-badge-score">${score.toLocaleString()}</span><span class="ieh-badge-detail">${breakdown}</span>`;

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
      document.querySelector('main[role="main"]') ||
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

  function startAutoScroll() {
    if (autoScrollInterval) return;

    let tick = 0;
    autoScrollInterval = setInterval(() => {
      if (!autoScrollEnabled) {
        stopAutoScroll();
        return;
      }

      // Natural variation in scroll speed
      const variance = tick % 23 < 12 ? autoScrollSpeed : autoScrollSpeed + 1;
      window.scrollBy({ top: variance, behavior: "instant" });
      tick++;
    }, autoScrollTick);
  }

  function stopAutoScroll() {
    if (autoScrollInterval) {
      clearInterval(autoScrollInterval);
      autoScrollInterval = null;
    }
  }

  // ─── Control Panel ───────────────────────────────────────────────────

  function createControlPanel() {
    if (document.getElementById("ieh-panel")) return;

    const panel = document.createElement("div");
    panel.id = "ieh-panel";
    panel.innerHTML = `
      <div class="ieh-panel-header">
        <span class="ieh-panel-title">IG Engagement Highlighter</span>
        <button class="ieh-panel-toggle-collapse" title="Minimize">&#x2212;</button>
      </div>
      <div class="ieh-panel-body">

        <!-- Highlighter section -->
        <div class="ieh-control-row">
          <label class="ieh-label">
            <input type="checkbox" id="ieh-enabled" checked />
            Highlight posts
          </label>
        </div>
        <div class="ieh-control-row">
          <label class="ieh-label">
            <input type="checkbox" id="ieh-show-scores" checked />
            Show score badge
          </label>
        </div>
        <div class="ieh-control-row">
          <label class="ieh-label">Mode:</label>
          <select id="ieh-mode">
            <option value="percentile">Percentile (auto)</option>
            <option value="threshold">Fixed threshold</option>
          </select>
        </div>
        <div class="ieh-control-row ieh-threshold-row" style="display:none;">
          <label class="ieh-label">Threshold:</label>
          <input type="range" id="ieh-threshold" min="10" max="5000" value="100" step="10" />
          <span id="ieh-threshold-val">100</span>
        </div>

        <div class="ieh-section-label">Score weights</div>
        <div class="ieh-weight-help">Higher = counts more toward score</div>
        <div class="ieh-control-row">
          <label class="ieh-label">\u2764\ufe0f Likes</label>
          <input type="number" id="ieh-w-likes" value="5" min="0" max="20" step="1" class="ieh-num-input" />
        </div>
        <div class="ieh-control-row">
          <label class="ieh-label">\ud83d\udcac Comments</label>
          <input type="number" id="ieh-w-comments" value="10" min="0" max="20" step="1" class="ieh-num-input" />
        </div>
        <div class="ieh-control-row">
          <label class="ieh-label">\ud83d\udc41 Views</label>
          <input type="number" id="ieh-w-views" value="2" min="0" max="20" step="1" class="ieh-num-input" />
        </div>
        <button id="ieh-recalculate" class="ieh-btn">Recalculate</button>

        <!-- Auto-scroll section -->
        <div class="ieh-section-label">Auto-scroll</div>
        <div class="ieh-control-row">
          <label class="ieh-label">
            <input type="checkbox" id="ieh-autoscroll" />
            Scroll feed automatically
          </label>
        </div>
        <div class="ieh-control-row">
          <label class="ieh-label">Speed:</label>
          <input type="range" id="ieh-scroll-speed" min="1" max="6" value="2" step="1" />
          <span id="ieh-scroll-speed-val">2</span>
        </div>
        <div class="ieh-scroll-note">
          Auto-scroll smoothly scrolls through your Instagram feed so the highlighter can score posts as they load.
        </div>

        <!-- Extract top posts section -->
        <div class="ieh-section-label">Extract top posts</div>
        <div class="ieh-control-row">
          <label class="ieh-label">Show top:</label>
          <select id="ieh-export-count">
            <option value="5">5 posts</option>
            <option value="10" selected>10 posts</option>
            <option value="25">25 posts</option>
            <option value="50">50 posts</option>
            <option value="all">All scored</option>
          </select>
        </div>
        <button id="ieh-extract" class="ieh-btn ieh-btn-extract">Extract Top Posts</button>
        <div id="ieh-extract-count" class="ieh-scroll-note"></div>
      </div>
    `;

    document.body.appendChild(panel);

    // ── Collapse toggle ──
    let collapsed = false;
    const collapseBtn = panel.querySelector(".ieh-panel-toggle-collapse");
    const panelBody = panel.querySelector(".ieh-panel-body");
    collapseBtn.addEventListener("click", () => {
      collapsed = !collapsed;
      panelBody.style.display = collapsed ? "none" : "block";
      collapseBtn.textContent = collapsed ? "+" : "\u2212";
      panel.classList.toggle("ieh-collapsed", collapsed);
    });

    // ── Drag support ──
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    const header = panel.querySelector(".ieh-panel-header");

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
    document.getElementById("ieh-enabled").addEventListener("change", (e) => {
      enabled = e.target.checked;
      processAllPosts();
      saveSettings();
    });

    document.getElementById("ieh-show-scores").addEventListener("change", (e) => {
      showScores = e.target.checked;
      processAllPosts();
      saveSettings();
    });

    document.getElementById("ieh-mode").addEventListener("change", (e) => {
      mode = e.target.value;
      const thresholdRow = panel.querySelector(".ieh-threshold-row");
      thresholdRow.style.display = mode === "threshold" ? "flex" : "none";
      processAllPosts();
      saveSettings();
    });

    document.getElementById("ieh-threshold").addEventListener("input", (e) => {
      absoluteThreshold = parseInt(e.target.value, 10);
      document.getElementById("ieh-threshold-val").textContent = absoluteThreshold;
      saveSettings();
    });

    document.getElementById("ieh-threshold").addEventListener("change", () => {
      processAllPosts();
    });

    document.getElementById("ieh-w-likes").addEventListener("change", (e) => {
      weights.likes = parseFloat(e.target.value) || 0;
      saveSettings();
    });

    document.getElementById("ieh-w-comments").addEventListener("change", (e) => {
      weights.comments = parseFloat(e.target.value) || 0;
      saveSettings();
    });

    document.getElementById("ieh-w-views").addEventListener("change", (e) => {
      weights.views = parseFloat(e.target.value) || 0;
      saveSettings();
    });

    document.getElementById("ieh-recalculate").addEventListener("click", () => {
      processAllPosts();
    });

    // ── Auto-scroll controls ──
    document.getElementById("ieh-autoscroll").addEventListener("change", (e) => {
      autoScrollEnabled = e.target.checked;
      if (autoScrollEnabled) {
        startAutoScroll();
      } else {
        stopAutoScroll();
      }
      saveSettings();
    });

    document.getElementById("ieh-scroll-speed").addEventListener("input", (e) => {
      autoScrollSpeed = parseInt(e.target.value, 10);
      document.getElementById("ieh-scroll-speed-val").textContent = autoScrollSpeed;
      saveSettings();
    });

    // ── Extract top posts ──
    document.getElementById("ieh-extract").addEventListener("click", () => {
      extractTopPosts();
    });

    // Update the "X posts in feed" counter on scroll
    updateExtractCount();
  }

  // ─── Extract Top Posts ────────────────────────────────────────────────

  function updateExtractCount() {
    const countEl = document.getElementById("ieh-extract-count");
    if (!countEl) return;
    const posts = findPostContainers();
    countEl.textContent = posts.length + " post" + (posts.length !== 1 ? "s" : "") + " detected in feed";
  }

  function extractTopPosts() {
    const posts = findPostContainers();
    const scored = [];

    for (const postEl of posts) {
      const engagement = extractEngagement(postEl);
      const score = calculateScore(engagement);
      const meta = extractPostMeta(postEl);
      scored.push({ ...meta, ...engagement, score });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Filter by selection
    const countSel = document.getElementById("ieh-export-count");
    const countVal = countSel ? countSel.value : "10";
    const limit = countVal === "all" ? scored.length : parseInt(countVal, 10);
    const topPosts = scored.slice(0, limit);

    // Update detected count
    updateExtractCount();

    // Show results modal
    showExportModal(topPosts);
  }

  function showExportModal(posts) {
    // Remove existing modal if any
    const existing = document.getElementById("ieh-export-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "ieh-export-modal";
    overlay.className = "ieh-modal-overlay";

    const totalPosts = findPostContainers().length;

    let tableRows = "";
    posts.forEach((p, i) => {
      const user = p.username ? `@${p.username}` : "unknown";
      const link = p.postUrl
        ? `<a href="${p.postUrl}" target="_blank" rel="noopener noreferrer" class="ieh-modal-link">${p.postUrl.length > 40 ? p.postUrl.substring(0, 37) + "..." : p.postUrl}</a>`
        : "N/A";
      const cap = p.caption
        ? `<span class="ieh-modal-caption">${p.caption.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span>`
        : "";
      tableRows += `
        <tr>
          <td class="ieh-modal-rank">${i + 1}</td>
          <td class="ieh-modal-user">${user}</td>
          <td class="ieh-modal-metrics">${formatCount(p.likes)}</td>
          <td class="ieh-modal-metrics">${formatCount(p.comments)}</td>
          <td class="ieh-modal-metrics">${formatCount(p.views)}</td>
          <td class="ieh-modal-score">${p.score.toLocaleString()}</td>
          <td class="ieh-modal-link-cell">${link}</td>
        </tr>
        ${cap ? `<tr class="ieh-caption-row"><td></td><td colspan="6">${cap}</td></tr>` : ""}
      `;
    });

    overlay.innerHTML = `
      <div class="ieh-modal">
        <div class="ieh-modal-header">
          <span class="ieh-modal-title">Top ${posts.length} Posts (of ${totalPosts} detected)</span>
          <button class="ieh-modal-close" title="Close">&times;</button>
        </div>
        <div class="ieh-modal-actions">
          <button id="ieh-copy-text" class="ieh-btn ieh-btn-sm">Copy as Text</button>
          <button id="ieh-copy-json" class="ieh-btn ieh-btn-sm">Copy JSON</button>
          <button id="ieh-download-csv" class="ieh-btn ieh-btn-sm">Download CSV</button>
        </div>
        <div class="ieh-modal-body">
          <table class="ieh-modal-table">
            <thead>
              <tr>
                <th>#</th>
                <th>User</th>
                <th>Likes</th>
                <th>Comments</th>
                <th>Views</th>
                <th>Score</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
          ${posts.length === 0 ? '<div class="ieh-modal-empty">No posts found. Try scrolling through the feed first to load posts.</div>' : ""}
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // ── Close ──
    overlay.querySelector(".ieh-modal-close").addEventListener("click", () => {
      overlay.remove();
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // ── Copy as Text ──
    document.getElementById("ieh-copy-text").addEventListener("click", () => {
      const lines = posts.map((p, i) => {
        const user = p.username ? `@${p.username}` : "unknown";
        const parts = [];
        if (p.likes > 0) parts.push(`${formatCount(p.likes)} likes`);
        if (p.comments > 0) parts.push(`${formatCount(p.comments)} comments`);
        if (p.views > 0) parts.push(`${formatCount(p.views)} views`);
        let line = `${i + 1}. ${user} — Score: ${p.score.toLocaleString()} (${parts.join(", ")})`;
        if (p.postUrl) line += `\n   ${p.postUrl}`;
        if (p.caption) line += `\n   "${p.caption}"`;
        return line;
      });
      const text = `Instagram Top ${posts.length} Posts\n${"=".repeat(40)}\n\n${lines.join("\n\n")}`;
      navigator.clipboard.writeText(text).then(() => {
        flashButton("ieh-copy-text", "Copied!");
      });
    });

    // ── Copy JSON ──
    document.getElementById("ieh-copy-json").addEventListener("click", () => {
      const data = posts.map((p, i) => ({
        rank: i + 1,
        username: p.username || null,
        postUrl: p.postUrl || null,
        caption: p.caption || null,
        likes: p.likes,
        comments: p.comments,
        views: p.views,
        score: p.score,
      }));
      navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => {
        flashButton("ieh-copy-json", "Copied!");
      });
    });

    // ── Download CSV ──
    document.getElementById("ieh-download-csv").addEventListener("click", () => {
      const header = "Rank,Username,Likes,Comments,Views,Score,Post URL,Caption";
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
          p.likes,
          p.comments,
          p.views,
          p.score,
          escapeCsv(p.postUrl || ""),
          escapeCsv(p.caption || ""),
        ].join(",");
      });
      const csv = header + "\n" + rows.join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `instagram-top-posts-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      flashButton("ieh-download-csv", "Downloaded!");
    });
  }

  function flashButton(id, text) {
    const btn = document.getElementById(id);
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = text;
    btn.classList.add("ieh-btn-flash");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("ieh-btn-flash");
    }, 1500);
  }

  // ─── Settings Persistence (local only) ───────────────────────────────

  function saveSettings() {
    try {
      chrome.storage.local.set({
        iehSettings: {
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
      chrome.storage.local.get("iehSettings", (result) => {
        if (result && result.iehSettings) {
          const s = result.iehSettings;
          enabled = s.enabled ?? true;
          showScores = s.showScores ?? true;
          mode = s.mode ?? "percentile";
          absoluteThreshold = s.absoluteThreshold ?? 100;
          weights = s.weights ?? { likes: 5, comments: 10, views: 2 };
          autoScrollSpeed = s.autoScrollSpeed ?? 2;
          // Don't restore autoScrollEnabled — always start with it off

          const enabledEl = document.getElementById("ieh-enabled");
          const showScoresEl = document.getElementById("ieh-show-scores");
          const modeEl = document.getElementById("ieh-mode");
          const thresholdEl = document.getElementById("ieh-threshold");
          const thresholdValEl = document.getElementById("ieh-threshold-val");
          const wLikesEl = document.getElementById("ieh-w-likes");
          const wCommentsEl = document.getElementById("ieh-w-comments");
          const wViewsEl = document.getElementById("ieh-w-views");
          const thresholdRow = document.querySelector(".ieh-threshold-row");
          const scrollSpeedEl = document.getElementById("ieh-scroll-speed");
          const scrollSpeedValEl = document.getElementById("ieh-scroll-speed-val");

          if (enabledEl) enabledEl.checked = enabled;
          if (showScoresEl) showScoresEl.checked = showScores;
          if (modeEl) modeEl.value = mode;
          if (thresholdEl) thresholdEl.value = absoluteThreshold;
          if (thresholdValEl) thresholdValEl.textContent = absoluteThreshold;
          if (wLikesEl) wLikesEl.value = weights.likes;
          if (wCommentsEl) wCommentsEl.value = weights.comments;
          if (wViewsEl) wViewsEl.value = weights.views;
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
        scrollTimer = setTimeout(() => {
          processAllPosts();
          updateExtractCount();
        }, 500);
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
