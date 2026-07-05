# QA Scenarios — pattern-settings-ux-and-remote-cleanup

Non-automatable UI scenarios (no Playwright runtime available — see plan's QA Sweep header).
Walk these manually in a real Obsidian vault with the built plugin installed.

## Manual checklist

- [ ] **H1** Open Settings → GitHub Sync → type into the last (blank) row of Sync Exclusions. Confirm the input keeps focus and no new row appears until you click "+ Add pattern".
- [ ] **H2** Click "+ Add pattern" under Sync Exclusions. Confirm exactly one new blank row appears below the others.
- [ ] **H3** Click "+ Add pattern" under Sync Inclusions. Confirm it only affects the Inclusions list, not Exclusions.
- [ ] **H4** Add an exclude pattern matching a file already synced to GitHub (e.g. `**/main.js` with a previously-synced `.obsidian/plugins/foo/main.js`). Click Sync. Confirm the file disappears from the GitHub repo after the sync completes.
- [ ] **H5** Click "Preview pattern matches". Confirm a modal opens listing "Will sync" and "Excluded by pattern" with your vault's real files bucketed correctly.
- [ ] **E1** Delete every row in Sync Exclusions one by one. Confirm the list ends empty and "+ Add pattern" is still present and clickable.
- [ ] **E2** Click "Preview pattern matches" on a vault with `syncConfigDir` OFF (the default). **Known gap (see plan's Critique table, finding #1):** `.obsidian/*` files will show under "Will sync" even though they are never actually synced while the toggle is off — expected to fail until that finding is fixed.
- [ ] **N1** Click "+ Add pattern" rapidly multiple times in a row. Confirm each click adds exactly one row (no double-adds, no skipped renders).

## Config sanity check (ties to the original bug report)

Your original config used `includePatterns: [".obsidian/plugins/gitless", ...]` (no trailing slash). Verified via direct script execution against the real matcher (`npx tsx`, see plan's QA Sweep → Run Results):

- `.obsidian/plugins/gitless/main.js` → **still excluded** under that exact pattern (no trailing slash = literal path match only, not a directory prefix).
- Changing it to `.obsidian/plugins/gitless/` (trailing slash) makes `.obsidian/plugins/gitless/main.js` and `.obsidian/plugins/gitless/data.json` both sync correctly, while `.obsidian/plugins/other/main.js` stays excluded.

**Recommendation: update your `includePatterns` entry to `.obsidian/plugins/gitless/` before syncing** — otherwise, once this plan ships, the next sync will delete your own gitless plugin's files from GitHub (item 2's new behavior acting on your current, unintentionally-narrow include pattern).
