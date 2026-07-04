# QA Scenarios — plan-exclude-patterns

Runtime: CLI/API-equivalent (Node/vitest), see QA Sweep header for FE-detection override rationale.

## Automated (via vitest — command + result below)

Command: `npm run test -- --run`
Run at: 2026-07-04
Result: 95/95 passing (10 test files), 0 failures.

Every H/E/N scenario below marked "automated" is covered by an existing test in the diff
(see plan `## Test Scenarios` for the exact assertions); this run is the evidence.

## Manual-only (requires real Obsidian desktop runtime — cannot be automated here)

Walk these by hand inside an actual Obsidian vault with the plugin loaded:

- [ ] M1: Open Settings → Sync. Confirm two new sections "Sync exclusions" / "Sync inclusions" render, each with exactly one empty input row.
- [ ] M2: Type `**/main.js` into the Sync Exclusions row. Confirm a new blank row appears below it, and the row you just typed into does NOT show a delete button materializing while you type (it should already be a non-last row once the new blank appears).
- [ ] M3: Click the delete (trash) button on a non-last pattern row. Confirm exactly that row disappears and no other row's text is affected.
- [ ] M4: With a vault containing a note under a folder matching an exclude pattern (e.g. `.obsidian/plugins/foo/main.js`), add that pattern, then run a manual sync. Confirm the file is no longer uploaded/downloaded and disappears from tracked metadata, but the physical file on disk is untouched.
- [ ] M5: Add an include pattern that overrides the above exclude (e.g. `gitless/**/main.js` when the exclude is `**/main.js`, for a file actually under `gitless/`). Confirm that file DOES sync.
- [ ] M6: With a large vault (1000+ tracked files), type into an exclude pattern row and observe whether there is any noticeable UI lag/jank per keystroke (relates to perf critique finding on `removeExcludedFromMetadata` running on every keystroke).
- [ ] M7: Trigger a sync, and while it is in-flight, edit an exclude pattern in settings. Observe whether anything breaks/races (relates to perf critique concurrency finding).
