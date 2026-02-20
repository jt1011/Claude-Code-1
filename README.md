# Instagram Engagement Highlighter

A Chrome extension that visually highlights high-engagement Instagram posts. Uses Instagram's internal API to fetch **ALL posts** from any profile with full engagement data and timestamps. Includes a calendar heatmap and date-range filtering. Fully client-side — no data collection, no external servers.

## Features

- **Scan All Posts** — Fetches every post from a profile via Instagram's API (no 20-post limit). Gets full likes, comments, views, post date, and media type
- **Visual Highlighting** — Color-coded borders and glowing shadows on high-engagement posts
  - Tier 1 (top performers): Pink/red border with glow
  - Tier 2 (above median): Purple border
- **Score Badges** — Color-coded badges (gold/green/blue/gray) showing engagement breakdown on each post
- **Calendar Heatmap** — Monthly calendar view showing posting activity and engagement intensity. Click any day to filter posts from that date
- **Date-Range Filtering** — From/To date pickers to analyze engagement within specific time periods
- **Time-Based Grouping** — Export modal shows monthly breakdown with post counts and aggregate scores
- **Post Type Filtering** — Filter by Reels, Photos, or Carousels
- **Multiple Page Support** — Works on feed, profile grid, explore, and single post views
- **Two Scoring Modes**
  - *Percentile* (default): Automatically highlights top 10% and above-median posts
  - *Fixed Threshold*: Set a manual engagement score cutoff
- **Configurable Weights** — Adjust how much likes, comments, and views contribute to the score
- **Auto-Scroll** — Smooth feed scrolling with 6 speed levels
- **Extract Top Posts** — Export up to 100+ posts as formatted text, JSON, or CSV (with date and type columns)
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

### Profile Scanning (API-based)

On any profile page, click **"Scan All Posts"** to fetch every post via Instagram's internal API. This gives you:
- Full engagement counts (likes, comments, views) — no more "no data" on grid posts
- Exact posting dates for every post
- Media type classification (reel, photo, carousel)
- No limit on post count — scans the entire profile

### Scoring

Each post gets a weighted engagement score:

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
