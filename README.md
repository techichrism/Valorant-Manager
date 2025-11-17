# Nebula
<img width="740" height="705" alt="image" src="https://github.com/user-attachments/assets/05209b47-df37-460a-b54c-45c146a20fe0" />
<img width="743" height="698" alt="image" src="https://github.com/user-attachments/assets/82edf74e-6851-41a5-8328-f9e8cd1c3fba" />
<img width="746" height="698" alt="image" src="https://github.com/user-attachments/assets/9cc261c1-93e6-43b0-99c8-5287ed737ac0" />

A fast, secure Valorant account manager with optional live match info, store tracking, and player stats. Switch between accounts seamlessly.

> **Disclaimer:** This project interacts with unofficial Riot Games APIs and is subject to change. Use at your own risk. Not endorsed by Riot Games. Live API features are opt-in and disabled by default.

## Features

### Account Manager
- **Account switching** — Switch accounts and launch Valorant automatically via snapshot/restore
- **Secure sessions** — Auth cookies encrypted with OS-level encryption (safeStorage/DPAPI)
- **Rank badges** — Current and peak rank with RR and act name, displayed on every account card
- **Session stats** — Today's record inline: `8W 2L · ↑24 RR` with green/red delta arrows
- **Search & filter** — Find accounts by name, nickname, region, or rank (`rank:diamond`)
- **Settings copy** — Surgical key-level merge across crosshair, sensitivity, audio, video, minimap, HUD, gameplay, keybinds. Safe mirror semantics that never touch account-bound keys
- **Import accounts** — Import accounts already logged in via the Riot Client
- **Session health check** — Verify session validity with transient-network-error handling
- **Nicknames & reorder** — Label accounts and drag-and-drop to reorder
- **Tray quick-launch** — Right-click the tray icon to launch any account without opening the main window
- **Auto-launch toggle** — Launch Valorant automatically or just open Riot Client

### Match Info *(opt-in)*
- **Live match detection** — Pregame (agent select) and coregame (in-match) phases
- **Team panels** — Allies and enemies with agent, level, rank icon, incognito flag
- **Starting side** — Correct Attack/Defense badge based on team color
- **Blacklist** — Flag problem players with a reason; prominent red warning banner when they appear in your match
- **Name-service yoinker fallback** — Match-details cache + optional Henrikdev community-cache fallback for incognito players (see hidden names)

### Player Stats dialog
Click any player in Match Info to open:
- **Current rank** + **peak rank** with RR and act name
- **10 most recent competitive matches** with map, agent, score, and KDA
- **Aggregate stats** — W/L, win rate, K/D, ACS, ADR, HS%, DDΔ (damage delta per round)
- **Agent filter** — Filter the match list by agent; aggregates recompute live
- **Add to blacklist** from the dialog with optional reason

### Store & Nightmarket *(opt-in)*
- **Daily offers** with VP cost and owned indicator (green pill, entitlements cross-referenced)
- **Featured bundles** — Hero art, pricing, discount %, bundle item grid
- **Nightmarket** — Discount % + striked original price (shown only when active)
- **Store wishlist** — Heart any skin; toast notification when a wishlisted skin shows up in any account's daily store
- **Browse all skins** — Searchable catalog of every buyable skin in Valorant

### UI/UX
- **Dark / Light / System themes** — Purple-accented UI built with React + shadcn/ui
- **Auto-updater** — Seamless updates from GitHub Releases

## Opt-in Live API features

Match Info and Store & Nightmarket are **disabled by default**. To enable them: `Settings → Live API features`. Both toggles are independent.

> ⚠ **Could be bannable — low chance, use at your own risk.** These features use Riot's live game endpoints which technically fall under their third-party application policy. No confirmed bans have been observed, but the risk isn't zero. Account-manager-only usage (ranks, session stats, copy settings, switching) is much safer and is always on.

## Build from Source

```bash
git clone https://github.com/techichrism/Valorant-Manager.git
cd Nebula
npm install
cd renderer && npm install && cd ..
npm run build:renderer
npm start
```

## Tech Stack

- **Electron 28** — Desktop app framework
- **React + Vite** — Frontend
- **Tailwind CSS + shadcn/ui** — Styling + animated skeletons
- **safeStorage (DPAPI)** — Cookie encryption
- **electron-updater** — Auto-updates

## Data & Privacy

All account data lives locally in `%APPDATA%\nebula`:
- `config.json` — Encrypted accounts, settings, blacklist, wishlist
- `name-cache.json` — Persistent puuid → name cache built from your match history
- `snapshots/` — Riot Client auth file snapshots per account

Nebula never uploads your account data anywhere. The installer preserves `%APPDATA%\nebula` across updates so your accounts and caches persist.


## License

MIT
