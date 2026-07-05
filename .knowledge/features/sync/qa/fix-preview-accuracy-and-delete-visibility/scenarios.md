# QA Scenarios — fix-preview-accuracy-and-delete-visibility

Non-automatable UI scenarios (no Playwright runtime available — same constraint as the
prior plan's QA sweep: Obsidian is a native Electron app, Playwright not installed,
no network to install it here).

## Manual checklist

- [ ] **H1** Set `syncConfigDir` off (default). Click "Preview pattern matches". Confirm `.obsidian/*` files now show under "Excluded by pattern", not "Will sync".
- [ ] **H2** Set `syncConfigDir` on. Click Preview again. Confirm the same `.obsidian/*` files now show under "Will sync" (assuming no exclude pattern also matches them).
- [ ] **H3** Run a regular sync that excludes zero previously-synced files. Confirm the Notice reads exactly "Sync successful" (no count suffix).
- [ ] **H4** Run a regular sync that excludes N previously-synced files (matches an exclude pattern with remote presence). Confirm the Notice reads "Sync successful (N removed from remote due to exclude patterns)".
- [ ] **E1** With `syncConfigDir` on, add a hidden/dot-prefixed file under `.obsidian/` (e.g. a plugin's `.cache` file). Click Preview. Confirm it shows under "Excluded by pattern", not "Will sync".

## Known gap found during this QA pass (not fixed by this plan — see Critique)

**Turning `syncConfigDir` OFF has the same "orphaned on remote forever" gap that exclude patterns used to have before the previous plan's fix.** `removeConfigDirFromMetadata()` (called from the `syncConfigDir` toggle's `onChange`, `tab.ts:343`) only forgets local tracking — same non-destructive contract as the old (pre-fix) `removeExcludedFromMetadata()`. But `computeExcludedRemoteOrphans()` (the mechanism that actually deletes orphans from GitHub on the next sync) filters using `shouldSkipFile()` only, which has zero reference to `syncConfigDir` (verified: grep for `syncConfigDir` inside `shouldSkipFile()`'s body returns nothing). So a config-dir file synced while the toggle was on, then orphaned by switching it off, is never caught by the delete-on-exclude mechanism and stays on GitHub indefinitely — the exact bug this whole effort exists to fix, reached via a different door.

- [ ] **Confirm live:** sync with `syncConfigDir` on and some `.obsidian/plugins/*` files synced. Turn `syncConfigDir` off. Run another sync. Confirm (expected to fail, per the finding above) those files are NOT removed from GitHub.
