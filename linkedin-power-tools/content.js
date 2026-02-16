/**
 * LinkedIn Power Tools - Combined Content Script
 *
 * Merges two tools into one:
 *   A) Engagement Highlighter — scores & highlights high-engagement posts
 *   B) Activity Navigator    — auto-scrolls to older posts by target date
 *
 * Key scroll fix: scrolls DOWN, auto-clicks "Load more" buttons, and
 * scrolls UP briefly to trigger LinkedIn's lazy-loading when stalled.
 *
 * Read-only DOM interaction. No network requests. No data collection.
 */

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════
  // 1. NumberParser
  // ═══════════════════════════════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════════════════════════════
  // 2. DateParser
  // ═══════════════════════════════════════════════════════════════════════

  const DateParser = {
    patterns: [
      { regex: /(\d+)\s*s(?:ec(?:ond)?s?)?\s*ago/i, unit: "seconds" },
      { regex: /(\d+)\s*m(?:in(?:ute)?s?)?\s*ago/i, unit: "minutes" },
      { regex: /(\d+)\s*h(?:(?:ou)?rs?)?\s*ago/i, unit: "hours" },
      { regex: /(\d+)\s*d(?:ays?)?\s*ago/i, unit: "days" },
      { regex: /(\d+)\s*w(?:(?:ee)?ks?)?\s*ago/i, unit: "weeks" },
      { regex: /(\d+)\s*mo(?:nths?)?\s*ago/i, unit: "months" },
      { regex: /(\d+)\s*y(?:(?:ea)?rs?)?\s*ago/i, unit: "years" },
      { regex: /just now/i, unit: "now" },
      { regex: /yesterday/i, unit: "yesterday" },
      { regex: /(\d+)\s*w\b/i, unit: "weeks" },
      { regex: /(\d+)\s*mo\b/i, unit: "months" },
      { regex: /(\d+)\s*yr\b/i, unit: "years" },
    ],

    parseRelative(text) {
      if (!text) return null;
      text = text.trim().toLowerCase();
      for (const { regex, unit } of this.patterns) {
        const match = text.match(regex);
        if (!match) continue;
        const now = new Date();
        if (unit === "now") return now;
        if (unit === "yesterday") { now.setDate(now.getDate() - 1); return now; }
        const value = parseInt(match[1], 10);
        if (isNaN(value)) continue;
        switch (unit) {
          case "seconds": now.setSeconds(now.getSeconds() - value); break;
          case "minutes": now.setMinutes(now.getMinutes() - value); break;
          case "hours":   now.setHours(now.getHours() - value); break;
          case "days":    now.setDate(now.getDate() - value); break;
          case "weeks":   now.setDate(now.getDate() - value * 7); break;
          case "months":  now.setMonth(now.getMonth() - value); break;
          case "years":   now.setFullYear(now.getFullYear() - value); break;
        }
        return now;
      }
      return null;
    },

    extractTimestamp(el) {
      const selectors = [
        ".feed-shared-actor__sub-description span[aria-hidden='true']",
        ".feed-shared-actor__sub-description .visually-hidden",
        "time", "[datetime]",
        ".feed-shared-actor__sub-description",
        ".update-components-actor__sub-description span",
        ".update-components-actor__sub-description",
      ];
      for (const sel of selectors) {
        const nodes = el.querySelectorAll(sel);
        for (const node of nodes) {
          const dt = node.getAttribute("datetime");
          if (dt) { const d = new Date(dt); if (!isNaN(d.getTime())) return d; }
          const text = node.textContent.trim();
          if (this._looksLike(text)) { const d = this.parseRelative(text); if (d) return d; }
        }
      }
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (text.length > 1 && text.length < 40 && this._looksLike(text)) {
          const d = this.parseRelative(text); if (d) return d;
        }
      }
      return null;
    },

    _looksLike(text) {
      return /\d+\s*(sec|min|hour|day|week|month|year|mo|yr|hr|[smhdwy])\b/i.test(text) ||
        /just now/i.test(text) || /yesterday/i.test(text);
    },

    formatDate(date) {
      if (!date) return "Unknown";
      return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    },
    formatMonthYear(date) {
      if (!date) return "Unknown";
      return date.toLocaleDateString("en-US", { year: "numeric", month: "short" });
    },
  };

  // ═══════════════════════════════════════════════════════════════════════
  // 3. EngagementScorer
  // ═══════════════════════════════════════════════════════════════════════

  const EngagementScorer = {
    enabled: true,
    showScores: true,
    mode: "percentile",
    absoluteThreshold: 100,
    weights: { reactions: 1, comments: 3, reposts: 4 },
    debounceTimer: null,
    DEBOUNCE_MS: 300,

    findPostContainers() {
      const selectors = [
        "div[data-id] .feed-shared-update-v2",
        ".feed-shared-update-v2",
        'div[data-urn]',
        '[role="article"]',
      ];
      for (const sel of selectors) {
        const posts = Array.from(document.querySelectorAll(sel));
        if (posts.length > 0) return posts;
      }
      return [];
    },

    extractEngagement(postEl) {
      let reactions = 0, comments = 0, reposts = 0;

      const socialCounts = postEl.querySelector(".social-details-social-counts");
      if (socialCounts) {
        const reactionEl =
          socialCounts.querySelector(".social-details-social-counts__reactions-count") ||
          socialCounts.querySelector('[data-control-name="reactions_count"]') ||
          socialCounts.querySelector('button[aria-label*="reaction"] span');
        if (reactionEl) reactions = parseCount(reactionEl.textContent);

        for (const el of socialCounts.querySelectorAll(
          'button[aria-label*="comment"], .social-details-social-counts__comments'
        )) {
          const label = el.getAttribute("aria-label") || el.textContent || "";
          const m = label.match(/([\d,.]+[KMB]?)\s*comment/i);
          if (m) { comments = parseCount(m[1]); break; }
          const fb = label.match(/([\d,.]+[KMB]?)/);
          if (fb && label.toLowerCase().includes("comment")) { comments = parseCount(fb[1]); break; }
        }

        for (const el of socialCounts.querySelectorAll(
          'button[aria-label*="repost"], .social-details-social-counts__reposts'
        )) {
          const label = el.getAttribute("aria-label") || el.textContent || "";
          const m = label.match(/([\d,.]+[KMB]?)\s*repost/i);
          if (m) { reposts = parseCount(m[1]); break; }
          const fb = label.match(/([\d,.]+[KMB]?)/);
          if (fb && label.toLowerCase().includes("repost")) { reposts = parseCount(fb[1]); break; }
        }
      }

      if (reactions === 0 && comments === 0 && reposts === 0) {
        for (const btn of postEl.querySelectorAll("button[aria-label]")) {
          const label = btn.getAttribute("aria-label") || "";
          const lower = label.toLowerCase();
          if (lower.includes("reaction") || lower.includes("like")) {
            const m = label.match(/([\d,.]+[KMB]?)/);
            if (m) reactions = Math.max(reactions, parseCount(m[1]));
          }
          if (lower.includes("comment")) {
            const m = label.match(/([\d,.]+[KMB]?)/);
            if (m) comments = Math.max(comments, parseCount(m[1]));
          }
          if (lower.includes("repost") || lower.includes("share")) {
            const m = label.match(/([\d,.]+[KMB]?)/);
            if (m) reposts = Math.max(reposts, parseCount(m[1]));
          }
        }
      }

      if (reactions === 0 && comments === 0 && reposts === 0) {
        for (const span of postEl.querySelectorAll("span.social-details-social-counts__reactions-count")) {
          reactions = parseCount(span.textContent);
        }
        for (const span of postEl.querySelectorAll(".social-details-social-counts span")) {
          const text = span.textContent.trim().toLowerCase();
          if (text.includes("comment")) { const m = text.match(/([\d,.]+[KMB]?)/i); if (m) comments = parseCount(m[1]); }
          if (text.includes("repost")) { const m = text.match(/([\d,.]+[KMB]?)/i); if (m) reposts = parseCount(m[1]); }
        }
      }

      return { reactions, comments, reposts };
    },

    calculateScore(eng) {
      return eng.reactions * this.weights.reactions +
             eng.comments * this.weights.comments +
             eng.reposts * this.weights.reposts;
    },

    clearHighlights() {
      document.querySelectorAll(".lpt-tier1, .lpt-tier2").forEach((el) => el.classList.remove("lpt-tier1", "lpt-tier2"));
      document.querySelectorAll(".lpt-score-badge").forEach((el) => el.remove());
    },

    applyHighlights(scoredPosts) {
      if (scoredPosts.length === 0) return;
      if (this.mode === "percentile") {
        const sorted = [...scoredPosts].sort((a, b) => b.score - a.score);
        const top10 = sorted[Math.max(1, Math.ceil(sorted.length * 0.1)) - 1]?.score ?? Infinity;
        const median = sorted[Math.floor(sorted.length / 2)]?.score ?? 0;
        for (const { element, score } of scoredPosts) {
          element.classList.remove("lpt-tier1", "lpt-tier2");
          if (score >= top10 && score > 0) element.classList.add("lpt-tier1");
          else if (score >= median && score > 0) element.classList.add("lpt-tier2");
          if (this.showScores) this.addBadge(element, score);
        }
      } else {
        for (const { element, score } of scoredPosts) {
          element.classList.remove("lpt-tier1", "lpt-tier2");
          if (score >= this.absoluteThreshold * 2) element.classList.add("lpt-tier1");
          else if (score >= this.absoluteThreshold) element.classList.add("lpt-tier2");
          if (this.showScores) this.addBadge(element, score);
        }
      }
    },

    addBadge(element, score) {
      const old = element.querySelector(".lpt-score-badge");
      if (old) old.remove();
      if (!this.showScores) return;
      const badge = document.createElement("div");
      badge.className = "lpt-score-badge";
      badge.textContent = "Score: " + score.toLocaleString();
      if (window.getComputedStyle(element).position === "static") element.style.position = "relative";
      element.appendChild(badge);
    },

    processAllPosts() {
      if (!this.enabled) { this.clearHighlights(); return; }
      const posts = this.findPostContainers();
      const scored = posts.map((el) => ({
        element: el,
        score: this.calculateScore(this.extractEngagement(el)),
      }));
      this.clearHighlights();
      this.applyHighlights(scored);
    },

    debouncedProcess() {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.processAllPosts(), this.DEBOUNCE_MS);
    },
  };

  // ═══════════════════════════════════════════════════════════════════════
  // 4. MemoryManager
  // ═══════════════════════════════════════════════════════════════════════

  const MemoryManager = {
    MAX_VISIBLE_POSTS: 200,
    pruningEnabled: false,
    prunedCount: 0,
    prune(cards) {
      if (!this.pruningEnabled || cards.length <= this.MAX_VISIBLE_POSTS) return;
      const excess = cards.length - this.MAX_VISIBLE_POSTS;
      for (let i = 0; i < excess; i++) {
        const card = cards[i];
        if (card && card.parentNode) {
          const ph = document.createElement("div");
          ph.className = "lpt-pruned-placeholder";
          ph.style.height = card.offsetHeight + "px";
          card.parentNode.replaceChild(ph, card);
          this.prunedCount++;
        }
      }
    },
    reset() { this.prunedCount = 0; },
  };

  // ═══════════════════════════════════════════════════════════════════════
  // 5. ProgressEstimator
  // ═══════════════════════════════════════════════════════════════════════

  const ProgressEstimator = {
    targetDate: null, startDate: null, oldestDetected: null,
    setTarget(date) { this.targetDate = date; this.startDate = new Date(); this.oldestDetected = new Date(); },
    updateOldest(date) {
      if (!date) return;
      if (!this.oldestDetected || date < this.oldestDetected) this.oldestDetected = date;
    },
    getProgress() {
      if (!this.targetDate || !this.startDate || !this.oldestDetected) return 0;
      const total = this.startDate.getTime() - this.targetDate.getTime();
      if (total <= 0) return 100;
      const covered = this.startDate.getTime() - this.oldestDetected.getTime();
      return Math.round(Math.min(100, Math.max(0, (covered / total) * 100)));
    },
    hasReachedTarget() {
      return this.targetDate && this.oldestDetected && this.oldestDetected <= this.targetDate;
    },
    reset() { this.targetDate = null; this.startDate = null; this.oldestDetected = null; },
  };

  // ═══════════════════════════════════════════════════════════════════════
  // 6. ScrollController  (scroll down + click Load More + scroll up jog)
  // ═══════════════════════════════════════════════════════════════════════

  const ScrollController = {
    isScrolling: false,
    shouldStop: false,
    scrollAttempts: 0,
    maxScrollAttempts: 3000,
    noNewContentCount: 0,
    maxNoNewContent: 15,
    lastCardCount: 0,
    observer: null,
    contentLoaded: false,
    scrollBatchPx: 800,
    baseDelay: 1200,
    adaptiveDelay: 1200,

    LOAD_MORE_SELECTORS: [
      ".scaffold-finite-scroll__load-button",
      'button.scaffold-finite-scroll__load-button',
      'button[aria-label*="Show more"]',
      'button[aria-label*="Load more"]',
      'button[aria-label*="show more"]',
      'button[aria-label*="load more"]',
    ],

    LOAD_MORE_TEXT: [
      /show\s*more\s*(results|posts|activity)?/i,
      /load\s*more/i,
      /see\s*more\s*(activity|posts)/i,
    ],

    findActivityCards() {
      const selectors = [
        ".feed-shared-update-v2",
        'div[data-urn*="activity"]',
        ".profile-creator-shared-feed-update__container",
        '[role="article"]',
        ".occludable-update",
      ];
      for (const sel of selectors) {
        const cards = document.querySelectorAll(sel);
        if (cards.length > 0) return Array.from(cards);
      }
      return [];
    },

    /** Try to find and click a "Load more" / "Show more" button. */
    tryClickLoadMore() {
      for (const sel of this.LOAD_MORE_SELECTORS) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null && !btn.disabled) { btn.click(); return true; }
      }
      for (const btn of document.querySelectorAll("button")) {
        if (btn.offsetParent === null || btn.disabled) continue;
        const text = btn.textContent.trim();
        for (const pattern of this.LOAD_MORE_TEXT) {
          if (pattern.test(text)) { btn.click(); return true; }
        }
      }
      return false;
    },

    setupContentObserver() {
      if (this.observer) this.observer.disconnect();
      this.contentLoaded = false;
      const target =
        document.querySelector(".scaffold-finite-scroll__content") ||
        document.querySelector("main") ||
        document.body;
      this.observer = new MutationObserver(() => { this.contentLoaded = true; });
      this.observer.observe(target, { childList: true, subtree: true });
    },

    waitForContent(timeoutMs) {
      return new Promise((resolve) => {
        if (this.contentLoaded) { this.contentLoaded = false; resolve(true); return; }
        let elapsed = 0;
        const id = setInterval(() => {
          elapsed += 100;
          if (this.contentLoaded || elapsed >= timeoutMs) {
            clearInterval(id);
            const ok = this.contentLoaded;
            this.contentLoaded = false;
            resolve(ok);
          }
        }, 100);
      });
    },

    /** Scroll up briefly then back down to jog LinkedIn's lazy-loader. */
    async scrollUpThenDown() {
      window.scrollBy({ top: -300, behavior: "smooth" });
      await this.sleep(500);
      window.scrollBy({ top: 400, behavior: "smooth" });
      await this.sleep(600);
    },

    /**
     * One full scroll attempt with fallback chain:
     *   1. Scroll down
     *   2. If no new content → click "Load more"
     *   3. If still nothing  → scroll up then back down
     */
    async scrollOnce() {
      // Step 1: scroll down
      window.scrollBy({ top: this.scrollBatchPx, behavior: "smooth" });
      this.scrollAttempts++;

      const loaded = await this.waitForContent(this.adaptiveDelay + 1000);
      if (loaded) {
        this.adaptiveDelay = Math.max(this.baseDelay, this.adaptiveDelay - 100);
        await this.sleep(300);
        return;
      }

      // Step 2: click "Load more"
      if (this.tryClickLoadMore()) {
        await this.waitForContent(3000);
        await this.sleep(500);
        return;
      }

      // Step 3: scroll up jog
      await this.scrollUpThenDown();
      const jogLoaded = await this.waitForContent(2000);
      if (!jogLoaded) {
        this.adaptiveDelay = Math.min(this.adaptiveDelay + 200, 4000);
      }
      await this.sleep(300);
    },

    processVisibleCards() {
      const cards = this.findActivityCards();
      if (cards.length === this.lastCardCount) {
        this.noNewContentCount++;
      } else {
        this.noNewContentCount = 0;
        this.lastCardCount = cards.length;
      }
      const start = Math.max(0, cards.length - 20);
      for (let i = start; i < cards.length; i++) {
        const date = DateParser.extractTimestamp(cards[i]);
        if (date) ProgressEstimator.updateOldest(date);
      }
      MemoryManager.prune(cards);
      EngagementScorer.debouncedProcess();
      return cards;
    },

    checkStopConditions() {
      if (this.shouldStop) return "User stopped";
      if (this.scrollAttempts >= this.maxScrollAttempts) return "Max scroll attempts reached";
      if (this.noNewContentCount >= this.maxNoNewContent) return "No more content loading";
      if (ProgressEstimator.hasReachedTarget()) return "Target date reached";
      const endEl = document.querySelector(".artdeco-empty-state");
      if (endEl) return "End of activity feed";
      const loadBtn = document.querySelector(".scaffold-finite-scroll__load-button");
      if (loadBtn && loadBtn.classList.contains("scaffold-finite-scroll__load-button--hide")) return "End of activity feed";
      return null;
    },

    async start(targetDate) {
      if (this.isScrolling) return;
      this.isScrolling = true;
      this.shouldStop = false;
      this.scrollAttempts = 0;
      this.noNewContentCount = 0;
      this.lastCardCount = 0;
      this.adaptiveDelay = this.baseDelay;

      ProgressEstimator.setTarget(targetDate);
      MemoryManager.reset();
      this.setupContentObserver();
      notifyBackground("scrolling");
      UIController.onScrollStart();

      try {
        while (true) {
          await this.yieldToMain();
          const stop = this.checkStopConditions();
          if (stop) { UIController.onScrollComplete(stop); break; }
          await this.scrollOnce();
          this.processVisibleCards();
          UIController.updateProgress();
          if (this.scrollAttempts > 0 && this.scrollAttempts % 50 === 0) {
            await this.sleep(2000 + Math.random() * 2000);
          }
        }
      } catch (err) {
        UIController.onScrollComplete("Error: " + err.message);
      } finally {
        this.isScrolling = false;
        if (this.observer) { this.observer.disconnect(); this.observer = null; }
        notifyBackground(ProgressEstimator.hasReachedTarget() ? "done" : "stopped");
      }
    },

    stop() { this.shouldStop = true; },
    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
    yieldToMain() {
      return new Promise((r) => {
        if (typeof requestIdleCallback === "function") requestIdleCallback(() => r(), { timeout: 100 });
        else setTimeout(r, 0);
      });
    },
  };

  // ═══════════════════════════════════════════════════════════════════════
  // 7. UIController — Unified Tabbed Panel
  // ═══════════════════════════════════════════════════════════════════════

  const UIController = {
    panel: null,

    createPanel() {
      if (document.getElementById("lpt-panel")) return;

      const panel = document.createElement("div");
      panel.id = "lpt-panel";
      panel.innerHTML = `
        <div class="lpt-panel-header">
          <span class="lpt-panel-title">LinkedIn Power Tools</span>
          <button class="lpt-panel-collapse" title="Minimize">&#x2212;</button>
        </div>
        <div class="lpt-panel-body">
          <div class="lpt-tab-bar">
            <button class="lpt-tab lpt-tab--active" data-tab="engagement">Engagement</button>
            <button class="lpt-tab" data-tab="navigator">Navigator</button>
          </div>

          <!-- ENGAGEMENT TAB -->
          <div class="lpt-tab-content lpt-tab-content--active" data-tab="engagement">
            <div class="lpt-control-row">
              <label class="lpt-label"><input type="checkbox" id="lpt-eng-enabled" checked /> Enabled</label>
            </div>
            <div class="lpt-control-row">
              <label class="lpt-label"><input type="checkbox" id="lpt-eng-scores" checked /> Show Scores</label>
            </div>
            <div class="lpt-control-row">
              <label class="lpt-label">Mode:</label>
              <select id="lpt-eng-mode">
                <option value="percentile">Percentile</option>
                <option value="threshold">Threshold</option>
              </select>
            </div>
            <div class="lpt-control-row lpt-threshold-row" style="display:none;">
              <label class="lpt-label">Threshold:</label>
              <input type="range" id="lpt-eng-threshold" min="10" max="5000" value="100" step="10" />
              <span id="lpt-eng-threshold-val">100</span>
            </div>
            <div class="lpt-section-label">Weights</div>
            <div class="lpt-control-row">
              <label class="lpt-label">Reactions:</label>
              <input type="number" id="lpt-w-reactions" value="1" min="0" max="20" step="0.5" class="lpt-num-input" />
            </div>
            <div class="lpt-control-row">
              <label class="lpt-label">Comments:</label>
              <input type="number" id="lpt-w-comments" value="3" min="0" max="20" step="0.5" class="lpt-num-input" />
            </div>
            <div class="lpt-control-row">
              <label class="lpt-label">Reposts:</label>
              <input type="number" id="lpt-w-reposts" value="4" min="0" max="20" step="0.5" class="lpt-num-input" />
            </div>
            <button id="lpt-recalculate" class="lpt-btn">Recalculate</button>
          </div>

          <!-- NAVIGATOR TAB -->
          <div class="lpt-tab-content" data-tab="navigator">
            <div class="lpt-section-label" style="margin-top:0;border:none;padding-top:0;">Quick Scroll</div>
            <div class="lpt-button-group">
              <button class="lpt-btn lpt-btn-preset" data-months="3">3 Months</button>
              <button class="lpt-btn lpt-btn-preset" data-months="6">6 Months</button>
            </div>
            <div class="lpt-button-group">
              <button class="lpt-btn lpt-btn-preset" data-months="12">1 Year</button>
              <button class="lpt-btn lpt-btn-custom" id="lpt-custom-btn">Custom Date</button>
            </div>
            <div class="lpt-custom-date-row" id="lpt-custom-row" style="display:none;">
              <input type="date" id="lpt-date-input" class="lpt-date-input" />
              <button class="lpt-btn lpt-btn-go" id="lpt-go-btn">Go</button>
            </div>
            <div class="lpt-section-label">Options</div>
            <div class="lpt-control-row">
              <label class="lpt-label"><input type="checkbox" id="lpt-memory-safe" /> Memory-safe mode</label>
            </div>
            <div class="lpt-divider"></div>
            <button class="lpt-btn lpt-btn-stop" id="lpt-stop-btn" style="display:none;">Stop Scrolling</button>
            <div class="lpt-progress-section" id="lpt-progress" style="display:none;">
              <div class="lpt-progress-bar-track"><div class="lpt-progress-bar-fill" id="lpt-progress-fill"></div></div>
              <div class="lpt-progress-text"><span id="lpt-progress-pct">0%</span></div>
              <div class="lpt-progress-dates">
                <div class="lpt-progress-date"><span class="lpt-date-label">Current:</span><span id="lpt-current-date">&mdash;</span></div>
                <div class="lpt-progress-date"><span class="lpt-date-label">Target:</span><span id="lpt-target-date">&mdash;</span></div>
              </div>
              <div class="lpt-scroll-stats" id="lpt-stats" style="display:none;"><span id="lpt-stats-text"></span></div>
            </div>
            <div class="lpt-status" id="lpt-status"></div>
          </div>
        </div>
      `;

      document.body.appendChild(panel);
      this.panel = panel;
      this.bindEvents();
      this.loadSettings();
      this.makeDraggable();
    },

    bindEvents() {
      // Tabs
      const tabs = this.panel.querySelectorAll(".lpt-tab");
      const contents = this.panel.querySelectorAll(".lpt-tab-content");
      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          tabs.forEach((t) => t.classList.remove("lpt-tab--active"));
          contents.forEach((c) => c.classList.remove("lpt-tab-content--active"));
          tab.classList.add("lpt-tab--active");
          this.panel.querySelector('.lpt-tab-content[data-tab="' + tab.dataset.tab + '"]')
            .classList.add("lpt-tab-content--active");
        });
      });

      // Collapse
      let collapsed = false;
      const collapseBtn = this.panel.querySelector(".lpt-panel-collapse");
      const body = this.panel.querySelector(".lpt-panel-body");
      collapseBtn.addEventListener("click", () => {
        collapsed = !collapsed;
        body.style.display = collapsed ? "none" : "block";
        collapseBtn.textContent = collapsed ? "+" : "\u2212";
        this.panel.classList.toggle("lpt-collapsed", collapsed);
      });

      // Engagement controls
      document.getElementById("lpt-eng-enabled").addEventListener("change", (e) => {
        EngagementScorer.enabled = e.target.checked; EngagementScorer.processAllPosts(); this.saveSettings();
      });
      document.getElementById("lpt-eng-scores").addEventListener("change", (e) => {
        EngagementScorer.showScores = e.target.checked; EngagementScorer.processAllPosts(); this.saveSettings();
      });
      document.getElementById("lpt-eng-mode").addEventListener("change", (e) => {
        EngagementScorer.mode = e.target.value;
        this.panel.querySelector(".lpt-threshold-row").style.display = e.target.value === "threshold" ? "flex" : "none";
        EngagementScorer.processAllPosts(); this.saveSettings();
      });
      document.getElementById("lpt-eng-threshold").addEventListener("input", (e) => {
        EngagementScorer.absoluteThreshold = parseInt(e.target.value, 10);
        document.getElementById("lpt-eng-threshold-val").textContent = EngagementScorer.absoluteThreshold;
        this.saveSettings();
      });
      document.getElementById("lpt-eng-threshold").addEventListener("change", () => EngagementScorer.processAllPosts());
      document.getElementById("lpt-w-reactions").addEventListener("change", (e) => { EngagementScorer.weights.reactions = parseFloat(e.target.value) || 0; this.saveSettings(); });
      document.getElementById("lpt-w-comments").addEventListener("change", (e) => { EngagementScorer.weights.comments = parseFloat(e.target.value) || 0; this.saveSettings(); });
      document.getElementById("lpt-w-reposts").addEventListener("change", (e) => { EngagementScorer.weights.reposts = parseFloat(e.target.value) || 0; this.saveSettings(); });
      document.getElementById("lpt-recalculate").addEventListener("click", () => EngagementScorer.processAllPosts());

      // Navigator controls
      this.panel.querySelectorAll(".lpt-btn-preset").forEach((btn) => {
        btn.addEventListener("click", () => {
          const target = new Date();
          target.setMonth(target.getMonth() - parseInt(btn.dataset.months, 10));
          this.startScrollTo(target);
        });
      });
      document.getElementById("lpt-custom-btn").addEventListener("click", () => {
        const row = document.getElementById("lpt-custom-row");
        row.style.display = row.style.display !== "none" ? "none" : "flex";
        if (row.style.display === "flex") document.getElementById("lpt-date-input").focus();
      });
      document.getElementById("lpt-go-btn").addEventListener("click", () => {
        const date = new Date(document.getElementById("lpt-date-input").value);
        if (isNaN(date.getTime())) { this.setStatus("Please enter a valid date.", "error"); return; }
        if (date > new Date()) { this.setStatus("Target date must be in the past.", "error"); return; }
        this.startScrollTo(date);
      });
      document.getElementById("lpt-stop-btn").addEventListener("click", () => ScrollController.stop());
      document.getElementById("lpt-memory-safe").addEventListener("change", (e) => {
        MemoryManager.pruningEnabled = e.target.checked; this.saveSettings();
      });
    },

    startScrollTo(targetDate) {
      if (ScrollController.isScrolling) { this.setStatus("Already scrolling. Stop first.", "error"); return; }
      const navTab = this.panel.querySelector('.lpt-tab[data-tab="navigator"]');
      if (navTab) navTab.click();
      document.getElementById("lpt-target-date").textContent = DateParser.formatDate(targetDate);
      this.clearStatus();
      ScrollController.start(targetDate);
    },

    onScrollStart() {
      document.getElementById("lpt-stop-btn").style.display = "block";
      document.getElementById("lpt-progress").style.display = "block";
      document.getElementById("lpt-stats").style.display = "none";
      document.getElementById("lpt-progress-fill").style.width = "0%";
      document.getElementById("lpt-progress-pct").textContent = "0%";
      document.getElementById("lpt-current-date").textContent = "Detecting...";
      this.clearStatus();
      this.panel.querySelectorAll(".lpt-btn-preset, .lpt-btn-custom, .lpt-btn-go").forEach((b) => { b.disabled = true; });
    },

    updateProgress() {
      const pct = ProgressEstimator.getProgress();
      document.getElementById("lpt-progress-fill").style.width = pct + "%";
      document.getElementById("lpt-progress-pct").textContent = pct + "%";
      if (ProgressEstimator.oldestDetected) {
        document.getElementById("lpt-current-date").textContent = DateParser.formatMonthYear(ProgressEstimator.oldestDetected);
      }
    },

    onScrollComplete(reason) {
      document.getElementById("lpt-stop-btn").style.display = "none";
      this.panel.querySelectorAll(".lpt-btn-preset, .lpt-btn-custom, .lpt-btn-go").forEach((b) => { b.disabled = false; });
      this.updateProgress();
      document.getElementById("lpt-stats").style.display = "block";
      document.getElementById("lpt-stats-text").textContent =
        "Scrolls: " + ScrollController.scrollAttempts + " | Posts: ~" + ScrollController.lastCardCount +
        (MemoryManager.prunedCount > 0 ? " | Pruned: " + MemoryManager.prunedCount : "");
      this.setStatus(reason, reason === "Target date reached" ? "success" : "info");
    },

    setStatus(msg, type) {
      const el = document.getElementById("lpt-status");
      el.textContent = msg;
      el.className = "lpt-status";
      if (type) el.classList.add("lpt-status--" + type);
    },
    clearStatus() { const el = document.getElementById("lpt-status"); el.textContent = ""; el.className = "lpt-status"; },

    makeDraggable() {
      const header = this.panel.querySelector(".lpt-panel-header");
      const collapseBtn = this.panel.querySelector(".lpt-panel-collapse");
      let dragging = false, ox = 0, oy = 0;
      header.addEventListener("mousedown", (e) => {
        if (e.target === collapseBtn) return;
        dragging = true; ox = e.clientX - this.panel.getBoundingClientRect().left; oy = e.clientY - this.panel.getBoundingClientRect().top; e.preventDefault();
      });
      document.addEventListener("mousemove", (e) => { if (!dragging) return; this.panel.style.right = "auto"; this.panel.style.left = (e.clientX - ox) + "px"; this.panel.style.top = (e.clientY - oy) + "px"; });
      document.addEventListener("mouseup", () => { dragging = false; });
    },

    saveSettings() {
      try {
        chrome.storage.local.set({ lptSettings: {
          engEnabled: EngagementScorer.enabled, engShowScores: EngagementScorer.showScores,
          engMode: EngagementScorer.mode, engThreshold: EngagementScorer.absoluteThreshold,
          engWeights: EngagementScorer.weights, memoryPruning: MemoryManager.pruningEnabled,
        }});
      } catch { /* storage unavailable */ }
    },

    loadSettings() {
      try {
        chrome.storage.local.get("lptSettings", (result) => {
          if (!result || !result.lptSettings) return;
          const s = result.lptSettings;
          EngagementScorer.enabled = s.engEnabled ?? true;
          EngagementScorer.showScores = s.engShowScores ?? true;
          EngagementScorer.mode = s.engMode ?? "percentile";
          EngagementScorer.absoluteThreshold = s.engThreshold ?? 100;
          EngagementScorer.weights = s.engWeights ?? { reactions: 1, comments: 3, reposts: 4 };
          MemoryManager.pruningEnabled = s.memoryPruning ?? false;

          const el = (id) => document.getElementById(id);
          if (el("lpt-eng-enabled")) el("lpt-eng-enabled").checked = EngagementScorer.enabled;
          if (el("lpt-eng-scores")) el("lpt-eng-scores").checked = EngagementScorer.showScores;
          if (el("lpt-eng-mode")) el("lpt-eng-mode").value = EngagementScorer.mode;
          if (el("lpt-eng-threshold")) el("lpt-eng-threshold").value = EngagementScorer.absoluteThreshold;
          if (el("lpt-eng-threshold-val")) el("lpt-eng-threshold-val").textContent = EngagementScorer.absoluteThreshold;
          if (el("lpt-w-reactions")) el("lpt-w-reactions").value = EngagementScorer.weights.reactions;
          if (el("lpt-w-comments")) el("lpt-w-comments").value = EngagementScorer.weights.comments;
          if (el("lpt-w-reposts")) el("lpt-w-reposts").value = EngagementScorer.weights.reposts;
          if (el("lpt-memory-safe")) el("lpt-memory-safe").checked = MemoryManager.pruningEnabled;
          const tr = document.querySelector(".lpt-threshold-row");
          if (tr) tr.style.display = EngagementScorer.mode === "threshold" ? "flex" : "none";
          EngagementScorer.processAllPosts();
        });
      } catch { /* storage unavailable */ }
    },
  };

  // ═══════════════════════════════════════════════════════════════════════
  // Helpers & Init
  // ═══════════════════════════════════════════════════════════════════════

  function notifyBackground(state) {
    try { chrome.runtime.sendMessage({ type: "scrollStateChanged", state }); } catch {}
  }

  function init() {
    UIController.createPanel();

    const feedContainer =
      document.querySelector(".scaffold-finite-scroll__content") ||
      document.querySelector("main") ||
      document.body;

    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes.length > 0) { EngagementScorer.debouncedProcess(); break; }
      }
    }).observe(feedContainer, { childList: true, subtree: true });

    setTimeout(() => EngagementScorer.processAllPosts(), 1000);

    let scrollTimer = null;
    window.addEventListener("scroll", () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => EngagementScorer.processAllPosts(), 500);
    }, { passive: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
