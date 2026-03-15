# Fix Plan: Ghost Posts ("data-dawn" with 0 engagement) + Sidebar Shrink Button

## Root Cause Analysis

The export modal shows rows like `data-dawn | — | 0 | 0 | 0 | 0 | TEXT | —` because:

### Problem 1: Overly aggressive post detection strategies
The `findAllPosts()` function uses 7 strategies, and the fallback ones (4-7) are too loose:

- **Strategy 4** (`[class*="social-counts"]`) — The wildcard `class*=` selector matches ANY element with "social-counts" in a class name, including non-post containers like sidebar widgets, ad units, and LinkedIn's navigation chrome.
- **Strategy 5** (`[class*="social-action"]`) — Same issue. Matches LinkedIn's top-bar action buttons, notification elements, etc.
- **Strategy 6** (walk up from "Like"/"Support" buttons) — Matches reaction buttons in comments, modals, and non-feed areas.
- **Strategy 7** (text pattern `N comments`) — Matches notification text like "You have 3 comments" in sidebars.

The `walkUpToPost()` fallback path (lines 203-211) accepts ANY element ≥150px tall and ≥300px wide that contains a button. This catches LinkedIn's sidebar panels, ad cards, "People you may know" sections, etc.

### Problem 2: `getPostKey()` generates keys for non-post elements
When a detected element has no `data-urn`, it generates a hash from `textContent.substring(0,200)`. Non-post elements like navigation or sidebar widgets get hashed and stored permanently in the `postStore`, polluting the data store.

### Problem 3: No validation before storing in `postStore`
`processAllPosts()` stores every detected element regardless of whether it has any engagement data, author, caption, or URL. Zero-engagement posts with no author/caption/URL should be filtered out or at minimum flagged as low-confidence.

### Problem 4: "data-dawn" is a LinkedIn `data-*` attribute
The `walkUpToPost()` function returns elements that have `el.getAttribute("data-id")` — LinkedIn uses `data-id` attributes on many non-post containers. The author extraction then finds `a[href*="/company/"]` links inside these containers (like "data-dawn" which is likely a company name from a sidebar widget or ad).

---

## Fix Plan

### Fix 1: Add post validation gate (content.js ~line 600, in `processAllPosts`)
After extracting engagement and metadata, validate the entry before storing:

```js
function isValidPost(eng, meta, element) {
  // Must have at least ONE of: engagement, caption, or post URL
  const hasEngagement = eng.reactions > 0 || eng.comments > 0 || eng.reposts > 0;
  const hasCaption = (meta.fullCaption || "").length > 10;
  const hasUrl = !!meta.postUrl;
  const hasUrn = (element.getAttribute("data-urn") || "").includes("urn:li:");

  // Reject if NONE of these signals exist
  if (!hasEngagement && !hasCaption && !hasUrl && !hasUrn) return false;

  return true;
}
```

**File:** `v4.0/content.js`
**Location:** Inside `processAllPosts()`, after `extractEngagement()` and `extractPostMeta()` calls (~line 618), add the validation check before `postStore.set()`.

### Fix 2: Tighten `walkUpToPost()` fallback (content.js ~line 203)
The size-based fallback is too loose. Add requirements:

```js
// In the fallback loop, also require:
// - Element has a data-urn OR contains a time element (posts always have timestamps)
// - Element is NOT inside known non-post containers
```

**File:** `v4.0/content.js`
**Location:** `walkUpToPost()` second loop (line 203-211). Add checks for `el.querySelector("time")` and exclude elements inside `.scaffold-layout__aside`, `.scaffold-layout__sidebar`, `[data-test-id="aside"]`.

### Fix 3: Restrict wildcard selectors in strategies 4-5 (content.js ~lines 147-163)
Scope strategies 4 and 5 to only search within the feed area, and use more specific selectors:

```js
// Strategy 4: Use exact class match, not wildcard
'.social-details-social-counts'  // remove [class*="social-counts"]

// Strategy 5: Use exact class match
'.feed-shared-social-actions, .social-details-social-activity'  // remove [class*="social-action"]
```

**File:** `v4.0/content.js`
**Location:** Lines 147-163 in `findAllPosts()`.

### Fix 4: Exclude known non-post containers (content.js, `findAllPosts`)
After collecting all candidates, filter out elements that are inside LinkedIn's sidebar/aside areas:

```js
// At the end of findAllPosts(), before deduplicatePosts:
const aside = document.querySelector('.scaffold-layout__aside, [data-test-id="aside"]');
const filtered = Array.from(found).filter(el => !aside || !aside.contains(el));
return deduplicatePosts(filtered);
```

**File:** `v4.0/content.js`
**Location:** End of `findAllPosts()`, before `return deduplicatePosts(...)`.

### Fix 5: Filter ghost entries from export modal
Even with detection fixes, add a safety net in the export display:

```js
// In extractTopPosts() and bulkCopyCaptions(), filter out zero-signal entries:
const scored = [];
for (const [, data] of postStore) {
  if (!isInDateRange(data.date)) continue;
  if (!matchesMediaFilter(data.mediaType)) continue;
  // NEW: skip ghost entries
  const hasSignal = data.engagement.reactions > 0 || data.engagement.comments > 0 ||
                    data.engagement.reposts > 0 || (data.fullCaption || "").length > 10;
  if (!hasSignal) continue;
  scored.push(data);
}
```

**File:** `v4.0/content.js`
**Location:** In `extractTopPosts()` (~line 1488), `bulkCopyCaptions()` (~line 1418), and `updatePostList()` (~line 1160).

### Fix 6: Add "Shrink/Expand Post Feed" toggle button in sidebar
Add a button that collapses the post card list in the sidebar to just show a compact summary (author + score on one line), vs the current expanded card view.

**File:** `v4.0/content.js`
**Location:** In `buildSidebarHTML()`, add a toggle button above the post list:

```html
<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 12px;">
  <span class="leh-filter-label">Posts</span>
  <button id="leh-shrink-toggle" class="leh-card-btn">Shrink</button>
</div>
```

**File:** `v4.0/content.js`
**Location:** In `wireUpSidebarEvents()`, add click handler that toggles a `leh-compact` class.

**File:** `v4.0/content.js`
**Location:** In `updatePostList()`, check compact mode and render mini cards (one-line: author | score | media badge) instead of full cards.

**File:** `v4.0/styles.css`
**Location:** Add new styles for `.leh-post-card.leh-compact` — single line, smaller padding, hide hook text.

---

## Files to modify:
1. `v4.0/content.js` — 6 changes (validation gate, tighter walkUp, tighter selectors, aside exclusion, export filter, shrink button)
2. `v4.0/styles.css` — 1 change (compact card styles)

## Summary of changes:
- **5 fixes** to eliminate ghost/false-positive post detection
- **1 feature** to add shrink/expand toggle for sidebar post feed
