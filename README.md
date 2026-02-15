# LinkedIn Engagement Highlighter

A lightweight Chrome extension that visually highlights high-engagement LinkedIn posts. It reads only what is already rendered on the page — no scraping, no automation, no API calls.

## What It Does

- Scans visible LinkedIn feed posts
- Reads engagement metrics (reactions, comments, reposts) from the DOM
- Calculates an engagement score per post
- Highlights top posts with colored borders and score badges

### Highlight Tiers

| Tier | Criteria (Percentile Mode) | Visual |
|------|---------------------------|--------|
| Tier 1 | Top 10% of visible posts | Gold border + glow |
| Tier 2 | Above median | Blue border |
| Tier 3 | Below median | No styling |

### Engagement Score Formula

```
Score = (Reactions × 1) + (Comments × 3) + (Reposts × 4)
```

All weights are configurable via the floating control panel.

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked**
5. Select the root folder of this project (containing `manifest.json`)
6. Navigate to [linkedin.com/feed](https://www.linkedin.com/feed) — the extension activates automatically

## Usage

Once active on LinkedIn, a floating **Engagement Highlighter** panel appears in the top-right corner.

### Controls

- **Enabled** — Toggle the highlighter on/off
- **Show Scores** — Toggle score badges on each post
- **Mode** — Switch between Percentile (relative) and Threshold (absolute) scoring
- **Threshold slider** — Set minimum score for highlighting (threshold mode only)
- **Weight inputs** — Adjust how reactions, comments, and reposts contribute to the score
- **Recalculate** — Manually re-scan all visible posts

The panel is draggable and collapsible.

## Privacy & Safety

This extension is designed to be fully compliant with safe browsing practices:

- **No network requests** — Zero `fetch()`, `XMLHttpRequest`, or any outbound calls
- **No data collection** — Post content is never logged or stored
- **No automation** — No auto-scrolling, clicking, or form interaction
- **No LinkedIn modification** — The extension only adds visual overlays; it does not alter LinkedIn's DOM structure or data
- **Local settings only** — User preferences (weights, mode) are stored via `chrome.storage.local` and never leave the browser
- **No external dependencies** — Pure vanilla JavaScript, no third-party libraries

The extension operates as a passive read-only visual filter on already-rendered page content.

## Technical Details

### Architecture

```
manifest.json      — Chrome Extension Manifest V3
content.js         — Content script: post detection, scoring, highlighting
styles.css         — All visual styles (tiers, badges, control panel)
icons/             — Extension icons (16, 48, 128px)
```

### How It Works

1. Content script runs on LinkedIn feed pages
2. `MutationObserver` watches for new posts loaded via infinite scroll
3. For each post, engagement counts are extracted from visible DOM text
4. Scores are calculated using configurable weights
5. Posts are ranked and highlighted based on the selected mode
6. Scroll events trigger debounced re-processing

### DOM Strategy

The extension uses multiple fallback selectors to find posts and engagement data:

- `.feed-shared-update-v2` containers
- `[data-urn]` and `[role="article"]` elements
- `aria-label` attributes on action buttons
- `.social-details-social-counts` region

### Edge Cases Handled

- Sponsored posts (processed normally; if no engagement data, skipped)
- Abbreviated numbers (1.2K, 3M, etc.)
- Posts without engagement data (silently skipped)
- Dynamic content loading (handled by MutationObserver)
- Dark mode (CSS adapts via `prefers-color-scheme`)

## Browser Compatibility

- Chrome 88+ (Manifest V3 support)
- Microsoft Edge (Chromium-based)
- Brave
- Other Chromium-based browsers

## License

MIT
