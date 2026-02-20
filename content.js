/**
 * Instagram Engagement Highlighter - Content Script
 *
 * Works on feed view, profile grid view, and reels tab.
 * Uses Instagram's internal API to fetch ALL posts with full engagement
 * data and timestamps. Falls back to DOM scraping for feed/explore.
 * Includes calendar heatmap and date-range filtering.
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
  let autoScrollRafId = null;
  let autoScrollSpeed = 3;
  let lastScrollTime = 0;

  const SCROLL_SPEEDS = [300, 600, 1200, 2200, 3500, 5500];

  // ─── Scoring cache ─────────────────────────────────────────────────
  const scoredCache = new WeakMap();

  // ─── Profile scan state ────────────────────────────────────────────
  let isScanning = false;
  let scanAborted = false;
  const collectedPosts = new Map(); // postUrl -> post data with date

  // ─── Calendar / date filter state ──────────────────────────────────
  let calendarMonth = new Date(); // currently viewed month in calendar
  let dateFilterFrom = "";
  let dateFilterTo = "";

  // ─── Page Type Detection ─────────────────────────────────────────────

  function getPageType() {
    const path = window.location.pathname;
    if (path === "/" || path === "") return "feed";
    if (path.includes("/p/") || path.includes("/reel/")) return "post";
    if (path.startsWith("/explore")) return "explore";
    if (/^\/[A-Za-z0-9_.]+\/?/.test(path)) return "profile";
    return "feed";
  }

  function getProfileTab() {
    const path = window.location.pathname;
    if (path.includes("/reels")) return "reels";
    if (path.includes("/tagged")) return "tagged";
    return "posts";
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

  function extractFirstNumber(text) {
    if (!text) return 0;
    const match = text.match(/([\d,]+\.?\d*)\s*([KMB])?/i);
    if (!match) return 0;
    return parseCount(match[1].replace(/,/g, "") + (match[2] || ""));
  }

  // ─── CSRF Token ────────────────────────────────────────────────────

  function getCsrfToken() {
    const match = document.cookie.match(/csrftoken=([^;]+)/);
    return match ? match[1] : "";
  }

  // ─── Instagram API: Profile Scanning ───────────────────────────────

  async function getProfileUserId() {
    const pathMatch = window.location.pathname.match(
      /^\/([A-Za-z0-9_.]+)/
    );
    if (!pathMatch) return null;
    const username = pathMatch[1];

    // Skip non-profile paths
    if (
      ["explore", "accounts", "directory", "stories", "p", "reel"].includes(
        username
      )
    )
      return null;

    try {
      const resp = await fetch(
        `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
        {
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "X-IG-App-ID": "936619743392459",
            "X-CSRFToken": getCsrfToken(),
          },
          credentials: "include",
        }
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.data?.user?.id || null;
    } catch {
      return null;
    }
  }

  async function fetchAllUserPosts(userId) {
    let maxId = null;
    let hasMore = true;
    let fetched = 0;

    while (hasMore && !scanAborted) {
      const url =
        `/api/v1/feed/user/${userId}/?count=33` +
        (maxId ? `&max_id=${maxId}` : "");

      let data;
      try {
        const resp = await fetch(url, {
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "X-IG-App-ID": "936619743392459",
            "X-CSRFToken": getCsrfToken(),
          },
          credentials: "include",
        });
        if (!resp.ok) break;
        data = await resp.json();
      } catch {
        break;
      }

      const items = data.items || [];
      for (const item of items) {
        const post = parseApiPost(item);
        collectedPosts.set(post.postUrl, post);
      }

      fetched += items.length;
      hasMore = !!data.more_available;
      maxId = data.next_max_id || null;

      updateScanProgress(fetched, hasMore);

      // Rate-limit: small delay between pages
      if (hasMore) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    return fetched;
  }

  function parseApiPost(item) {
    const code = item.code || "";
    const isReel = item.media_type === 2 || item.product_type === "clips";
    const postUrl = `https://www.instagram.com/${isReel ? "reel" : "p"}/${code}/`;

    return {
      postUrl,
      likes: item.like_count || 0,
      comments: item.comment_count || 0,
      views: item.play_count || item.view_count || 0,
      caption: item.caption?.text || "",
      date: item.taken_at ? new Date(item.taken_at * 1000) : null,
      username: item.user?.username || "",
      mediaType: isReel
        ? "reel"
        : item.media_type === 8
          ? "carousel"
          : "photo",
      score: 0, // calculated after fetch
    };
  }

  function recalcCollectedScores() {
    for (const [url, post] of collectedPosts) {
      post.score =
        post.likes * weights.likes +
        post.comments * weights.comments +
        post.views * weights.views;
    }
  }

  async function scanProfile() {
    if (isScanning) return;

    const pageType = getPageType();
    if (pageType !== "profile") {
      updateScanStatus("Navigate to a profile page first");
      return;
    }

    isScanning = true;
    scanAborted = false;
    updateScanUI(true);
    updateScanProgress(0, true);

    const userId = await getProfileUserId();
    if (!userId) {
      updateScanStatus("Could not find user ID. Try refreshing the page.");
      isScanning = false;
      updateScanUI(false);
      return;
    }

    const count = await fetchAllUserPosts(userId);
    recalcCollectedScores();

    isScanning = false;
    updateScanUI(false);

    if (scanAborted) {
      updateScanStatus(`Scan stopped. ${collectedPosts.size} posts collected.`);
    } else {
      updateScanStatus(
        `Done! ${collectedPosts.size} posts scanned with full data.`
      );
    }

    updateExtractCount();
  }

  function stopScan() {
    scanAborted = true;
  }

  function updateScanUI(scanning) {
    const scanBtn = document.getElementById("ieh-scan-profile");
    const stopBtn = document.getElementById("ieh-scan-stop");
    if (scanBtn) scanBtn.style.display = scanning ? "none" : "block";
    if (stopBtn) stopBtn.style.display = scanning ? "block" : "none";
  }

  function updateScanProgress(count, hasMore) {
    const el = document.getElementById("ieh-scan-status");
    if (!el) return;
    if (hasMore) {
      el.textContent = `Scanning... ${count} posts fetched`;
      el.className = "ieh-scan-status ieh-scan-active";
    } else {
      el.textContent = `${count} posts fetched`;
      el.className = "ieh-scan-status";
    }
  }

  function updateScanStatus(msg) {
    const el = document.getElementById("ieh-scan-status");
    if (el) {
      el.textContent = msg;
      el.className = "ieh-scan-status";
    }
  }

  // ─── Post Detection ──────────────────────────────────────────────────

  function findAllPosts() {
    const pageType = getPageType();

    if (pageType === "profile" || pageType === "explore") {
      return findGridPosts();
    }

    return findFeedPosts();
  }

  function findFeedPosts() {
    const selectors = [
      'article[role="presentation"]',
      "main article",
      "article",
    ];

    let posts = [];
    for (const selector of selectors) {
      posts = Array.from(document.querySelectorAll(selector));
      if (posts.length > 0) break;
    }

    const filtered = posts.filter((post) => {
      return !posts.some((other) => other !== post && other.contains(post));
    });

    const result = filtered.length > 0 ? filtered : posts;
    return result.map((el) => ({ element: el, type: "feed" }));
  }

  function findGridPosts() {
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

      let gridCell = link;
      let parent = link.parentElement;
      for (let i = 0; i < 4 && parent; i++) {
        const style = window.getComputedStyle(parent);
        if (
          parent.tagName === "ARTICLE" ||
          parent.tagName === "MAIN" ||
          parent === document.body
        ) {
          break;
        }
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

  function extractEngagement(postInfo) {
    // If we have API data for this post, use it (much more reliable)
    const href = getPostHref(postInfo);
    if (href) {
      const fullUrl = href.startsWith("http")
        ? href
        : "https://www.instagram.com" + href;
      const apiData = collectedPosts.get(fullUrl);
      if (apiData) {
        return {
          likes: apiData.likes,
          comments: apiData.comments,
          views: apiData.views,
        };
      }
    }

    if (postInfo.type === "grid") {
      return extractGridEngagement(postInfo);
    }
    return extractFeedEngagement(postInfo.element);
  }

  function getPostHref(postInfo) {
    if (postInfo.linkElement) {
      return postInfo.linkElement.getAttribute("href") || "";
    }
    const link = postInfo.element.querySelector(
      'a[href*="/p/"], a[href*="/reel/"]'
    );
    return link ? link.getAttribute("href") || "" : "";
  }

  function extractGridEngagement(postInfo) {
    const el = postInfo.element;
    const linkEl = postInfo.linkElement || el;
    let likes = 0;
    let comments = 0;
    let views = 0;

    // Strategy 1: Look for the hover overlay content
    const listItems = el.querySelectorAll("li");
    for (const li of listItems) {
      const text = (li.textContent || "").trim();
      const num = extractFirstNumber(text);
      if (num === 0) continue;

      const svg = li.querySelector("svg");
      if (svg) {
        const svgContent = svg.innerHTML || "";
        const ariaLabel = (
          svg.getAttribute("aria-label") || ""
        ).toLowerCase();

        if (
          ariaLabel.includes("like") ||
          svgContent.includes("M34.6 3.1") ||
          svgContent.includes("M16 5.3") ||
          svgContent.includes("heart")
        ) {
          likes = Math.max(likes, num);
          continue;
        }
        if (
          ariaLabel.includes("comment") ||
          svgContent.includes("M20.656 17.008") ||
          svgContent.includes("M47.5 46.1") ||
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

      if (likes === 0) {
        likes = num;
      } else if (comments === 0) {
        comments = num;
      }
    }

    // Strategy 2: span elements with counts
    if (likes === 0 && comments === 0) {
      const spans = el.querySelectorAll("span");
      const numbers = [];
      for (const span of spans) {
        if (span.children.length > 1) continue;
        const text = (span.textContent || "").trim();
        const num = extractFirstNumber(text);
        if (num > 0 && text.length < 15) {
          numbers.push(num);
        }
      }
      if (numbers.length >= 1) likes = numbers[0];
      if (numbers.length >= 2) comments = numbers[1];
    }

    // Strategy 3: aria-label on the link or image
    if (likes === 0 && comments === 0) {
      const ariaTargets = [
        linkEl,
        el,
        ...el.querySelectorAll("img, a, div[role]"),
      ];
      for (const target of ariaTargets) {
        if (!target) continue;
        const label =
          target.getAttribute("aria-label") ||
          target.getAttribute("alt") ||
          target.getAttribute("title") ||
          "";
        if (!label) continue;

        const likesMatch = label.match(
          /([\d,]+\.?\d*[KMB]?)\s*likes?/i
        );
        if (likesMatch) likes = parseCount(likesMatch[1].replace(/,/g, ""));

        const commentsMatch = label.match(
          /([\d,]+\.?\d*[KMB]?)\s*comments?/i
        );
        if (commentsMatch)
          comments = parseCount(commentsMatch[1].replace(/,/g, ""));

        const viewsMatch = label.match(
          /([\d,]+\.?\d*[KMB]?)\s*(?:views?|plays?)/i
        );
        if (viewsMatch) views = parseCount(viewsMatch[1].replace(/,/g, ""));

        if (likes > 0 || comments > 0) break;
      }
    }

    // Strategy 4: video play/view indicators
    if (views === 0) {
      const allText = el.querySelectorAll("span, div");
      for (const node of allText) {
        if (node.children.length > 2) continue;
        const text = (node.textContent || "").trim().toLowerCase();
        const viewsMatch = text.match(
          /([\d,]+\.?\d*[KMB]?)\s*(?:views?|plays?)/i
        );
        if (viewsMatch) {
          views = parseCount(viewsMatch[1].replace(/,/g, ""));
          break;
        }
      }
    }

    return { likes, comments, views };
  }

  function extractFeedEngagement(postEl) {
    let likes = 0;
    let comments = 0;
    let views = 0;

    const allLinks = postEl.querySelectorAll("a, button, span, div");
    for (const el of allLinks) {
      const text = (el.textContent || "").trim();
      if (el.children.length > 5) continue;

      if (likes === 0) {
        const likesMatch = text.match(/([\d,]+\.?\d*[KMB]?)\s*likes?/i);
        if (likesMatch) {
          likes = Math.max(
            likes,
            parseCount(likesMatch[1].replace(/,/g, ""))
          );
        }
        const othersMatch = text.match(
          /and\s+([\d,]+\.?\d*[KMB]?)\s*others?/i
        );
        if (othersMatch) {
          likes = Math.max(
            likes,
            parseCount(othersMatch[1].replace(/,/g, "")) + 1
          );
        }
        if (text.toLowerCase().includes("liked by") && likes === 0) {
          const ariaLabel = el.getAttribute("aria-label") || "";
          const countMatch = ariaLabel.match(/([\d,]+\.?\d*[KMB]?)/);
          if (countMatch) {
            likes = Math.max(
              likes,
              parseCount(countMatch[1].replace(/,/g, ""))
            );
          }
        }
      }

      if (comments === 0) {
        const commentsMatch = text.match(
          /(?:View\s+all\s+)?([\d,]+\.?\d*[KMB]?)\s*comments?/i
        );
        if (commentsMatch) {
          comments = Math.max(
            comments,
            parseCount(commentsMatch[1].replace(/,/g, ""))
          );
        }
      }

      if (views === 0) {
        const viewsMatch = text.match(/([\d,]+\.?\d*[KMB]?)\s*views?/i);
        if (viewsMatch) {
          views = Math.max(
            views,
            parseCount(viewsMatch[1].replace(/,/g, ""))
          );
        }
        const playsMatch = text.match(/([\d,]+\.?\d*[KMB]?)\s*plays?/i);
        if (playsMatch) {
          views = Math.max(
            views,
            parseCount(playsMatch[1].replace(/,/g, ""))
          );
        }
      }
    }

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
          if (m)
            comments = Math.max(
              comments,
              parseCount(m[1].replace(/,/g, ""))
            );
        }
        if (label.includes("view") || label.includes("play")) {
          const m = label.match(/([\d,]+\.?\d*[KMB]?)/i);
          if (m) views = Math.max(views, parseCount(m[1].replace(/,/g, "")));
        }
      }
    }

    if (likes === 0) {
      const sections = postEl.querySelectorAll("section");
      for (const section of sections) {
        const text = (section.textContent || "").trim();
        const likesMatch = text.match(/([\d,]+\.?\d*[KMB]?)\s*likes?/i);
        if (likesMatch) {
          likes = parseCount(likesMatch[1].replace(/,/g, ""));
          break;
        }
        const othersMatch = text.match(
          /and\s+([\d,]+\.?\d*[KMB]?)\s*others?/i
        );
        if (othersMatch) {
          likes = parseCount(othersMatch[1].replace(/,/g, "")) + 1;
          break;
        }
      }
    }

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

  function extractGridMeta(postInfo) {
    const el = postInfo.element;
    const linkEl = postInfo.linkElement || el;
    let username = "";
    let postUrl = "";
    let caption = "";

    const pathMatch = window.location.pathname.match(
      /^\/([A-Za-z0-9_.]+)/
    );
    if (pathMatch) {
      username = pathMatch[1];
    }

    const href =
      (linkEl.tagName === "A" && linkEl.getAttribute("href")) || "";
    if (href) {
      postUrl = href.startsWith("http")
        ? href
        : "https://www.instagram.com" + href;
    }
    if (!postUrl) {
      const innerLink = el.querySelector(
        'a[href*="/p/"], a[href*="/reel/"]'
      );
      if (innerLink) {
        const h = innerLink.getAttribute("href") || "";
        postUrl = h.startsWith("http")
          ? h
          : "https://www.instagram.com" + h;
      }
    }

    const img = el.querySelector("img[alt]");
    if (img) {
      const alt = (img.getAttribute("alt") || "").trim();
      if (alt.length > 10) {
        caption = alt.length > 150 ? alt.substring(0, 147) + "..." : alt;
      }
    }

    return { username, postUrl, caption };
  }

  function extractFeedMeta(postEl) {
    let username = "";
    let postUrl = "";
    let caption = "";

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
            "p",
            "reel",
            "explore",
            "stories",
            "accounts",
            "directory",
          ].includes(userMatch[1])
        ) {
          username = userMatch[1];
          break;
        }
      }
    }

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
        if (showScores) addScoreBadge(item, scoredPosts);
      }
    } else {
      for (const item of scoredPosts) {
        item.element.classList.remove("ieh-tier1", "ieh-tier2");
        if (item.score >= absoluteThreshold * 2) {
          item.element.classList.add("ieh-tier1");
        } else if (item.score >= absoluteThreshold) {
          item.element.classList.add("ieh-tier2");
        }
        if (showScores) addScoreBadge(item, scoredPosts);
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
    const existing = item.element.querySelector(".ieh-score-badge");
    if (existing) existing.remove();

    if (!showScores) return;

    const badge = document.createElement("div");
    const colorTier = allScored ? getScoreColor(item, allScored) : "gray";
    badge.className =
      "ieh-score-badge" +
      (item.type === "grid" ? " ieh-grid-badge" : "") +
      " ieh-color-" +
      colorTier;

    const parts = [];
    if (item.engagement.likes > 0)
      parts.push(`\u2764\ufe0f ${formatCount(item.engagement.likes)}`);
    if (item.engagement.comments > 0)
      parts.push(`\ud83d\udcac ${formatCount(item.engagement.comments)}`);
    if (item.engagement.views > 0)
      parts.push(`\ud83d\udc41 ${formatCount(item.engagement.views)}`);

    const breakdown = parts.length > 0 ? parts.join("  ") : "no data";

    badge.innerHTML = `<span class="ieh-badge-score">${item.score.toLocaleString()}</span><span class="ieh-badge-detail">${breakdown}</span>`;

    const computedStyle = window.getComputedStyle(item.element);
    if (computedStyle.position === "static") {
      item.element.style.position = "relative";
    }
    if (item.type === "grid") {
      item.element.style.overflow = "visible";
    }

    item.element.appendChild(badge);
  }

  // ─── Main Processing ─────────────────────────────────────────────────

  let lastScoredPosts = [];

  function processAllPosts(forceRefresh) {
    if (!enabled) {
      clearHighlights();
      return;
    }

    const posts = findAllPosts();
    let hasNew = false;
    const scoredPosts = [];

    for (const postInfo of posts) {
      const cached = !forceRefresh && scoredCache.get(postInfo.element);
      if (cached) {
        scoredPosts.push(cached);
        continue;
      }

      hasNew = true;
      const engagement = extractEngagement(postInfo);
      const score = calculateScore(engagement);
      const entry = {
        element: postInfo.element,
        type: postInfo.type,
        score,
        engagement,
      };
      scoredCache.set(postInfo.element, entry);
      scoredPosts.push(entry);
    }

    if (
      !hasNew &&
      !forceRefresh &&
      lastScoredPosts.length === scoredPosts.length
    ) {
      return;
    }

    lastScoredPosts = scoredPosts;
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

  let lastUrl = window.location.href;

  function setupNavigationListener() {
    setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        setTimeout(() => {
          processAllPosts();
          updateExtractCount();
          updatePageIndicator();

          // Show/hide scan section based on page type
          const scanSection = document.getElementById("ieh-scan-section");
          if (scanSection) {
            scanSection.style.display =
              getPageType() === "profile" ? "block" : "none";
          }
        }, 1500);
      }
    }, 500);
  }

  // ─── Auto-scroll ─────────────────────────────────────────────────────

  function startAutoScroll() {
    if (autoScrollRafId) return;
    lastScrollTime = performance.now();

    function scrollStep(now) {
      if (!autoScrollEnabled) {
        autoScrollRafId = null;
        return;
      }
      const delta = now - lastScrollTime;
      lastScrollTime = now;
      const pxPerSec =
        SCROLL_SPEEDS[Math.min(autoScrollSpeed - 1, 5)] || 1200;
      const px = (pxPerSec * delta) / 1000;
      const variance = 1 + Math.sin(now / 800) * 0.15;
      window.scrollBy({ top: px * variance, behavior: "instant" });
      autoScrollRafId = requestAnimationFrame(scrollStep);
    }

    autoScrollRafId = requestAnimationFrame(scrollStep);
  }

  function stopAutoScroll() {
    if (autoScrollRafId) {
      cancelAnimationFrame(autoScrollRafId);
      autoScrollRafId = null;
    }
  }

  // ─── Date Helpers ─────────────────────────────────────────────────────

  function formatDate(date) {
    if (!date) return "—";
    const d = new Date(date);
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  function formatDateShort(date) {
    if (!date) return "";
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function isSameDay(d1, d2) {
    return (
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate()
    );
  }

  // ─── Calendar Helpers ──────────────────────────────────────────────

  function getPostsByDate() {
    const byDate = {};
    for (const [, post] of collectedPosts) {
      if (!post.date) continue;
      const key = formatDateShort(post.date);
      if (!byDate[key]) byDate[key] = [];
      byDate[key].push(post);
    }
    return byDate;
  }

  function buildCalendarHTML(month, postsByDate) {
    const year = month.getFullYear();
    const mo = month.getMonth();
    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];

    const firstDay = new Date(year, mo, 1).getDay();
    const daysInMonth = new Date(year, mo + 1, 0).getDate();

    // Find max score for this month to normalize colors
    let maxDayScore = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const posts = postsByDate[key] || [];
      const dayScore = posts.reduce((sum, p) => sum + p.score, 0);
      maxDayScore = Math.max(maxDayScore, dayScore);
    }

    let html = `
      <div class="ieh-calendar">
        <div class="ieh-cal-header">
          <button class="ieh-cal-nav" data-dir="-1">&lsaquo;</button>
          <span class="ieh-cal-title">${monthNames[mo]} ${year}</span>
          <button class="ieh-cal-nav" data-dir="1">&rsaquo;</button>
        </div>
        <div class="ieh-cal-grid">
          <div class="ieh-cal-day-label">Su</div>
          <div class="ieh-cal-day-label">Mo</div>
          <div class="ieh-cal-day-label">Tu</div>
          <div class="ieh-cal-day-label">We</div>
          <div class="ieh-cal-day-label">Th</div>
          <div class="ieh-cal-day-label">Fr</div>
          <div class="ieh-cal-day-label">Sa</div>`;

    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
      html += '<div class="ieh-cal-cell ieh-cal-empty"></div>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const posts = postsByDate[key] || [];
      const postCount = posts.length;
      const dayScore = posts.reduce((sum, p) => sum + p.score, 0);

      let heatClass = "";
      if (postCount > 0 && maxDayScore > 0) {
        const intensity = dayScore / maxDayScore;
        if (intensity >= 0.7) heatClass = "ieh-cal-hot";
        else if (intensity >= 0.4) heatClass = "ieh-cal-warm";
        else if (intensity >= 0.15) heatClass = "ieh-cal-mild";
        else heatClass = "ieh-cal-cool";
      }

      const today = new Date();
      const isToday =
        d === today.getDate() &&
        mo === today.getMonth() &&
        year === today.getFullYear();

      html += `<div class="ieh-cal-cell ${heatClass} ${isToday ? "ieh-cal-today" : ""} ${postCount > 0 ? "ieh-cal-has-posts" : ""}"
                    data-date="${key}" title="${postCount} post${postCount !== 1 ? "s" : ""}, score: ${dayScore.toLocaleString()}">
                 <span class="ieh-cal-day-num">${d}</span>
                 ${postCount > 0 ? `<span class="ieh-cal-dot">${postCount}</span>` : ""}
               </div>`;
    }

    html += "</div></div>";
    return html;
  }

  // ─── Control Panel ───────────────────────────────────────────────────

  function createControlPanel() {
    if (document.getElementById("ieh-panel")) return;

    const isProfile = getPageType() === "profile";

    const panel = document.createElement("div");
    panel.id = "ieh-panel";
    panel.innerHTML = `
      <div class="ieh-panel-header">
        <span class="ieh-panel-title">IG Engagement Highlighter</span>
        <button class="ieh-panel-toggle-collapse" title="Minimize">&#x2212;</button>
      </div>
      <div class="ieh-panel-body">

        <div id="ieh-page-type" class="ieh-page-indicator"></div>

        <!-- Scan Profile section (only on profile pages) -->
        <div id="ieh-scan-section" style="display:${isProfile ? "block" : "none"}">
          <div class="ieh-section-label">Scan profile</div>
          <div class="ieh-scroll-note">
            Fetches ALL posts with full engagement data and dates via Instagram's API.
          </div>
          <button id="ieh-scan-profile" class="ieh-btn ieh-btn-scan">Scan All Posts</button>
          <button id="ieh-scan-stop" class="ieh-btn ieh-btn-stop" style="display:none">Stop Scan</button>
          <div id="ieh-scan-status" class="ieh-scan-status"></div>
        </div>

        <!-- Highlighter section -->
        <div class="ieh-section-label">Highlighting</div>
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
          <input type="range" id="ieh-scroll-speed" min="1" max="6" value="3" step="1" />
          <span id="ieh-scroll-speed-val">3</span>
        </div>
        <div class="ieh-scroll-note">
          Smoothly scrolls through your feed. Speed 1 = gentle, 6 = turbo.
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
            <option value="100">100 posts</option>
            <option value="all">All posts</option>
          </select>
        </div>
        <div class="ieh-control-row">
          <label class="ieh-label">Type:</label>
          <select id="ieh-export-type-filter">
            <option value="all" selected>All types</option>
            <option value="reel">Reels only</option>
            <option value="photo">Photos only</option>
            <option value="carousel">Carousels only</option>
          </select>
        </div>
        <div class="ieh-control-row">
          <label class="ieh-label">From:</label>
          <input type="date" id="ieh-date-from" class="ieh-date-input" />
        </div>
        <div class="ieh-control-row">
          <label class="ieh-label">To:</label>
          <input type="date" id="ieh-date-to" class="ieh-date-input" />
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

    // ── Scan controls ──
    document
      .getElementById("ieh-scan-profile")
      .addEventListener("click", () => {
        scanProfile();
      });

    document.getElementById("ieh-scan-stop").addEventListener("click", () => {
      stopScan();
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
      processAllPosts(true);
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
        processAllPosts(true);
      });

    document
      .getElementById("ieh-w-likes")
      .addEventListener("change", (e) => {
        weights.likes = parseFloat(e.target.value) || 0;
        recalcCollectedScores();
        processAllPosts(true);
        saveSettings();
      });

    document
      .getElementById("ieh-w-comments")
      .addEventListener("change", (e) => {
        weights.comments = parseFloat(e.target.value) || 0;
        recalcCollectedScores();
        processAllPosts(true);
        saveSettings();
      });

    document
      .getElementById("ieh-w-views")
      .addEventListener("change", (e) => {
        weights.views = parseFloat(e.target.value) || 0;
        recalcCollectedScores();
        processAllPosts(true);
        saveSettings();
      });

    document
      .getElementById("ieh-recalculate")
      .addEventListener("click", () => {
        recalcCollectedScores();
        processAllPosts(true);
      });

    // ── Date filter controls ──
    document
      .getElementById("ieh-date-from")
      .addEventListener("change", (e) => {
        dateFilterFrom = e.target.value;
      });

    document
      .getElementById("ieh-date-to")
      .addEventListener("change", (e) => {
        dateFilterTo = e.target.value;
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
    const tab = getProfileTab();
    const labels = {
      feed: "Feed view",
      profile: "Profile grid",
      post: "Single post",
      explore: "Explore",
    };
    let label = labels[pageType] || pageType;
    if (pageType === "profile" && tab !== "posts") {
      label += ` (${tab})`;
    }
    if (collectedPosts.size > 0) {
      label += ` \u2022 ${collectedPosts.size} scanned`;
    }
    el.textContent = label;
  }

  // ─── Extract Top Posts ────────────────────────────────────────────────

  function updateExtractCount() {
    const countEl = document.getElementById("ieh-extract-count");
    if (!countEl) return;

    if (collectedPosts.size > 0) {
      countEl.textContent = `${collectedPosts.size} posts scanned (full data)`;
    } else {
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
  }

  function getFilteredPosts() {
    // Build the post list: prefer API-collected data, fallback to DOM
    let scored = [];

    if (collectedPosts.size > 0) {
      // Use API data
      for (const [, post] of collectedPosts) {
        scored.push({ ...post });
      }
    } else {
      // Fallback: DOM scraping
      const posts = findAllPosts();
      for (const postInfo of posts) {
        const engagement = extractEngagement(postInfo);
        const score = calculateScore(engagement);
        const meta = extractPostMeta(postInfo);
        scored.push({ ...meta, ...engagement, score, date: null, mediaType: null });
      }
    }

    // Apply type filter
    const typeFilter = document.getElementById("ieh-export-type-filter");
    const typeVal = typeFilter ? typeFilter.value : "all";
    if (typeVal !== "all") {
      scored = scored.filter((p) => p.mediaType === typeVal);
    }

    // Apply date filter
    if (dateFilterFrom) {
      const from = new Date(dateFilterFrom + "T00:00:00");
      scored = scored.filter((p) => p.date && new Date(p.date) >= from);
    }
    if (dateFilterTo) {
      const to = new Date(dateFilterTo + "T23:59:59");
      scored = scored.filter((p) => p.date && new Date(p.date) <= to);
    }

    // Recalculate scores with current weights
    for (const p of scored) {
      p.score =
        (p.likes || 0) * weights.likes +
        (p.comments || 0) * weights.comments +
        (p.views || 0) * weights.views;
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  function extractTopPosts() {
    let scored = getFilteredPosts();

    const countSel = document.getElementById("ieh-export-count");
    const countVal = countSel ? countSel.value : "10";
    const limit =
      countVal === "all" ? scored.length : parseInt(countVal, 10) || 10;
    const topPosts = scored.slice(0, limit);

    updateExtractCount();
    showExportModal(topPosts, scored.length);
  }

  function showExportModal(posts, totalFiltered) {
    const existing = document.getElementById("ieh-export-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "ieh-export-modal";
    overlay.className = "ieh-modal-overlay";

    const hasDateData = posts.some((p) => p.date);

    // Group by time period for the summary
    let timeSummary = "";
    if (hasDateData) {
      const byMonth = {};
      for (const p of posts) {
        if (!p.date) continue;
        const d = new Date(p.date);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!byMonth[key]) byMonth[key] = { count: 0, totalScore: 0 };
        byMonth[key].count++;
        byMonth[key].totalScore += p.score;
      }
      const monthEntries = Object.entries(byMonth).sort((a, b) =>
        a[0].localeCompare(b[0])
      );
      if (monthEntries.length > 0) {
        const monthNames = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];
        timeSummary = monthEntries
          .map(([key, v]) => {
            const [y, m] = key.split("-");
            return `<span class="ieh-time-chip">${monthNames[parseInt(m, 10) - 1]} ${y}: ${v.count} posts, ${formatCount(v.totalScore)} score</span>`;
          })
          .join("");
      }
    }

    let tableRows = "";
    posts.forEach((p, i) => {
      const user = p.username ? `@${p.username}` : "unknown";
      const link = p.postUrl
        ? `<a href="${p.postUrl}" target="_blank" rel="noopener noreferrer" class="ieh-modal-link">${p.postUrl.length > 40 ? p.postUrl.substring(0, 37) + "..." : p.postUrl}</a>`
        : "N/A";
      const cap = p.caption
        ? `<span class="ieh-modal-caption">${p.caption.replace(/</g, "&lt;").replace(/>/g, "&gt;").substring(0, 200)}</span>`
        : "";
      const dateStr = p.date ? formatDate(p.date) : "—";
      const typeLabel = p.mediaType
        ? `<span class="ieh-type-chip ieh-type-${p.mediaType}">${p.mediaType}</span>`
        : "";

      tableRows += `
        <tr>
          <td class="ieh-modal-rank">${i + 1}</td>
          <td class="ieh-modal-user">${user}</td>
          <td class="ieh-modal-metrics">${formatCount(p.likes || 0)}</td>
          <td class="ieh-modal-metrics">${formatCount(p.comments || 0)}</td>
          <td class="ieh-modal-metrics">${formatCount(p.views || 0)}</td>
          <td class="ieh-modal-score">${p.score.toLocaleString()}</td>
          <td class="ieh-modal-date">${dateStr}</td>
          <td class="ieh-modal-type">${typeLabel}</td>
          <td class="ieh-modal-link-cell">${link}</td>
        </tr>
        ${cap ? `<tr class="ieh-caption-row"><td></td><td colspan="8">${cap}</td></tr>` : ""}
      `;
    });

    // Calendar heatmap
    const postsByDate = getPostsByDate();
    const calendarHtml =
      collectedPosts.size > 0
        ? buildCalendarHTML(calendarMonth, postsByDate)
        : "";

    overlay.innerHTML = `
      <div class="ieh-modal">
        <div class="ieh-modal-header">
          <span class="ieh-modal-title">Top ${posts.length} Posts (of ${totalFiltered} filtered${collectedPosts.size > 0 ? `, ${collectedPosts.size} total scanned` : ""})</span>
          <button class="ieh-modal-close" title="Close">&times;</button>
        </div>
        <div class="ieh-modal-actions">
          <button id="ieh-copy-text" class="ieh-btn ieh-btn-sm">Copy as Text</button>
          <button id="ieh-copy-json" class="ieh-btn ieh-btn-sm">Copy JSON</button>
          <button id="ieh-download-csv" class="ieh-btn ieh-btn-sm">Download CSV</button>
        </div>
        ${timeSummary ? `<div class="ieh-time-summary">${timeSummary}</div>` : ""}
        ${calendarHtml ? `<div class="ieh-cal-container" id="ieh-calendar-container">${calendarHtml}</div>` : ""}
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
                <th>Date</th>
                <th>Type</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
          ${posts.length === 0 ? '<div class="ieh-modal-empty">No posts found. Use "Scan All Posts" on a profile page to fetch complete data, or scroll through the feed first.</div>' : ""}
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

    // ── Calendar navigation ──
    const calContainer = document.getElementById("ieh-calendar-container");
    if (calContainer) {
      calContainer.addEventListener("click", (e) => {
        const navBtn = e.target.closest(".ieh-cal-nav");
        if (navBtn) {
          const dir = parseInt(navBtn.dataset.dir, 10);
          calendarMonth = new Date(
            calendarMonth.getFullYear(),
            calendarMonth.getMonth() + dir,
            1
          );
          calContainer.innerHTML = buildCalendarHTML(
            calendarMonth,
            postsByDate
          );
        }

        const cell = e.target.closest(".ieh-cal-has-posts");
        if (cell) {
          const dateKey = cell.dataset.date;
          // Set date filter and refresh
          const dateFrom = document.getElementById("ieh-date-from");
          const dateTo = document.getElementById("ieh-date-to");
          if (dateFrom) dateFrom.value = dateKey;
          if (dateTo) dateTo.value = dateKey;
          dateFilterFrom = dateKey;
          dateFilterTo = dateKey;
          // Close and re-extract with the date filter
          overlay.remove();
          extractTopPosts();
        }
      });
    }

    // ── Copy as Text ──
    document.getElementById("ieh-copy-text").addEventListener("click", () => {
      const lines = posts.map((p, i) => {
        const user = p.username ? `@${p.username}` : "unknown";
        const parts = [];
        if (p.likes > 0) parts.push(`${formatCount(p.likes)} likes`);
        if (p.comments > 0)
          parts.push(`${formatCount(p.comments)} comments`);
        if (p.views > 0) parts.push(`${formatCount(p.views)} views`);
        let line = `${i + 1}. ${user} \u2014 Score: ${p.score.toLocaleString()} (${parts.join(", ")})`;
        if (p.date) line += `\n   Posted: ${formatDate(p.date)}`;
        if (p.mediaType) line += ` [${p.mediaType}]`;
        if (p.postUrl) line += `\n   ${p.postUrl}`;
        if (p.caption)
          line += `\n   "${p.caption.substring(0, 200)}"`;
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
        date: p.date ? formatDateShort(p.date) : null,
        mediaType: p.mediaType || null,
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
          "Rank,Username,Likes,Comments,Views,Score,Date,Type,Post URL,Caption";
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
            p.likes || 0,
            p.comments || 0,
            p.views || 0,
            p.score,
            escapeCsv(p.date ? formatDateShort(p.date) : ""),
            escapeCsv(p.mediaType || ""),
            escapeCsv(p.postUrl || ""),
            escapeCsv((p.caption || "").substring(0, 500)),
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

    setTimeout(processAllPosts, 1000);
    setTimeout(processAllPosts, 3000);

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
