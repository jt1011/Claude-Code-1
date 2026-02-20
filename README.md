# Instagram Engagement Highlighter

A Chrome extension that visually highlights high-engagement Instagram posts based on visible engagement metrics. Fully client-side — no data collection, no API calls, no automation.

## Features

- **Visual Highlighting** — Color-coded borders and glowing shadows on high-engagement posts
  - Tier 1 (top performers): Pink/red border with glow
  - Tier 2 (above median): Purple border
- **Score Badges** — Color-coded badges (gold/green/blue/gray) showing engagement breakdown on each post
- **Multiple Page Support** — Works on feed, profile grid, explore, and single post views
- **Two Scoring Modes**
  - *Percentile* (default): Automatically highlights top 10% and above-median posts
  - *Fixed Threshold*: Set a manual engagement score cutoff
- **Configurable Weights** — Adjust how much likes, comments, and views contribute to the score
- **Auto-Scroll** — Smooth feed scrolling with 6 speed levels
- **Extract Top Posts** — Export your top-performing posts as formatted text, JSON, or CSV
- **Draggable Control Panel** — Collapsible floating panel to configure everything on the fly
- **Dark Mode** — Automatically adapts to system and Instagram dark mode
- **Settings Persistence** — Your preferences are saved locally via `chrome.storage`

## Installation

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select this project folder
5. Navigate to [instagram.com](https://www.instagram.com) — the control panel appears in the top-right corner

## How It Works

The extension reads only visible DOM elements to extract engagement counts (likes, comments, views). It calculates a weighted score per post:

```
Score = (Likes x LikeWeight) + (Comments x CommentWeight) + (Views x ViewWeight)
```

Default weights: Likes (5x), Comments (10x), Views (2x). All processing happens client-side in the browser — nothing is sent anywhere.

## Files

| File | Description |
|------|-------------|
| `manifest.json` | Chrome Manifest V3 extension config |
| `content.js` | Main content script — scoring, highlighting, UI |
| `styles.css` | All styling — tiers, badges, control panel, modal, dark mode |
| `icons/` | Extension icons (16x16, 48x48, 128x128) |

## Permissions

- **storage** — Save your settings locally
- **host_permissions** — `https://www.instagram.com/*` (content script runs only on Instagram)
