# Hour Tracker — Project State

*Last saved: 2026-04-15*

A macOS menubar app that tracks daily hours against locked goals with a LoL-style ranked system, streaks, money tracking, and iCloud sync. Built in Tauri + React.

## Two builds

There are **two separate projects** on disk, both identical in code shape but configured differently:

| Folder | App name | Bundle ID | iCloud folder | Shortcut | Status |
|--------|----------|-----------|---------------|----------|--------|
| `/Users/mohabmarwan/Documents/hour-tracker` | Hour Tracker | `com.mohab.hourtracker` | `HourTracker/` | `⌘⌥T` | **Production — my daily app, don't break** |
| `/Users/mohabmarwan/Documents/hour-tracker-dev` | Hour Tracker Dev | `com.mohab.hourtracker.dev` | `HourTrackerDev/` | `⌘⌥D` | **Dev / staging — experimental changes live here** |

Dev is where all new features go first. Prod only gets updates after manual promotion.

## Personal vs public builds (dev project)

`VITE_PERSONAL=true npm run tauri build` → shows Money tab (personal / owner build).
`npm run tauri build` → hides Money tab (for distribution to friends).

## Tech stack

- **Tauri 2** (Rust backend + webview UI)
- **React 19 + TypeScript + Vite**
- **Plugins**: `store`, `fs`, `notification`, `autostart`, `global-shortcut`, `window-vibrancy`, `user-idle`
- **Data**: single JSON blob at `~/Library/Mobile Documents/com~apple~CloudDocs/HourTrackerDev/data.json` (iCloud-synced)
- **No backend yet** — everything is local + iCloud.

## Build / install commands

```bash
cd /Users/mohabmarwan/Documents/hour-tracker-dev
# personal build with Money tab:
VITE_PERSONAL=true npm run tauri build
# install:
rm -rf "/Applications/Hour Tracker Dev.app"
cp -R "src-tauri/target/release/bundle/macos/Hour Tracker Dev.app" /Applications/
xattr -cr "/Applications/Hour Tracker Dev.app"
open "/Applications/Hour Tracker Dev.app"
```

## What's built (dev project)

### Core
- Count-up timer (not a pomodoro) — per-project
- Daily **locked goal** (4–24h range, set once, immutable)
- Projects persist forever (global list, add/rename/delete)
- Per-project allocations with remaining-hours feedback (+ green when over-allocating)
- "+ Add time" (manual session) **removed** — was a cheating vector
- Carry-over hours **removed** — simplified model, penalty handles it
- Break timer (10-min countdown, auto-resume)
- Session counter (50-min blocks)
- History modal (today's sessions)

### Rank system
- 11 tiers Wood → Challenger
- **Wood–Master** have 3 divisions (III → II → I), 100 LP each
- **GM** is a single 500-LP window (no divisions)
- **Challenger** is unlimited (no divisions, top of ladder)
- Custom hex-gem SVG icons per rank (`src/RankIcon.tsx`)
- **Season reset** every Jan 1 — placement boost drops you 1 rank below final, at division III
- "Days per tier" histogram saved per past season

### LP math (all whole numbers)
- **+6 LP/hour** worked (first 10 hours)
- **+8 LP/hour** for overtime (past 10h, only if goal > 10h)
- **−3 LP/hour** missed, past days only (never today)
- Penalty target clamped to **4–10h window** (goal < 4 treated as 4; goal > 10 treated as 10)
- **−10 LP/day** at GM+ only, when streak enters decay phase

### Streaks 🔥
- +1 per day with **8+ hours** worked
- **3-day grace** (miss up to 3 days in a row, no penalty)
- **2 shields max**: earn at 7 and 60 streak days; regen every 60 days after 180-day streak
- Shields absorb missed days past grace
- Out of protection → **−50% streak immediately**, then **−50% every 7 days** of continued absence
- Shields displayed as 🛡 next to streak count

### Week view
- Prev/next week navigation
- Totals, % of goal, goals-done (X/7)
- Per-day bar chart (hit/miss colors)
- Per-project weekly breakdown

### Money tab (personal only)
- Monthly goal (editable per month)
- Log earnings (amount + source + optional note)
- Range selector: This month / Last month / Quarter / Year / All
- By-source breakdown
- Currency symbol configurable ($ / € / £ / ¥ / EGP …)

### Settings
- Theme (Blue / Neutral / Violet / Teal — subtle tint over glass)
- Show timer in menubar toggle
- Launch at login (autostart plugin)
- Notifications toggle (break end, session complete, goal hit, rank up, idle pause)
- Auto-pause idle threshold (5 / 10 / 15 min)
- Currency symbol
- Export Earnings CSV / Sessions CSV
- Sync info (iCloud Drive)

### UX polish
- Liquid-glass vibrancy (`HudWindow` NSVisualEffectView)
- Menubar timer ticks via Rust thread (works even when popover is hidden)
- ⌘⌥T / ⌘⌥D global shortcut
- Auto-hide popover on focus lost
- Real rank icon in modal header, all ranks grid with current highlighted
- Streak info tooltip + dedicated modal section

## Ladder tab (placeholder — needs Supabase)

UI shell with Friends / Global sub-tabs and a "Sign in to compete" card. Nothing functional yet.

## Pending / agreed but not built

1. **Supabase leaderboard** — needs the user to create a free Supabase project and hand me the URL + anon key. Then I wire:
   - Auth (magic link email)
   - `profiles` table (display_name, friend_code)
   - `stats` table (tier, division, lp, streak, is_working, current_project)
   - `friendships` table
   - Real-time subscription to friends' stats
   - Global leaderboard (opt-in)
   - Live "▶ working on X · 1h22" indicator
2. **GitHub repo + releases** — publish code, auto-build with GH Actions, auto-updater (Tauri updater plugin).
3. **Windows + Linux port** — branch the macOS-only code (vibrancy, iCloud path, activation policy), test on both OSes.
4. **Light theme / auto-match system appearance**.
5. **Achievements / badges** — optional gamification beyond LP.

## Data model (JSON blob)

```ts
{
  version: 1,
  projects: Project[],          // global, persistent
  days: Record<dateKey, DayData>,
  settings: Settings,
  currentTimer: { projectId, startedAtMs } | null,
  earnings: Earning[],
  monthlyGoals: Record<monthKey, centsGoal>,
  seasons: Record<year, SeasonSnapshot>,
  updatedMs, updatedBy (device id)
}

DayData = {
  date,
  goalHours: number,             // LOCKED once set
  allocations: { projectId, hours }[],
  sessions: Session[],
  carryOverHours: number         // always 0, retained for back-compat
}
```

## Known quirks

- Unsigned app — first launch shows macOS "unverified developer" warning. Right-click → Open once.
- iCloud sync is 5-second polling; concurrent edits on two Macs can conflict (last-write-wins).
- Challenger rank icon uses an iridescent palette but visually similar to Master/Diamond — could benefit from a distinct shape.

## Next-session starting points

- If user wants Supabase wired: ask them to create a project at supabase.com (2 min) and share URL + anon key. Then scaffold auth + stats sync.
- If user wants to publish: set up GitHub repo, write `.github/workflows/release.yml` for `macos-latest`, add Tauri updater plugin.
- If user wants light theme: add a theme toggle in Settings that flips CSS variables + vibrancy material.
