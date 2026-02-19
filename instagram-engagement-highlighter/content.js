/**
 * Instagram Engagement Highlighter - Content Script
 *
 * Works on both feed view AND profile grid view.
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
  let weights = { likes: 5, comments: 10, views: 2 };
  let debounceTimer = null;

  const DEBOUNCE_MS = 300;

  // ─── Auto-scroll state ───────────────────────────────────────────────
  let autoScrollEnabled = false;
  let autoScrollInterval = null;
  let autoScrollSpeed = 2;
  let autoScrollTick = 80;

  // ─── Page Type Detection ─────────────────────────────────────────────

  /**
   * Determines the current Instagram page type.
   * Returns: "feed", "profile", "post", or "explore"
   */
  function getPageType() {
    const path = window.location.pathname;
    if (path === "/" || path === "") return "feed";
    if (path.includes("/p/") || path.includes("/reel/")) return "post";
    if (path.startsWith("/explore")) return "explore";
    // Profile pages: /<username>/ with optional tabs like /tagged/ /reels/
    if (/^\/[A-Za-z0-9_.]+\/?/.test(path)) return "profile";
    return "feed";
  }

  // ─── Number Parsing ──────────────────────────────────────────────────

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
   * Extracts first number (with optional K/M/B) from a string.
   */
  function extractFirstNumber(text) {
    if (!text) return 0;
    const match = text.match(/([\d,]+\.?\d*)\s*([KMB])?/i);
    if (!match) return 0;
    return parseCount(match[1].replace(/,/g, "") + (match[2] || ""));
  }

  // ─── Post Detection ──────────────────────────────────────────────────

  /**
   * Unified post finder that works on both feed and profile pages.
   * Returns an array of { element, type } where type is "feed" or "grid".
   */
  function findAllPosts() {
    const pageType = getPageType();

    if (pageType === "profile" || pageType === "explore") {
      return findGridPosts();
    }

    // Feed / single post view
    return findFeedPosts();
  }

  /**
   * Finds feed-style post containers (scrolling feed, single post view).
   */
  function findFeedPosts() {
    const selectors = [
      'article[role="presentation"]',
      'main article',
      'article',
    ];

    let posts = [];
    for (const selector of selectors) {
      posts = Array.from(document.querySelectorAll(selector));
      if (posts.length > 0) break;
    }

    // Filter nested articles
    const filtered = posts.filter((post) => {
      return !posts.some((other) => other !== post && other.contains(post));
    });

    const result = filtered.length > 0 ? filtered : posts;
    return result.map((el) => ({ element: el, type: "feed" }));
  }

  /**
   * Finds profile grid post items.
   * On profile pages, posts are displayed as a 3-column grid of thumbnails.
   * Each grid cell contains a link to /p/<shortcode>/ or /reel/<shortcode>/
   * with engagement data in a hover overlay (likes + comments).
   */
  function findGridPosts() {
    // Strategy 1: Find all links pointing to individual posts within the main content
    // These are the grid thumbnail links
    const postLinks = document.querySelectorAll(
      'main a[href*="/p/"], main a[href*="/reel/"]'
    );

    if (postLinks.length === 0) return [];

    const seen = new Set();
    const results = [];

    for (const link of postLinks) {
      const href = link.getAttribute("href") || "";
      if (seen.has(href)) continue;
      seen.add(href);

      // The grid cell is typically the link itself or its immediate parent div.
      // We want the container that forms the visual grid cell so we can
      // add borders and badges to it.
      // Walk up to find the element that has a square aspect ratio / grid role.
      let gridCell = link;

      // Walk up a few levels to find the actual grid cell container
      // (the div that gives the square shape in the 3-column grid)
      let parent = link.parentElement;
      for (let i = 0; i < 4 && parent; i++) {
        // If the parent is a grid/flex item or has similar dimensions to the link
        const style = window.getComputedStyle(parent);
        if (
          parent.tagName === "ARTICLE" ||
          parent.tagName === "MAIN" ||
          parent === document.body
        ) {
          break;
        }
        // If this parent looks like a grid row (wider than a single cell), stop
        if (parent.children.length >= 3 && style.display === "flex") {
          break;
        }
        gridCell = parent;
        parent = parent.parentElement;
      }

      results.push({ element: gridCell, linkElement: link, type: "grid" });
    }

    return results;
  }

  // ─── Engagement Extraction ───────────────────────────────────────────

  /**
   * Unified engagement extraction. Dispatches to feed or grid strategy.
   */
  function extractEngagement(postInfo) {
    if (postInfo.type === "grid") {
      return extractGridEngagement(postInfo);
    }
    return extractFeedEngagement(postInfo.element);
  }

  /**
   * Extracts engagement from a profile grid cell.
   *
   * Instagram grid cells have a hover overlay that contains:
   * - An <ul> or <div> with <li> items for likes and comments
   * - Each <li> has an SVG icon + <span> with the count
   * - The overlay is in the DOM but hidden until hover (opacity/visibility)
   *
   * Also checks for accessible text (aria-label, alt, title) which
   * Instagram sometimes puts on images or links with engagement counts.
   */
  function extractGridEngagement(postInfo) {
    const el = postInfo.element;
    const linkEl = postInfo.linkElement || el;
    let likes = 0;
    let comments = 0;
    let views = 0;

    // Strategy 1: Look for the hover overlay content
    // Instagram grid overlays contain <li> elements with SVG + span pairs
    const listItems = el.querySelectorAll("li");
    for (const li of listItems) {
      const text = (li.textContent || "").trim();
      const num = extractFirstNumber(text);
      if (num === 0) continue;

      // Determine type by SVG path or by position
      // Instagram uses specific SVG shapes: heart for likes, speech bubble for comments
      const svg = li.querySelector("svg");
      if (svg) {
        const svgContent = svg.innerHTML || "";
        const ariaLabel = (svg.getAttribute("aria-label") || "").toLowerCase();

        if (
          ariaLabel.includes("like") ||
          svgContent.includes("M34.6 3.1") || // Instagram heart path
          svgContent.includes("M16 5.3") ||    // Alternate heart path
          svgContent.includes("heart")
        ) {
          likes = Math.max(likes, num);
          continue;
        }
        if (
          ariaLabel.includes("comment") ||
          svgContent.includes("M20.656 17.008") || // Instagram comment path
          svgContent.includes("M47.5 46.1") ||      // Alternate comment path
          svgContent.includes("comment") ||
          svgContent.includes("bubble")
        ) {
          comments = Math.max(comments, num);
          continue;
        }
        if (ariaLabel.includes("view") || ariaLabel.includes("play")) {
          views = Math.max(views, num);
          continue;
        }
      }

      // Fallback: first number = likes, second = comments (Instagram's order)
      if (likes === 0) {
        likes = num;
      } else if (comments === 0) {
        comments = num;
      }
    }

    // Strategy 2: Check for span elements with counts (newer IG layouts)
    if (likes === 0 && comments === 0) {
      const spans = el.querySelectorAll("span");
      const numbers = [];
      for (const span of spans) {
        // Only look at leaf spans (no child elements or just text)
        if (span.children.length > 1) continue;
        const text = (span.textContent || "").trim();
        const num = extractFirstNumber(text);
        if (num > 0 && text.length < 15) {
          numbers.push(num);
        }
      }
      // Instagram hover overlay shows likes first, comments second
      if (numbers.length >= 1) likes = numbers[0];
      if (numbers.length >= 2) comments = numbers[1];
    }

    // Strategy 3: Check aria-label on the link or image
    // Instagram sometimes puts "X likes, Y comments" in aria-label
    if (likes === 0 && comments === 0) {
      const ariaTargets = [linkEl, el, ...el.querySelectorAll("img, a, div[role]")];
      for (const target of ariaTargets) {
        if (!target) continue;
        const label = (
          target.getAttribute("aria-label") ||
          target.getAttribute("alt") ||
          target.getAttribute("title") ||
          ""
        );
        if (!label) continue;

        const likesMatch = label.match(/([\d,]+\.?\d*[KMB]?)\s*likes?/i);
        if (likesMatch) likes = parseCount(likesMatch[1].replace(/,/g, ""));

        const commentsMatch = label.match(/([\d,]+\.?\d*[KMB]?)\s*comments?/i);
        if (commentsMatch) comments = parseCount(commentsMatch[1].replace(/,/g, ""));

        const viewsMatch = label.match(/([\d,]+\.?\d*[KMB]?)\s*(?:views?|plays?)/i);
        if (viewsMatch) views = parseCount(viewsMatch[1].replace(/,/g, ""));

        if (likes > 0 || comments > 0) break;
      }
    }

    // Strategy 4: Check for video play/view indicators
    if (views === 0) {
      const allText = el.querySelectorAll("span, div");
      for (const node of allText) {
        if (node.children.length > 2) continue;
        const text = (node.textContent || "").trim().toLowerCase();
        const viewsMatch = text.match(/([\d,]+\.?\d*[KMB]?)\s*(?:views?|plays?)/i);
        if (viewsMatch) {
          views = parseCount(viewsMatch[1].replace(/,/g, ""));
          break;
        }
      }
    }

    return { likes, comments, views };
  }

  /**
   * Extracts engagement from a feed-style post (full-size post in the scrolling feed).
   */
  function extractFeedEngagement(postEl) {
    let likes = 0;
    let comments = 0;
    let views = 0;

    // Strategy 1: Scan leaf elements for engagement text patterns
    const allLinks = postEl.querySelectorAll("a, button, span, div");
    for (const el of allLinks) {
      const text = (el.textContent || "").trim();

      if (el.children.length > 5) continue;

      if (likes === 0) {
        const likesMatch = text.match(/([\d,]+\.?\d*[KMB]?)\s*likes?/i);
        if (likesMatch) {
          likes = Math.max(likes, parseCount(likesMatch[1].replace(/,/g, "")));
        }
        const othersMatch = text.match(/and\s+([\d,]+\.?\d*[KMB]?)\s*others?/i);
        if (othersMatch) {
          likes = Math.max(likes, parseCount(othersMatch[1].replace(/,/g, "")) + 1);
        }
        if (text.toLowerCase().includes("liked by") && likes === 0) {
          const ariaLabel = el.getAttribute("aria-label") || "";
          const countMatch = ariaLabel.match(/([\d,]+\.?\d*[KMB]?)/);
          if (countMatch) {
            likes = Math.max(likes, parseCount(countMatch[1].replace(/,/g, "")));
          }
        }
      }

      if (comments === 0) {
        const commentsMatch = text.match(
          /(?:View\s+all\s+)?([\d,]+\.?\d*[KMB]?)\s*comments?/i
        );
        if (commentsMatch) {
          comments = Math.max(comments, parseCount(commentsMatch[1].replace(/,/g, "")));
        }
      }

      if (views === 0) {
        const viewsMatch = text.match(/([\d,]+\.?\d*[KMB]?)\s*views?/i);
        if (viewsMatch) {
          views = Math.max(views, parseCount(viewsMatch[1].replace(/,/g, "")));
        }
        const playsMatch = text.match(/([\d,]+\.?\d*[KMB]?)\s*plays?/i);
        if (playsMatch) {
          views = Math.max(views, parseCount(playsMatch[1].replace(/,/g, "")));
        }
      }
    }

    // Strategy 2: aria-labels on interactive elements
    if (likes === 0 && comments === 0 && views === 0) {
      const interactiveEls = postEl.querySelectorAll("[aria-label], [title]");
      for (const el of interactiveEls) {
        const label = (
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          ""
        ).toLowerCase();

        if (label.includes("like") && !label.includes("unlike")) {
          const m = label.match(/([\d,]+\.?\d*[KMB]?)/i);
          if (m) likes = Math.max(likes, parseCount(m[1].replace(/,/g, "")));
        }
        if (label.includes("comment")) {
          const m = label.match(/([\d,]+\.?\d*[KMB]?)/i);
          if (m) comments = Math.max(comments, parseCount(m[1].replace(/,/g, "")));
        }
        if (label.includes("view") || label.includes("play")) {
          const m = label.match(/([\d,]+\.?\d*[KMB]?)/i);
          if (m) views = Math.max(views, parseCount(m[1].replace(/,/g, "")));
        }
      }
    }

    // Strategy 3: section-based fallback
    if (likes === 0) {
      const sections = postEl.querySelectorAll("section");
      for (const section of sections) {
        const text = (section.textContent || "").trim();
        const likesMatch = text.match(/([\d,]+\.?\d*[KMB]?)\s*likes?/i);
        if (likesMatch) {
          likes = parseCount(likesMatch[1].replace(/,/g, ""));
          break;
        }
        const othersMatch = text.match(/and\s+([\d,]+\.?\d*[KMB]?)\s*others?/i);
        if (othersMatch) {
          likes = parseCount(othersMatch[1].replace(/,/g, "")) + 1;
          break;
        }
      }
    }

    // Strategy 4: Count visible comment elements
    if (comments === 0) {
      const commentEls = postEl.querySelectorAll('ul > li, [role="button"]');
      let commentCount = 0;
      for (const el of commentEls) {
        const text = (el.textContent || "").trim();
        if (
          text.length > 5 &&
          text.length < 2000 &&
          !text.includes("like") &&
          !text.includes("view")
        ) {
          if (el.querySelector("a") && el.textContent.length > 10) {
            commentCount++;
          }
        }
      }
      if (commentCount > 0) comments = commentCount;
    }

    return { likes, comments, views };
  }

  // ─── Post Metadata Extraction ────────────────────────────────────────

  function extractPostMeta(postInfo) {
    if (postInfo.type === "grid") {
      return extractGridMeta(postInfo);
    }
    return extractFeedMeta(postInfo.element);
  }

  /**
   * Extracts metadata from a grid post cell.
   * Username comes from the page URL, post link from the grid cell's link.
   */
  function extractGridMeta(postInfo) {
    const el = postInfo.element;
    const linkEl = postInfo.linkElement || el;
    let username = "";
    let postUrl = "";
    let caption = "";

    // Username from page URL (we're on their profile)
    const pathMatch = window.location.pathname.match(/^\/([A-Za-z0-9_.]+)/);
    if (pathMatch) {
      username = pathMatch[1];
    }

    // Post URL from the link
    const href =
      (linkEl.tagName === "A" && linkEl.getAttribute("href")) ||
      "";
    if (href) {
      postUrl = href.startsWith("http")
        ? href
        : "https://www.instagram.com" + href;
    }
    if (!postUrl) {
      const innerLink = el.querySelector('a[href*="/p/"], a[href*="/reel/"]');
      if (innerLink) {
        const h = innerLink.getAttribute("href") || "";
        postUrl = h.startsWith("http")
          ? h
          : "https://www.instagram.com" + h;
      }
    }

    // Caption from img alt text (Instagram puts captions there)
    const img = el.querySelector("img[alt]");
    if (img) {
      const alt = (img.getAttribute("alt") || "").trim();
      // Instagram img alt is often the caption or a description
      if (alt.length > 10 && !alt.startsWith("Photo by") && !alt.startsWith("Photo shared")) {
        caption = alt.length > 150 ? alt.substring(0, 147) + "..." : alt;
      } else if (alt.length > 10) {
        // "Photo by X on Date. May be image of..." — still useful
        caption = alt.length > 150 ? alt.substring(0, 147) + "..." : alt;
      }
    }

    return { username, postUrl, caption };
  }

  /**
   * Extracts metadata from a feed-style post.
   */
  function extractFeedMeta(postEl) {
    let username = "";
    let postUrl = "";
    let caption = "";

    // Username from header links
    const headerLinks = postEl.querySelectorAll(
      'header a[href], a[role="link"]'
    );
    for (const link of headerLinks) {
      const href = link.getAttribute("href") || "";
      const userMatch = href.match(/^\/([A-Za-z0-9_.]+)\/?$/);
      if (userMatch) {
        username = userMatch[1];
        break;
      }
    }

    if (!username) {
      const allLinks = postEl.querySelectorAll("a[href]");
      for (const link of allLinks) {
        const href = link.getAttribute("href") || "";
        const userMatch = href.match(/^\/([A-Za-z0-9_.]+)\/?$/);
        if (
          userMatch &&
          ![
            "p", "reel", "explore", "stories", "accounts", "directory",
          ].includes(userMatch[1])
        ) {
          username = userMatch[1];
          break;
        }
      }
    }

    // Post URL
    const postLinks = postEl.querySelectorAll(
      'a[href*="/p/"], a[href*="/reel/"]'
    );
    for (const link of postLinks) {
      const href = link.getAttribute("href") || "";
      if (href.includes("/p/") || href.includes("/reel/")) {
        postUrl = href.startsWith("http")
          ? href
          : "https://www.instagram.com" + href;
        break;
      }
    }

    if (!postUrl) {
      const timeEl = postEl.querySelector("time");
      if (timeEl) {
        const parentLink = timeEl.closest("a[href]");
        if (parentLink) {
          const href = parentLink.getAttribute("href") || "";
          postUrl = href.startsWith("http")
            ? href
            : "https://www.instagram.com" + href;
        }
      }
    }

    // Caption
    const captionCandidates = postEl.querySelectorAll("span, div");
    for (const el of captionCandidates) {
      const text = (el.textContent || "").trim();
      if (text.length < 20) continue;
      if (/^\d+\s*(likes?|comments?|views?|plays?)/i.test(text)) continue;
      if (/^(View all|Liked by|Load more)/i.test(text)) continue;
      if (el.closest("header")) continue;
      if (el.children.length > 3) continue;
      caption = text.length > 150 ? text.substring(0, 147) + "..." : text;
      break;
    }

    return { username, postUrl, caption };
  }

  // ─── Scoring ─────────────────────────────────────────────────────────

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

      for (const item of scoredPosts) {
        item.element.classList.remove("ieh-tier1", "ieh-tier2");
        if (item.score >= top10Threshold && item.score > 0) {
          item.element.classList.add("ieh-tier1");
        } else if (item.score >= medianThreshold && item.score > 0) {
          item.element.classList.add("ieh-tier2");
        }
        if (showScores) addScoreBadge(item);
      }
    } else {
      for (const item of scoredPosts) {
        item.element.classList.remove("ieh-tier1", "ieh-tier2");
        if (item.score >= absoluteThreshold * 2) {
          item.element.classList.add("ieh-tier1");
        } else if (item.score >= absoluteThreshold) {
          item.element.classList.add("ieh-tier2");
        }
        if (showScores) addScoreBadge(item);
      }
    }
  }

  function formatCount(n) {
    if (n >= 1_000_000)
      return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1_000)
      return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  }

  function addScoreBadge(item) {
    const existing = item.element.querySelector(".ieh-score-badge");
    if (existing) existing.remove();

    if (!showScores) return;

    const badge = document.createElement("div");
    badge.className =
      "ieh-score-badge" + (item.type === "grid" ? " ieh-grid-badge" : "");

    const parts = [];
    if (item.engagement.likes > 0)
      parts.push(`\u2764\ufe0f ${formatCount(item.engagement.likes)}`);
    if (item.engagement.comments > 0)
      parts.push(`\ud83d\udcac ${formatCount(item.engagement.comments)}`);
    if (item.engagement.views > 0)
      parts.push(`\ud83d\udc41 ${formatCount(item.engagement.views)}`);

    const breakdown = parts.length > 0 ? parts.join("  ") : "no data";

    if (item.type === "grid") {
      // Compact badge for grid thumbnails
      badge.innerHTML = `<span class="ieh-badge-score">${item.score.toLocaleString()}</span><span class="ieh-badge-detail">${breakdown}</span>`;
    } else {
      badge.innerHTML = `<span class="ieh-badge-score">${item.score.toLocaleString()}</span><span class="ieh-badge-detail">${breakdown}</span>`;
    }

    const computedStyle = window.getComputedStyle(item.element);
    if (computedStyle.position === "static") {
      item.element.style.position = "relative";
    }
    // Ensure the badge is visible over Instagram's overlays
    if (item.type === "grid") {
      item.element.style.overflow = "visible";
    }

    item.element.appendChild(badge);
  }

  // ─── Main Processing ─────────────────────────────────────────────────

  function processAllPosts() {
    if (!enabled) {
      clearHighlights();
      return;
    }

    const posts = findAllPosts();
    const scoredPosts = [];

    for (const postInfo of posts) {
      const engagement = extractEngagement(postInfo);
      const score = calculateScore(engagement);
      scoredPosts.push({
        element: postInfo.element,
        type: postInfo.type,
        score,
        engagement,
      });
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
      let hasNewContent = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          hasNewContent = true;
          break;
        }
      }
      if (hasNewContent) {
        debouncedProcess();
      }
    });

    observer.observe(feedContainer, {
      childList: true,
      subtree: true,
    });

    return observer;
  }

  // ─── SPA Navigation Handling ─────────────────────────────────────────

  /**
   * Instagram is a SPA — page changes don't reload the content script.
   * We listen for URL changes and re-process when the user navigates
   * between feed, profiles, and posts.
   */
  let lastUrl = window.location.href;

  function setupNavigationListener() {
    // Poll for URL changes (pushState/replaceState don't fire events reliably)
    setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        // Delay to let Instagram render the new page
        setTimeout(() => {
          processAllPosts();
          updateExtractCount();
        }, 1500);
      }
    }, 500);
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
      const variance =
        tick % 23 < 12 ? autoScrollSpeed : autoScrollSpeed + 1;
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

        <div id="ieh-page-type" class="ieh-page-indicator"></div>

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

    document
      .getElementById("ieh-show-scores")
      .addEventListener("change", (e) => {
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

    document
      .getElementById("ieh-threshold")
      .addEventListener("input", (e) => {
        absoluteThreshold = parseInt(e.target.value, 10);
        document.getElementById("ieh-threshold-val").textContent =
          absoluteThreshold;
        saveSettings();
      });

    document
      .getElementById("ieh-threshold")
      .addEventListener("change", () => {
        processAllPosts();
      });

    document
      .getElementById("ieh-w-likes")
      .addEventListener("change", (e) => {
        weights.likes = parseFloat(e.target.value) || 0;
        saveSettings();
      });

    document
      .getElementById("ieh-w-comments")
      .addEventListener("change", (e) => {
        weights.comments = parseFloat(e.target.value) || 0;
        saveSettings();
      });

    document
      .getElementById("ieh-w-views")
      .addEventListener("change", (e) => {
        weights.views = parseFloat(e.target.value) || 0;
        saveSettings();
      });

    document
      .getElementById("ieh-recalculate")
      .addEventListener("click", () => {
        processAllPosts();
      });

    // ── Auto-scroll controls ──
    document
      .getElementById("ieh-autoscroll")
      .addEventListener("change", (e) => {
        autoScrollEnabled = e.target.checked;
        if (autoScrollEnabled) {
          startAutoScroll();
        } else {
          stopAutoScroll();
        }
        saveSettings();
      });

    document
      .getElementById("ieh-scroll-speed")
      .addEventListener("input", (e) => {
        autoScrollSpeed = parseInt(e.target.value, 10);
        document.getElementById("ieh-scroll-speed-val").textContent =
          autoScrollSpeed;
        saveSettings();
      });

    // ── Extract top posts ──
    document.getElementById("ieh-extract").addEventListener("click", () => {
      extractTopPosts();
    });

    updateExtractCount();
    updatePageIndicator();
  }

  // ─── Page Indicator ────────────────────────────────────────────────

  function updatePageIndicator() {
    const el = document.getElementById("ieh-page-type");
    if (!el) return;
    const pageType = getPageType();
    const labels = {
      feed: "Feed view",
      profile: "Profile grid",
      post: "Single post",
      explore: "Explore",
    };
    el.textContent = labels[pageType] || pageType;
  }

  // ─── Extract Top Posts ────────────────────────────────────────────────

  function updateExtractCount() {
    const countEl = document.getElementById("ieh-extract-count");
    if (!countEl) return;
    const posts = findAllPosts();
    const pageType = getPageType();
    const label = pageType === "profile" ? "in grid" : "in feed";
    countEl.textContent =
      posts.length +
      " post" +
      (posts.length !== 1 ? "s" : "") +
      " detected " +
      label;
  }

  function extractTopPosts() {
    const posts = findAllPosts();
    const scored = [];

    for (const postInfo of posts) {
      const engagement = extractEngagement(postInfo);
      const score = calculateScore(engagement);
      const meta = extractPostMeta(postInfo);
      scored.push({ ...meta, ...engagement, score });
    }

    scored.sort((a, b) => b.score - a.score);

    const countSel = document.getElementById("ieh-export-count");
    const countVal = countSel ? countSel.value : "10";
    const limit =
      countVal === "all" ? scored.length : parseInt(countVal, 10);
    const topPosts = scored.slice(0, limit);

    updateExtractCount();
    showExportModal(topPosts);
  }

  function showExportModal(posts) {
    const existing = document.getElementById("ieh-export-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "ieh-export-modal";
    overlay.className = "ieh-modal-overlay";

    const totalPosts = findAllPosts().length;

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
          ${posts.length === 0 ? '<div class="ieh-modal-empty">No posts found. Try scrolling through the feed first to load posts, or hover over profile grid posts to reveal engagement data.</div>' : ""}
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
        if (p.comments > 0)
          parts.push(`${formatCount(p.comments)} comments`);
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
      navigator.clipboard
        .writeText(JSON.stringify(data, null, 2))
        .then(() => {
          flashButton("ieh-copy-json", "Copied!");
        });
    });

    // ── Download CSV ──
    document
      .getElementById("ieh-download-csv")
      .addEventListener("click", () => {
        const header =
          "Rank,Username,Likes,Comments,Views,Score,Post URL,Caption";
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
      // storage unavailable
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

          const enabledEl = document.getElementById("ieh-enabled");
          const showScoresEl = document.getElementById("ieh-show-scores");
          const modeEl = document.getElementById("ieh-mode");
          const thresholdEl = document.getElementById("ieh-threshold");
          const thresholdValEl = document.getElementById(
            "ieh-threshold-val"
          );
          const wLikesEl = document.getElementById("ieh-w-likes");
          const wCommentsEl = document.getElementById("ieh-w-comments");
          const wViewsEl = document.getElementById("ieh-w-views");
          const thresholdRow = document.querySelector(
            ".ieh-threshold-row"
          );
          const scrollSpeedEl = document.getElementById(
            "ieh-scroll-speed"
          );
          const scrollSpeedValEl = document.getElementById(
            "ieh-scroll-speed-val"
          );

          if (enabledEl) enabledEl.checked = enabled;
          if (showScoresEl) showScoresEl.checked = showScores;
          if (modeEl) modeEl.value = mode;
          if (thresholdEl) thresholdEl.value = absoluteThreshold;
          if (thresholdValEl)
            thresholdValEl.textContent = absoluteThreshold;
          if (wLikesEl) wLikesEl.value = weights.likes;
          if (wCommentsEl) wCommentsEl.value = weights.comments;
          if (wViewsEl) wViewsEl.value = weights.views;
          if (thresholdRow) {
            thresholdRow.style.display =
              mode === "threshold" ? "flex" : "none";
          }
          if (scrollSpeedEl) scrollSpeedEl.value = autoScrollSpeed;
          if (scrollSpeedValEl)
            scrollSpeedValEl.textContent = autoScrollSpeed;

          processAllPosts();
        }
      });
    } catch {
      // storage unavailable
    }
  }

  // ─── Initialization ──────────────────────────────────────────────────

  function init() {
    createControlPanel();
    loadSettings();
    setupObserver();
    setupNavigationListener();

    // Initial scan (delayed to let IG finish rendering)
    setTimeout(processAllPosts, 1000);
    // Second scan catches lazy-loaded grid content
    setTimeout(processAllPosts, 3000);

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
