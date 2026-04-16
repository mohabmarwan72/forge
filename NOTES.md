# Forge — Project State

*Last saved: 2026-04-16*

A menubar hour-tracker with a ranked ladder. Compete with friends on LP, streaks, hours. Liquid-glass UI, Supabase-powered real-time leaderboard, iCloud sync between your own Macs.

## This folder IS the project

`/Users/mohabmarwan/Documents/forge-public` — the canonical Forge codebase. Live on GitHub at **https://github.com/mohabmarwan72/forge** (private repo, owner: `mohabmarwan72`).

The old `hour-tracker` and `hour-tracker-dev` folders are deprecated — kept only as historical snapshots. Don't edit them.

## Build variants from the same source

| Build | Command | What it's for |
|------|---------|---------------|
| **Personal** (Mohab's) | `VITE_PERSONAL=true npm run tauri build` | Has Money tab, currency setting, CSV export. For the owner. |
| **Public** (friends) | `npm run tauri build` | Money tab hidden. For anyone else. |

Both builds share:
- Same Supabase project → same ladder
- Bundle ID `com.mohab.forge`
- Product name "Forge"
- iCloud folder `Forge/` on macOS, `Documents/Forge/` on Windows + Linux
- Shortcut `⌘⌥F` (Ctrl+Alt+F on Win/Linux)

## Installed right now

- `/Applications/Forge.app` → personal build v0.2.3 (Mohab's daily app)
- `Desktop/Forge_Personal_0.2.3.dmg` → for sending to his second Mac
- `/Applications/Hour Tracker.app` → old, can be deleted
- `/Applications/Forge Dev.app` → old dev, can be deleted

## How releases work (GitHub Actions)

Every time a tag like `v0.2.4` is pushed to GitHub:

1. **macOS** runner → builds `.dmg`
2. **Windows** runner → builds `.msi` + `.exe-setup`
3. **Linux (Ubuntu 22.04)** runner → builds `.AppImage` + `.deb`
4. All attached to a GitHub Release at `releases/tag/v0.2.4`.

**One command from Mohab to ship a new version:**
```bash
# bump version in src-tauri/tauri.conf.json, package.json, src-tauri/Cargo.toml
git add -A && git commit -m "bump to v0.2.4"
git tag v0.2.4 && git push --tags
```

~15 min later the release is live.

**Repo secrets** already set: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Don't need to touch again.

## Current shipped version: v0.2.3

Latest confirmed:
- macOS ✅ (auto-built, on releases page for v0.2.2; v0.2.3 is the latest)
- Windows ✅ (auto-built)
- Linux ✅ (auto-built in v0.2.3 after libxss-dev fix)
- Personal DMG ✅ (on Mohab's Desktop)

## Supabase

- Project: `qmaxsioyostzihksusef` at supabase.com
- Keys in `.env.local` (gitignored; also set as GitHub repo secrets)
- Schema: see `SUPABASE_SETUP.md`. Tables: `profiles`, `stats`, `friendships`. RLS enabled.
- "Confirm email" for signups is **OFF** (OTP flow handles verification)
- Magic Link email template customized to show OTP code (no link)

## Key features shipped

- Count-up timer with per-project tracking
- Locked daily goal (4–24h, can't be lowered)
- Ranks: 11 tiers × 3 divisions for Wood–Master; GM is single 500-FP window; Challenger unlimited
- FP math: +6/hr (first 10), +8/hr overtime (if goal > 10), −3/hr penalty on past missed days, clamped at [4, 10] hour window
- Streaks: 3-day grace + 2 earnable shields (#1 at 7 days, #2 at 60, regen every 60 after 180) + graceful 50% decay
- FP decay at GM+ only: −10/day while streak is in decay
- Break timer with duration picker (5/10/15/20)
- Breaks row in summary (live-ticking)
- Idle detection: 10-min notification warning, 13-min auto-pause with trimmed time
- Midnight rollover: splits active session at 00:00, counter continues
- Money tab (personal only) — monthly goal + earnings + ranges (this month / last / quarter / year / all) + CSV export
- iCloud Drive sync across Macs (`Forge/data.json`); Documents/Forge on Win/Linux
- Supabase ladder: Friends tab (with friend code + add/accept/reject), Global top 50, realtime friend activity (`▶ working on X · 1h 22m`), "+ Add" on global rows
- Themes: Blue / Neutral / Violet / Teal (as dropdown with color emojis)
- Custom rank icons (SVG, all 11 tiers)
- Custom "F" forged-metal app icon (in Dock + Finder)
- Clean monochrome F menubar icon (template-mode, adapts to light/dark menubar)
- Global shortcut `⌘⌥F` to toggle popover
- Auto-hide popover on focus lost
- Menubar timer driven by Rust thread (keeps counting when popover is hidden)
- Account card with editable display name + copyable friend code + red Sign out button
- Cross-platform: macOS-only deps (window-vibrancy) isolated via `#[target.'cfg(target_os = "macos")']`

## Pending / open items for the next session

1. **Auto-updater** — add Tauri's updater plugin so installed users get "Update available" prompts automatically. Uses Tauri's own signing key (no Apple fee). ~1 hour.
2. **Apple Developer signing** ($99/year, whenever Mohab's ready). Kills all "unverified developer" / "damaged" warnings on Macs. Plugs into the existing GH Actions workflow with a signing cert + notarytool. ~30 min once certs are set up.
3. **Money on the ladder?** Unresolved design question. Currently Money is local-only and private. Mohab was asking if he wants friends to see money stats on the ladder. Options A–D were discussed — no decision made yet.
4. **Monetization model** — freemium with a Pro tier (Money + CSV + themes + ladder cosmetics) for $4–8/month, or one-time $20–30. Not urgent; ship to friends first, observe demand.
5. **Data migration from ForgeDev folder** — if ever Mohab wants to pull projects/sessions from the old `ForgeDev/` iCloud folder into the new `Forge/` folder. One-shot script.
6. **Node 20 → 24 deprecation** — GitHub Actions warning. Not urgent until Sept 2026.

## Gotchas / things to remember

- `.env.local` is gitignored. Don't accidentally commit Supabase keys (even though they're "publishable" = client-safe).
- When bumping versions, update **all three** spots: `tauri.conf.json`, `package.json`, `src-tauri/Cargo.toml`.
- Tag-pushing triggers GH Actions. Don't push a tag without bumping the version first or you'll get a duplicate release error.
- `window-vibrancy` is in `[target.'cfg(target_os = "macos")'.dependencies]` — NOT in the main `[dependencies]`. Don't move it or Windows/Linux builds break.
- Sometimes the Mac DMG bundling step fails locally with a file-lock error — the `.app` is fine, just can't package to `.dmg`. Rerun the build if needed.

## GitHub auth

Mohab's `gh` CLI is authenticated as `mohabmarwan72` with `workflow` scope. No need to re-login.

## Fastest way to resume work

In a future Claude session, just say: *"Forge — let's do X"*. Claude should:
1. Read `NOTES.md` here and memory entry for Forge.
2. `cd /Users/mohabmarwan/Documents/forge-public`
3. Work directly in this project. Don't touch `hour-tracker` or `hour-tracker-dev` folders.
