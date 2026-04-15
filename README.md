# Forge

A macOS menubar hour-tracker with a ranked ladder. Track your daily work goal, earn FP (Forge Points) for hours worked, climb 11 ranks (Wood → Challenger), compete with friends on a live leaderboard.

## Features

- Count-up timer with per-project tracking
- **Locked daily goal** (4–24h) — set at the start of the day, can't be lowered to cheat
- **Rank system** — 11 tiers with 3 divisions each (Wood III → Master I, then GM, then unlimited Challenger)
- **FP math** — +6 FP/hour worked, +8 FP/hour overtime (past 10h if goal > 10h), −3 FP/hour missed (past days only)
- **Streaks** with 3-day grace, 2 shields (earned at 7 and 60 days, regen every 60 after 180), and graceful 50% decay
- **LP decay at GM+** — top ranks lose FP for extended inactivity
- **Break timer** with duration picker (5/10/15/20 min)
- **Idle detection** — 10 min warning, 13 min auto-pause with time trimmed
- **iCloud Drive sync** across your own Macs
- **Live ladder** powered by Supabase — see friends grind in real time
- Liquid-glass UI with blue/neutral/violet/teal themes

## Build

```bash
# Public build (no Money tab)
npm run tauri build

# Personal build (owner's build with Money tab, currency, CSV export)
VITE_PERSONAL=true npm run tauri build
```

## Setup

1. Install [Rust](https://www.rust-lang.org/tools/install) and [Node.js](https://nodejs.org).
2. Clone, `npm install`, set up Supabase (see [`SUPABASE_SETUP.md`](./SUPABASE_SETUP.md)), copy `.env.example` → `.env.local` with your keys.
3. `npm run tauri dev` for local development.
4. `npm run tauri build` to produce a `.dmg`.

## License

All rights reserved. Not open source.
