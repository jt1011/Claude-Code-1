# LinkedIn Engagement Highlighter V3

A Chrome extension that visually highlights high-engagement LinkedIn posts based on visible engagement metrics. Features 4-tier color scoring, date filtering, post extraction with export, and a modern polished UI. Fully client-side — no data collection, no API calls, no automation.

## Features

- **Visual Highlighting** — Color-coded borders on high-engagement posts
  - Tier 1 (top performers): LinkedIn blue border with glow
  - Tier 2 (above median): Green accent border
- **4-Tier Score Badges** — Gold (top 10%), Green (top 30%), Blue (top 60%), Gray — showing engagement breakdown on each post
- **Works Everywhere on LinkedIn**
  - Home feed (`linkedin.com/feed/`)
  - Profile activity pages (`/in/*/recent-activity/`)
  - Company pages (`/company/*/`)
  - Search results (`/search/`)
- **Two Scoring Modes**
  - *Percentile* (default): Automatically highlights top 10% and above-median posts
  - *Fixed Threshold*: Set a manual engagement score cutoff
- **Date Filtering** — Filter posts by time range: 24h, 7 days, 30 days, 90 days, or custom date range
- **Configurable Weights** — Adjust how much reactions, comments, and reposts contribute to the score
- **Auto-Scroll** — Smooth `requestAnimationFrame`-based scrolling with 6 speed levels and automatic "Show More" button handling
- **Extract Top Posts** — Preview ranked posts in a table and export as formatted text, JSON, or CSV (up to 150 posts)
- **Modern UI** — Polished control panel with toggle switches, collapsible sections, and glass-morphism design
- **Dark Mode** — Automatically adapts to system and LinkedIn dark mode
- **Settings Persistence** — Your preferences are saved locally via `chrome.storage`

## Installation

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select this project folder
5. Navigate to [linkedin.com](https://www.linkedin.com) — the control panel appears in the top-right corner

## How It Works

The extension reads only visible DOM elements to extract engagement counts (reactions, comments, reposts). It calculates a weighted score per post:

```
Score = (Reactions x ReactionWeight) + (Comments x CommentWeight) + (Reposts x RepostWeight)
```

Default weights: Reactions (5x), Comments (10x), Reposts (2x). All processing happens client-side in the browser — nothing is sent anywhere.

## Files

| File | Description |
|------|-------------|
| `manifest.json` | Chrome Manifest V3 extension config |
| `content.js` | Main content script — detection, scoring, highlighting, UI |
| `styles.css` | All styling — tiers, badges, control panel, modal, dark mode |
| `icons/` | Extension icons (16x16, 48x48, 128x128) |

## Permissions

- **storage** — Save your settings locally
- **host_permissions** — `https://www.linkedin.com/*` (content script runs only on LinkedIn)
