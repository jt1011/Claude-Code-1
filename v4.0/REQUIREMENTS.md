# LinkedIn Engagement Highlighter v4.0 — Requirements Document

## Overview
Complete rewrite of the LinkedIn Engagement Highlighter Chrome extension.
v4.0 is the "final, fully usable" version — no more iterations needed.

---

## Bug Fixes from v3.3

### BUG-1: Engagement Numbers Are Bloated
**Problem:** The score badge shows a single weighted score (e.g., 5,230) that users
mistake for the actual engagement count. The weighted formula `(reactions×5 + comments×10 + reposts×2)` inflates numbers far beyond real engagement.
**Fix:** Show **individual metrics** (reactions, comments, reposts) as the primary
display. The weighted score becomes a secondary "Score" label, clearly marked as
a ranking score — not a count.

### BUG-2: No Auto-Refresh / Must Manually Reload
**Problem:** When new posts load in the LinkedIn feed (via infinite scroll), they
don't get highlighted until a full page refresh. The MutationObserver only watches
for `addedNodes` and the WeakMap cache prevents re-processing of recycled DOM nodes.
**Fix:**
- Improved MutationObserver that also watches for attribute changes and subtree modifications.
- Periodic re-scan (every 2s) to catch posts that the observer misses.
- Cache invalidation when DOM elements are recycled (LinkedIn's virtual scroll).
- New posts get processed immediately with a visual "scanning" indicator.

### BUG-3: Auto-Scroll Only Goes Down
**Problem:** `startAutoScroll()` only scrolls downward. Users can't scroll back up
to revisit posts they passed.
**Fix:** Add scroll direction toggle (Down / Up / Pause). Users can switch direction
at any time. Up-scroll re-processes posts that come back into view.

### BUG-4: Newly Loaded Posts Don't Get Highlighted
**Problem:** LinkedIn uses virtual scrolling — DOM elements are recycled as users scroll.
The WeakMap cache holds references to removed elements, and new instances of the same
post get a fresh DOM element that isn't in the cache.
**Fix:** Use a persistent Map keyed by post URN (not DOM element). Store all extracted
data independently of the DOM. Re-apply highlights when elements re-enter the viewport.

### BUG-5: Export Modal Shows "No Data" After Scrolling
**Problem:** `extractTopPosts()` calls `findAllPosts()` which only finds currently
visible DOM posts. After scrolling, many posts are no longer in the DOM due to
LinkedIn's virtual scroll recycling.
**Fix:** Export from the **persistent data store**, not from live DOM queries. All
posts ever seen during the session are available for export, regardless of current
scroll position.

---

## New Features

### FEAT-1: Sidebar Layout (Like Clio)
**Description:** Replace the floating control panel with a right-side sidebar that
pushes LinkedIn's content left.
- Opens/closes with a tab on the right edge of the screen
- Full-height sidebar (100vh) with scrollable sections
- LinkedIn content reflows to accommodate the sidebar (no overlap)
- Remembers open/closed state across page navigations
- Width: 320px, collapsible to a 40px tab

### FEAT-2: Search Functionality
**Description:** Search through all detected posts by keyword.
- Real-time search-as-you-type with debounce (200ms)
- Searches across: post caption, author name, hook text
- Highlights matching terms in the search results
- Search results shown in the sidebar with post cards
- Click a search result to scroll to the post in the feed (if still in DOM)
- Search persists across scroll — uses the persistent data store

### FEAT-3: Media Type Filter
**Description:** Filter posts by media type: Text, Image, Video, Document, Carousel, Article.
- Multi-select filter chips in the sidebar
- Chips show count of posts per type (e.g., "Video (12)")
- Combines with date filter — both apply simultaneously
- Filtered-out posts are dimmed (opacity 0.4) rather than hidden
- "All" chip to reset

### FEAT-4: Bidirectional Auto-Scroll
**Description:** Auto-scroll supports both directions.
- Toggle between: Down ▼, Up ▲, Paused ⏸
- Speed slider (1-6) applies to both directions
- Auto-clicks "Show more" when scrolling down
- Smooth deceleration when switching directions

### FEAT-5: Live Post Counter & Session Stats
**Description:** Real-time stats displayed in the sidebar header.
- Total posts detected this session
- Posts currently in DOM
- Average engagement score
- Top post author
- Session duration
- Stats update every 2 seconds

### FEAT-6: Post Bookmarks
**Description:** Bookmark interesting posts for later export.
- Star icon on each post's score badge
- Bookmarked posts appear in a dedicated sidebar section
- Export only bookmarked posts (in addition to top-N export)
- Bookmarks persist via chrome.storage for the session

### FEAT-7: Engagement Trend Indicators
**Description:** Show whether a post's engagement is growing.
- On re-scan, compare new engagement numbers to previous scan
- Show ↑ or ↓ arrow next to metrics that changed
- Green for increasing, red for decreasing
- Helps identify posts that are currently going viral

### FEAT-8: Quick-Copy Individual Post
**Description:** One-click copy button on each post's score badge.
- Copies: author, date, caption, engagement metrics, URL
- Small clipboard icon in the badge corner
- Flash green on successful copy

### FEAT-9: Keyboard Shortcuts
**Description:** Power-user keyboard shortcuts.
- `Ctrl+Shift+L` — Toggle sidebar open/closed
- `Ctrl+Shift+S` — Start/stop auto-scroll
- `Ctrl+Shift+E` — Extract top posts
- `Ctrl+Shift+F` — Focus search box
- Shortcuts shown in a "?" help tooltip

---

## Architecture Changes

### Persistent Data Store
```
postStore = Map<string, PostData>
  key: post URN or generated ID
  value: {
    urn, author, date, caption, fullCaption, hook,
    mediaType, postUrl, engagement: { reactions, comments, reposts },
    score, firstSeen, lastSeen, bookmarked,
    previousEngagement (for trend detection)
  }
```
- Survives DOM recycling
- Powers search, export, and filters independently of DOM state
- Capped at 500 posts to prevent memory issues

### Sidebar Architecture
- Injected as a fixed-position element
- LinkedIn's main content gets `margin-right: 320px` when sidebar is open
- Sidebar has its own scrollable area
- Sections: Search, Filters, Stats, Posts List, Settings, Export

### Event Flow
1. MutationObserver + periodic scan detect posts
2. Extract engagement & metadata → store in postStore
3. Apply highlights to visible DOM elements
4. Update sidebar UI (stats, search results, filter counts)
5. Filters/search operate on postStore, not DOM

---

## Non-Functional Requirements
- No external network requests — fully client-side
- Works on: Feed, Activity, Company, Search, Profile pages
- Dark mode support (CSS prefers-color-scheme + LinkedIn class-based)
- Performance: <50ms per processing cycle for 100 posts
- Memory: postStore capped at 500 entries
- Chrome Manifest V3 compliant
- No dependencies — vanilla JS + CSS only
