/**
 * LinkedIn Activity Navigator - Content Script
 *
 * Core modules:
 *   1. DateParser        — Converts relative timestamps to absolute dates
 *   2. MemoryManager     — Prunes DOM nodes above viewport to cap memory
 *   3. ProgressEstimator — Estimates scroll progress toward target date
 *   4. ScrollController  — Batch-scrolls with MutationObserver + idle waits
 *   5. UIController      — Floating control panel and progress display
 *
 * Read-only interaction with DOM. No scraping APIs. No data collection.
 */

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════
  // 1. DateParser
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
      // LinkedIn also uses short forms like "2w", "3mo", "1yr"
      { regex: /(\d+)\s*w\b/i, unit: "weeks" },
      { regex: /(\d+)\s*mo\b/i, unit: "months" },
      { regex: /(\d+)\s*yr\b/i, unit: "years" },
    ],

    /**
     * Convert a relative timestamp string ("3 weeks ago", "5mo")
     * into an approximate absolute Date.
     */
    parseRelative(text) {
      if (!text) return null;
      text = text.trim().toLowerCase();

      for (const { regex, unit } of this.patterns) {
        const match = text.match(regex);
        if (!match) continue;

        const now = new Date();

        if (unit === "now") return now;
        if (unit === "yesterday") {
          now.setDate(now.getDate() - 1);
          return now;
        }

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

    /**
     * Extract the timestamp from an activity card element.
     * LinkedIn uses various selectors for time display.
     */
    extractTimestamp(activityEl) {
      const selectors = [
        ".feed-shared-actor__sub-description span[aria-hidden='true']",
        ".feed-shared-actor__sub-description .visually-hidden",
        "time",
        "[datetime]",
        ".feed-shared-actor__sub-description",
        ".update-components-actor__sub-description span",
        ".update-components-actor__sub-description",
      ];

      for (const selector of selectors) {
        const els = activityEl.querySelectorAll(selector);
        for (const el of els) {
          // Check datetime attribute first
          const dt = el.getAttribute("datetime");
          if (dt) {
            const parsed = new Date(dt);
            if (!isNaN(parsed.getTime())) return parsed;
          }

          const text = el.textContent.trim();
          if (this._looksLikeTimestamp(text)) {
            const parsed = this.parseRelative(text);
            if (parsed) return parsed;
          }
        }
      }

      // Fallback: walk text nodes for time-like patterns
      const walker = document.createTreeWalker(
        activityEl,
        NodeFilter.SHOW_TEXT,
        null
      );
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (text.length > 1 && text.length < 40 && this._looksLikeTimestamp(text)) {
          const parsed = this.parseRelative(text);
          if (parsed) return parsed;
        }
      }

      return null;
    },

    _looksLikeTimestamp(text) {
      return (
        /\d+\s*(sec|min|hour|day|week|month|year|mo|yr|hr|[smhdwy])\b/i.test(text) ||
        /just now/i.test(text) ||
        /yesterday/i.test(text)
      );
    },

    formatDate(date) {
      if (!date) return "Unknown";
      return date.toLocaleDateString("en-US", {
        year: "numeric", month: "short", day: "numeric",
      });
    },

    formatMonthYear(date) {
      if (!date) return "Unknown";
      return date.toLocaleDateString("en-US", {
        year: "numeric", month: "short",
      });
    },
  };

  // ═══════════════════════════════════════════════════════════════════════
  // 2. MemoryManager
  // ═══════════════════════════════════════════════════════════════════════

  const MemoryManager = {
    MAX_VISIBLE_POSTS: 200,
    pruningEnabled: false,
    prunedCount: 0,

    /**
     * Remove oldest DOM nodes above viewport to cap memory.
     * Replaces removed cards with lightweight height-preserving placeholders.
     */
    prune(activityCards) {
      if (!this.pruningEnabled) return;
      if (activityCards.length <= this.MAX_VISIBLE_POSTS) return;

      const excess = activityCards.length - this.MAX_VISIBLE_POSTS;
      for (let i = 0; i < excess; i++) {
        const card = activityCards[i];
        if (card && card.parentNode) {
          const placeholder = document.createElement("div");
          placeholder.className = "lan-pruned-placeholder";
          placeholder.style.height = card.offsetHeight + "px";
          card.parentNode.replaceChild(placeholder, card);
          this.prunedCount++;
        }
      }
    },

    reset() {
      this.prunedCount = 0;
    },
  };

  // ═══════════════════════════════════════════════════════════════════════
  // 3. ProgressEstimator
  // ═══════════════════════════════════════════════════════════════════════

  const ProgressEstimator = {
    targetDate: null,
    startDate: null,
    oldestDetected: null,

    setTarget(date) {
      this.targetDate = date;
      this.startDate = new Date();
      this.oldestDetected = new Date();
    },

    updateOldest(date) {
      if (!date) return;
      if (!this.oldestDetected || date < this.oldestDetected) {
        this.oldestDetected = date;
      }
    },

    /** Progress as 0–100 based on how far back we've scrolled vs target. */
    getProgress() {
      if (!this.targetDate || !this.startDate || !this.oldestDetected) return 0;

      const totalRange = this.startDate.getTime() - this.targetDate.getTime();
      if (totalRange <= 0) return 100;

      const covered = this.startDate.getTime() - this.oldestDetected.getTime();
      return Math.round(Math.min(100, Math.max(0, (covered / totalRange) * 100)));
    },

    hasReachedTarget() {
      if (!this.targetDate || !this.oldestDetected) return false;
      return this.oldestDetected <= this.targetDate;
    },

    reset() {
      this.targetDate = null;
      this.startDate = null;
      this.oldestDetected = null;
    },
  };

  // ═══════════════════════════════════════════════════════════════════════
  // 4. ScrollController
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

    /** Find all activity card elements on the page. */
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

    /** MutationObserver to detect new content loads. */
    setupContentObserver() {
      if (this.observer) this.observer.disconnect();
      this.contentLoaded = false;

      const target =
        document.querySelector(".scaffold-finite-scroll__content") ||
        document.querySelector("main") ||
        document.body;

      this.observer = new MutationObserver(() => {
        this.contentLoaded = true;
      });

      this.observer.observe(target, { childList: true, subtree: true });
    },

    /** Wait for new DOM content or timeout. */
    waitForContent(timeoutMs) {
      return new Promise((resolve) => {
        if (this.contentLoaded) {
          this.contentLoaded = false;
          resolve(true);
          return;
        }

        const interval = 100;
        let elapsed = 0;
        const id = setInterval(() => {
          elapsed += interval;
          if (this.contentLoaded || elapsed >= timeoutMs) {
            clearInterval(id);
            const loaded = this.contentLoaded;
            this.contentLoaded = false;
            resolve(loaded);
          }
        }, interval);
      });
    },

    /** Scroll down one batch, wait for content. */
    async scrollOnce() {
      window.scrollBy({ top: this.scrollBatchPx, behavior: "smooth" });
      this.scrollAttempts++;

      const loaded = await this.waitForContent(this.adaptiveDelay + 1000);

      // Adaptive delay: slow down if content isn't loading, speed up if it is
      if (!loaded) {
        this.adaptiveDelay = Math.min(this.adaptiveDelay + 200, 4000);
      } else {
        this.adaptiveDelay = Math.max(this.baseDelay, this.adaptiveDelay - 100);
      }

      await this.sleep(300);
    },

    /** Process visible cards: extract dates, update progress, prune memory. */
    processVisibleCards() {
      const cards = this.findActivityCards();

      if (cards.length === this.lastCardCount) {
        this.noNewContentCount++;
      } else {
        this.noNewContentCount = 0;
        this.lastCardCount = cards.length;
      }

      // Extract dates from the newest batch at the bottom
      const start = Math.max(0, cards.length - 20);
      for (let i = start; i < cards.length; i++) {
        const date = DateParser.extractTimestamp(cards[i]);
        if (date) ProgressEstimator.updateOldest(date);
      }

      MemoryManager.prune(cards);
      return cards;
    },

    /** Check all stop conditions. Returns reason string or null. */
    checkStopConditions() {
      if (this.shouldStop) return "User stopped";
      if (this.scrollAttempts >= this.maxScrollAttempts) return "Max scroll attempts reached";
      if (this.noNewContentCount >= this.maxNoNewContent) return "No more content loading";
      if (ProgressEstimator.hasReachedTarget()) return "Target date reached";

      const endSelectors = [
        ".scaffold-finite-scroll__load-button--hide",
        ".artdeco-empty-state",
      ];
      for (const sel of endSelectors) {
        if (document.querySelector(sel)) return "End of activity feed";
      }

      return null;
    },

    /** Main scroll loop. */
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

          const stopReason = this.checkStopConditions();
          if (stopReason) {
            UIController.onScrollComplete(stopReason);
            break;
          }

          await this.scrollOnce();
          this.processVisibleCards();
          UIController.updateProgress();

          // Human-like pause every 50 scrolls
          if (this.scrollAttempts > 0 && this.scrollAttempts % 50 === 0) {
            await this.sleep(2000 + Math.random() * 2000);
          }
        }
      } catch (err) {
        UIController.onScrollComplete("Error: " + err.message);
      } finally {
        this.isScrolling = false;
        if (this.observer) {
          this.observer.disconnect();
          this.observer = null;
        }
        notifyBackground(ProgressEstimator.hasReachedTarget() ? "done" : "stopped");
      }
    },

    stop() {
      this.shouldStop = true;
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    yieldToMain() {
      return new Promise((resolve) => {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(() => resolve(), { timeout: 100 });
        } else {
          setTimeout(resolve, 0);
        }
      });
    },
  };

  // ═══════════════════════════════════════════════════════════════════════
  // 5. UIController
  // ═══════════════════════════════════════════════════════════════════════

  const UIController = {
    panel: null,

    createPanel() {
      if (document.getElementById("lan-panel")) return;

      const panel = document.createElement("div");
      panel.id = "lan-panel";
      panel.innerHTML = `
        <div class="lan-panel-header">
          <span class="lan-panel-title">Activity Navigator</span>
          <button class="lan-panel-collapse" title="Minimize">&#x2212;</button>
        </div>
        <div class="lan-panel-body">
          <div class="lan-section-label">Quick Scroll</div>
          <div class="lan-button-group">
            <button class="lan-btn lan-btn-preset" data-months="3">3 Months</button>
            <button class="lan-btn lan-btn-preset" data-months="6">6 Months</button>
          </div>
          <div class="lan-button-group">
            <button class="lan-btn lan-btn-preset" data-months="12">1 Year</button>
            <button class="lan-btn lan-btn-custom" id="lan-custom-btn">Custom Date</button>
          </div>

          <div class="lan-custom-date-row" id="lan-custom-row" style="display:none;">
            <input type="date" id="lan-date-input" class="lan-date-input" />
            <button class="lan-btn lan-btn-go" id="lan-go-btn">Go</button>
          </div>

          <div class="lan-section-label">Options</div>
          <div class="lan-control-row">
            <label class="lan-label">
              <input type="checkbox" id="lan-memory-safe" />
              Memory-safe mode
            </label>
          </div>

          <div class="lan-divider"></div>

          <button class="lan-btn lan-btn-stop" id="lan-stop-btn" style="display:none;">
            Stop Scrolling
          </button>

          <div class="lan-progress-section" id="lan-progress" style="display:none;">
            <div class="lan-progress-bar-track">
              <div class="lan-progress-bar-fill" id="lan-progress-fill"></div>
            </div>
            <div class="lan-progress-text">
              <span id="lan-progress-pct">0%</span>
            </div>
            <div class="lan-progress-dates">
              <div class="lan-progress-date">
                <span class="lan-date-label">Current:</span>
                <span id="lan-current-date">&mdash;</span>
              </div>
              <div class="lan-progress-date">
                <span class="lan-date-label">Target:</span>
                <span id="lan-target-date">&mdash;</span>
              </div>
            </div>
            <div class="lan-scroll-stats" id="lan-stats" style="display:none;">
              <span id="lan-stats-text"></span>
            </div>
          </div>

          <div class="lan-status" id="lan-status"></div>
        </div>
      `;

      document.body.appendChild(panel);
      this.panel = panel;

      this.bindEvents();
      this.loadSettings();
      this.makeDraggable();
    },

    bindEvents() {
      // Collapse toggle
      let collapsed = false;
      const collapseBtn = this.panel.querySelector(".lan-panel-collapse");
      const body = this.panel.querySelector(".lan-panel-body");
      collapseBtn.addEventListener("click", () => {
        collapsed = !collapsed;
        body.style.display = collapsed ? "none" : "block";
        collapseBtn.textContent = collapsed ? "+" : "\u2212";
        this.panel.classList.toggle("lan-collapsed", collapsed);
      });

      // Preset scroll buttons
      this.panel.querySelectorAll(".lan-btn-preset").forEach((btn) => {
        btn.addEventListener("click", () => {
          const months = parseInt(btn.dataset.months, 10);
          const target = new Date();
          target.setMonth(target.getMonth() - months);
          this.startScrollTo(target);
        });
      });

      // Custom date toggle
      document.getElementById("lan-custom-btn").addEventListener("click", () => {
        const row = document.getElementById("lan-custom-row");
        const visible = row.style.display !== "none";
        row.style.display = visible ? "none" : "flex";
        if (!visible) document.getElementById("lan-date-input").focus();
      });

      // Custom date go
      document.getElementById("lan-go-btn").addEventListener("click", () => {
        const val = document.getElementById("lan-date-input").value;
        const date = new Date(val);
        if (isNaN(date.getTime())) {
          this.setStatus("Please enter a valid date.", "error");
          return;
        }
        if (date > new Date()) {
          this.setStatus("Target date must be in the past.", "error");
          return;
        }
        this.startScrollTo(date);
      });

      // Stop button
      document.getElementById("lan-stop-btn").addEventListener("click", () => {
        ScrollController.stop();
      });

      // Memory safe toggle
      document.getElementById("lan-memory-safe").addEventListener("change", (e) => {
        MemoryManager.pruningEnabled = e.target.checked;
        this.saveSettings();
      });
    },

    startScrollTo(targetDate) {
      if (ScrollController.isScrolling) {
        this.setStatus("Already scrolling. Stop first.", "error");
        return;
      }
      document.getElementById("lan-target-date").textContent =
        DateParser.formatDate(targetDate);
      this.clearStatus();
      ScrollController.start(targetDate);
    },

    onScrollStart() {
      document.getElementById("lan-stop-btn").style.display = "block";
      document.getElementById("lan-progress").style.display = "block";
      document.getElementById("lan-stats").style.display = "none";
      document.getElementById("lan-progress-fill").style.width = "0%";
      document.getElementById("lan-progress-pct").textContent = "0%";
      document.getElementById("lan-current-date").textContent = "Detecting...";
      this.clearStatus();

      this.panel.querySelectorAll(
        ".lan-btn-preset, .lan-btn-custom, .lan-btn-go"
      ).forEach((btn) => { btn.disabled = true; });
    },

    updateProgress() {
      const pct = ProgressEstimator.getProgress();
      document.getElementById("lan-progress-fill").style.width = pct + "%";
      document.getElementById("lan-progress-pct").textContent = pct + "%";

      if (ProgressEstimator.oldestDetected) {
        document.getElementById("lan-current-date").textContent =
          DateParser.formatMonthYear(ProgressEstimator.oldestDetected);
      }
    },

    onScrollComplete(reason) {
      document.getElementById("lan-stop-btn").style.display = "none";

      this.panel.querySelectorAll(
        ".lan-btn-preset, .lan-btn-custom, .lan-btn-go"
      ).forEach((btn) => { btn.disabled = false; });

      this.updateProgress();

      // Stats
      const stats = document.getElementById("lan-stats");
      stats.style.display = "block";
      document.getElementById("lan-stats-text").textContent =
        `Scrolls: ${ScrollController.scrollAttempts} | ` +
        `Posts loaded: ~${ScrollController.lastCardCount}` +
        (MemoryManager.prunedCount > 0
          ? ` | Pruned: ${MemoryManager.prunedCount}`
          : "");

      const isSuccess = reason === "Target date reached";
      this.setStatus(reason, isSuccess ? "success" : "info");
    },

    setStatus(message, type) {
      const el = document.getElementById("lan-status");
      el.textContent = message;
      el.className = "lan-status";
      if (type) el.classList.add("lan-status--" + type);
    },

    clearStatus() {
      const el = document.getElementById("lan-status");
      el.textContent = "";
      el.className = "lan-status";
    },

    makeDraggable() {
      const header = this.panel.querySelector(".lan-panel-header");
      const collapseBtn = this.panel.querySelector(".lan-panel-collapse");
      let isDragging = false;
      let offsetX = 0;
      let offsetY = 0;

      header.addEventListener("mousedown", (e) => {
        if (e.target === collapseBtn) return;
        isDragging = true;
        offsetX = e.clientX - this.panel.getBoundingClientRect().left;
        offsetY = e.clientY - this.panel.getBoundingClientRect().top;
        e.preventDefault();
      });

      document.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        this.panel.style.right = "auto";
        this.panel.style.left = (e.clientX - offsetX) + "px";
        this.panel.style.top = (e.clientY - offsetY) + "px";
      });

      document.addEventListener("mouseup", () => { isDragging = false; });
    },

    saveSettings() {
      try {
        chrome.storage.local.set({
          lanSettings: { memoryPruning: MemoryManager.pruningEnabled },
        });
      } catch { /* storage unavailable */ }
    },

    loadSettings() {
      try {
        chrome.storage.local.get("lanSettings", (result) => {
          if (result && result.lanSettings) {
            MemoryManager.pruningEnabled = result.lanSettings.memoryPruning ?? false;
            const cb = document.getElementById("lan-memory-safe");
            if (cb) cb.checked = MemoryManager.pruningEnabled;
          }
        });
      } catch { /* storage unavailable */ }
    },
  };

  // ═══════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════

  function notifyBackground(state) {
    try {
      chrome.runtime.sendMessage({ type: "scrollStateChanged", state });
    } catch { /* background not available */ }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Init
  // ═══════════════════════════════════════════════════════════════════════

  function init() {
    UIController.createPanel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
