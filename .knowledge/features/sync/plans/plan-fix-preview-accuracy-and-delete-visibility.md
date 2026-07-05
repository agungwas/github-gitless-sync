---
status: done
completed: "2026-07-05"
slug: fix-preview-accuracy-and-delete-visibility
created: "2026-07-05"
testing: tdd
qa: done
qa_completed: "2026-07-05"
follow_up: pending
---
# Plan: Fix Preview Accuracy (syncConfigDir) + Surface Remote-Delete Count

Follow-up to `plan-pattern-settings-ux-and-remote-cleanup.md`'s QA sweep (`act-on-critique`, 2026-07-05): fixes the 1 major finding (Preview button misreports `.obsidian/*` files as "will sync" when `syncConfigDir` is off) and mitigates the 1 blocker finding (delete-on-exclude has no visible confirmation beyond a generic debug-log line) with a proportionate fix, per Gate G's reframe (git-history-recoverable, not permanent loss; already logged today).

## Approach

**Rough change (UI/system):**
1. System: "Preview pattern matches" now correctly buckets `.obsidian/*` files as excluded when `syncConfigDir` is off, instead of wrongly showing them as "will sync."
2. UI: the "Sync successful" notice after a regular sync now says `"Sync successful (N removed from remote due to exclude patterns)"` when any files were deleted from GitHub because they now match an exclude pattern.

### Fix #1 — Preview accuracy

**Chosen: Option A — new `isPathSyncable()` method on `SyncManager`.** Add a public method that layers the two checks `shouldSkipFile()` doesn't cover (`syncConfigDir` gating, dot-file skip inside configDir) on top of it, mirroring the exact logic already at `determineSyncActions()`'s tail filter (`sync-manager.ts:1201-1214`) and `reconcileConfigDirFiles()`'s dot-file skip (`sync-manager.ts:759`). `showPatternPreview()` calls this instead of `shouldSkipFile()` alone.

Rejected:
- **Option B — inline the checks in `tab.ts`.** Duplicates logic already scattered across 3 `sync-manager.ts` call sites; a future change to `syncConfigDir` gating would need updating in 2 places instead of 1.
- **Option C — fix `syncConfigDir` only, skip the dot-file gap.** Leaves a known, smaller accuracy gap unfixed for no real savings — the dot-file check is one extra line once `isPathSyncable()` exists anyway.

### Fix #2 — remote-delete visibility

**Chosen: Option A — post-sync Notice with a count.** `syncImpl()` returns the number of `computeExcludedRemoteOrphans()` actions it applied; `sync()` appends `" (N removed from remote due to exclude patterns)"` to the existing "Sync successful" Notice text when `N > 0`.

Rejected:
- **Option B — clearer log line only, no Notice change.** Cheaper, but still requires opening "Copy logs" to discover — doesn't materially improve on today's already-logged (if generic) trace, which is exactly what Gate G's reframe said isn't worth over-investing beyond a proportionate fix.
- **Option C — pre-sync confirmation modal (mirrors "ask" conflict handling).** Most visible, but disproportionate to a risk that Gate G established is git-history-recoverable, not permanent — would add a new blocking UI flow for every exclude-driven cleanup, which could get old fast for users who prune patterns routinely. Bigger scope than this follow-up warrants.

## Goal Pressure-Test Note (from Gate G)

The blocker finding from QA was framed as data-loss risk; on reflection (surfaced to and accepted by the human at Gate G) it's less severe than framed — GitHub tree deletions remain recoverable via git history/reflog, and the deletion already flows through the existing `logger.info("Actions to sync", actions)` line today, so it isn't fully silent. The human chose the full `goal-ok` (both fixes) over the cheaper "major only, skip blocker" framing offered at Gate G.

## `src/sync-manager.ts` — `isPathSyncable()` + `syncImpl()` Return Value

1. Add a new public method near `shouldSkipFile()`:
   ```ts
   /**
    * Whether filePath is actually synced under current settings -- shouldSkipFile()
    * plus the syncConfigDir gate and the configDir dot-file skip that live
    * separately in determineSyncActions() (sync-manager.ts:1209) and
    * reconcileConfigDirFiles() (sync-manager.ts:759). Single choke point for
    * "will this file really sync", used by the settings-tab preview.
    */
   isPathSyncable(filePath: string): boolean {
     if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
       return true;
     }
     if (this.shouldSkipFile(filePath)) {
       return false;
     }
     if (!this.settings.syncConfigDir && filePath.startsWith(this.vault.configDir)) {
       return false;
     }
     if (
       filePath.startsWith(`${this.vault.configDir}/`) &&
       filePath.split("/").last()?.startsWith(".")
     ) {
       return false;
     }
     return true;
   }
   ```
2. Change `private async syncImpl()` to `private async syncImpl(): Promise<number>`, returning the count of orphan-delete actions applied this run:
   - At the existing early return (`sync-manager.ts` — "Nothing to sync" branch, currently bare `return;`), change to `return 0;`.
   - At the end of the method (after `await this.commitSync(newTreeFiles, treeSha, conflictResolutions);`), add `return excludedRemoteOrphans.length;` — reusing the `excludedRemoteOrphans` array already computed earlier in the method (currently inlined as `...this.computeExcludedRemoteOrphans(files)` in the `actions` array construction; pull it into a named `const excludedRemoteOrphans = this.computeExcludedRemoteOrphans(files);` above the `actions` array so both the spread and the final count can reference it).
3. In `async sync()` (`sync-manager.ts:446`), capture `syncImpl()`'s return value and extend the success Notice text:
   ```ts
   const removedFromRemoteCount = await this.syncImpl();
   await this.logger.info("Sync successful");
   const successMessage = removedFromRemoteCount > 0
     ? `Sync successful (${removedFromRemoteCount} removed from remote due to exclude patterns)`
     : "Sync successful";
   new Notice(successMessage, 5000);
   ```

## `src/settings/tab.ts` — Use `isPathSyncable()` in the Preview

4. In `showPatternPreview()`, replace `this.plugin.syncManager.shouldSkipFile(path)` with `this.plugin.syncManager.isPathSyncable(path)`.
5. Rename `bucketPathsByPattern()`'s second parameter from `shouldSkipFile: (path: string) => boolean` to `isPathSyncable: (path: string) => boolean` and flip the branch polarity to match (`if (isPathSyncable(path)) { willSync.push(path); } else { excluded.push(path); }`) — same outward behavior, correct predicate name/polarity now that it's driven by "is this synced" rather than "is this skipped".

## Open Questions

- [ ] None — both fixes are fully specified above; Gate G already resolved the scope question (both fixes, proportionate Notice-only mitigation for the blocker).

## Test Scenarios

1. `isPathSyncable()`: manifest path returns `true` regardless of `syncConfigDir` value (even `false`).
2. `isPathSyncable()`: a configDir file (e.g. `.obsidian/plugins/foo/main.js`) with `syncConfigDir: false` returns `false`.
3. `isPathSyncable()`: same configDir file with `syncConfigDir: true` and a non-dot-prefixed basename returns `true` (assuming no exclude pattern matches).
4. `isPathSyncable()`: a configDir file with `syncConfigDir: true` but a dot-prefixed basename (e.g. `.obsidian/plugins/foo/.hidden`) returns `false`.
5. `isPathSyncable()`: a non-configDir file (e.g. `notes/todo.md`) is unaffected by `syncConfigDir` — governed by `shouldSkipFile()` only.
6. `isPathSyncable()`: a path already excluded via `excludePatterns`/`includePatterns` returns `false` regardless of `syncConfigDir`.
7. `bucketPathsByPattern()` (renamed parameter/polarity): given an `isPathSyncable`-shaped predicate, paths where it returns `true` land in `willSync`, `false` in `excluded` — same external behavior as before, verifies the rename didn't invert the bucketing.
8. `showPatternPreview()`: calls `this.plugin.syncManager.isPathSyncable`, not `shouldSkipFile` — spy on both, assert only `isPathSyncable` was invoked.
9. `sync()`: given `syncImpl()` resolves to `0`, the Notice text is exactly `"Sync successful"` (unchanged from today).
10. `sync()`: given `syncImpl()` resolves to `3`, the Notice text is `"Sync successful (3 removed from remote due to exclude patterns)"`.

`syncImpl()`'s own end-to-end wiring (that it actually returns `excludedRemoteOrphans.length` in the real orchestration, not just that `computeExcludedRemoteOrphans()` computes the right count in isolation) is verified by typecheck + code inspection only, matching this codebase's established boundary of not testing `syncImpl()` end-to-end (see `plan-pattern-settings-ux-and-remote-cleanup.md`'s `testing_gaps` for the same boundary applied to the switch-case consuming these actions).

## Edge Cases

| Case | Expected Behavior | Update feature doc? |
|---|---|---|
| `syncConfigDir` toggled on/off between Preview clicks | Preview reflects current toggle state each time it's clicked (no caching) | yes |
| Preview clicked with `syncConfigDir: true` and a dot-prefixed file under configDir | File shown as excluded (dot-file skip), matching what `reconcileConfigDirFiles()` would actually do | yes |
| Manifest file present during Preview | Always bucketed as "will sync", regardless of `syncConfigDir` or any exclude pattern | yes |
| Sync run with zero orphan-deletes | Notice text unchanged: plain `"Sync successful"` | yes |
| Sync run with N orphan-deletes | Notice text: `"Sync successful (N removed from remote due to exclude patterns)"` | yes |
| First sync (`firstSync()`/`firstSyncImpl()`) | Unaffected — `computeExcludedRemoteOrphans()`/the count only exist in `syncImpl()` (regular sync), never in the first-sync path | no |

## Deviations

Baseline: clean (111 tests passing, 10 test files) — `npm run test -- --run`, captured 2026-07-05 before any implementation.

Final run: 120/120 passing (10 test files) — `npm run test -- --run`. `npx tsc -noEmit -skipLibCheck` clean. `npm run build` (production esbuild) succeeds.

| What changed | Why | Update feature doc? |
|---|---|---|
| Edited the 2 pre-existing `bucketPathsByPattern` tests in `tab.test.ts` (predicate polarity + name) instead of adding new ones alongside | Plan step 5 explicitly supersedes the old `shouldSkipFile`-shaped contract with the `isPathSyncable`-shaped one — same function, inverted meaning of `true`. Citing step 5 per the "only edit a test when the plan step explicitly names the behavior it supersedes" rule. | no |

## Impact / Affected Areas

- `src/sync-manager.ts` — new public `isPathSyncable()` method; `syncImpl()` signature change (`Promise<void>` → `Promise<number>`); `sync()`'s success-Notice text becomes conditional.
- `src/settings/tab.ts` — `showPatternPreview()` now calls `isPathSyncable()`; `bucketPathsByPattern()`'s parameter renamed.
- `src/sync-manager.test.ts` — new tests for `isPathSyncable()`, updated `sync()` Notice-text tests.
- `src/settings/tab.test.ts` — updated `bucketPathsByPattern` tests (renamed param), new test asserting `showPatternPreview()` calls `isPathSyncable`.
- `.knowledge/features/sync/README.md` — update once shipped: the "Settings UI mechanics" / Preview description currently says it uses `shouldSkipFile()` alone; needs correcting to `isPathSyncable()`. Also worth adding `isPathSyncable()` to the "File Filtering" choke-point table alongside `shouldSkipFile()`.

## QA Sweep

### Header

Runtime: FE detected (`react` in `package.json`) → nominally Playwright, but **skipped-no-runtime** (same reason as the prior plan's QA sweep: Obsidian Desktop is a native Electron app, Playwright not installed, no network to install it here). Manual checklist written instead: `.knowledge/features/sync/qa/fix-preview-accuracy-and-delete-visibility/scenarios.md`. All logic-level behavior (the actual bug fixes) is covered by real unit tests, re-run below.

Critique mode: single-sweep (files: 4, lines: 148, threshold: 10 files / 500 lines)

Scenarios: happy 4 (H1-H4) / edge 1 (E1) / negative 0

Critique: blocker 0 / major 1 / minor 0 / nit 0

Pipeline order: pre-iris-4 (plan `status: in-progress`, feature doc not yet synced — finding flows into iris-4)

### Taxonomy N/A

| Entry | Reason | Confirm? |
|---|---|---|
| max | Unrelated to this plan's changes (pattern-length cap untouched) | auto-confirmed |
| network-fail | No new network call — `isPathSyncable()` and the Notice-text change are both local/synchronous | auto-confirmed |
| auth-fail | No new auth surface | auto-confirmed |
| permission | No new filesystem surface beyond what `isPathSyncable()` reads from already-loaded settings | auto-confirmed |
| i18n | No i18n system in this codebase; new string is plain English | auto-confirmed |
| slow-network | No new network call | auto-confirmed |
| a11y | No new interactive UI element — only a Notice string and a Preview bucketing change, no new buttons/controls | auto-confirmed |
| concurrent | `isPathSyncable()` is synchronous over already-loaded settings; `computeExcludedRemoteOrphans()` untouched by this plan | auto-confirmed |

### Scenario Matrix

| # | Family | Scenario | Source | Expected | Status |
|---|---|---|---|---|---|
| H1 | happy | Preview with `syncConfigDir=false`, configDir file present | plan Approach Fix #1, Critique finding (prior plan) | file bucketed as excluded | automated — `sync-manager.test.ts` "returns false for a configDir file when syncConfigDir is false" |
| H2 | happy | Preview with `syncConfigDir=true`, non-dot configDir file | plan Test Scenario 3 | file bucketed as will-sync | automated — `sync-manager.test.ts` "returns true for a non-dot-prefixed configDir file..." |
| H3 | happy | sync() with 0 orphan-deletes | plan Test Scenario 9 | plain "Sync successful" | automated — `sync-manager.test.ts` "shows the plain 'Sync successful' Notice..." |
| H4 | happy | sync() with N orphan-deletes | plan Test Scenario 10 | "Sync successful (N removed from remote due to exclude patterns)" | automated — `sync-manager.test.ts` "appends the removed-from-remote count..." |
| E1 | edge (boundary) | configDir file with dot-prefixed basename, `syncConfigDir=true` | plan Test Scenario 4, Edge Case row 2 | bucketed as excluded | automated — `sync-manager.test.ts` "returns false for a dot-prefixed configDir file..." |

### Coverage Gaps

- Edge Case "First sync unaffected" (plan's own table, marked `Update feature doc? no`) not independently tested — reasoned correct by code inspection (`computeExcludedRemoteOrphans`/count only exist in `syncImpl()`, never called from `firstSyncImpl()`), consistent with the plan's own risk assessment.
- "syncConfigDir toggled between Preview clicks, no caching" (Edge Case row 1) not tested live — reasoned from code (no cache field on the tab instance), same class of gap as the previous plan's E1.

### Critique

| Severity | Angle | File:line | Finding | Suggested fix |
|---|---|---|---|---|
| major | correctness / plan-conformance (of the *prior* plan, surfaced by this one) | `src/sync-manager.ts:742` (`computeExcludedRemoteOrphans`) vs `src/sync-manager.ts:698` (`isPathSyncable`, this plan) | `computeExcludedRemoteOrphans()` still filters via `shouldSkipFile()` only (unchanged, not touched by this plan) — verified `shouldSkipFile()`'s body has zero reference to `syncConfigDir`. Turning `syncConfigDir` **off** (via the toggle at `tab.ts:343`, which calls `removeConfigDirFromMetadata()` — a local-only forget, same non-destructive contract as the old pre-fix `removeExcludedFromMetadata()`) orphans previously-synced configDir files on GitHub exactly like exclude patterns used to, before the prior plan's fix. This plan's own new `isPathSyncable()` makes the inconsistency visible: the Preview button (now accurate) will correctly show these files as "excluded", while a regular sync will never actually delete them from remote, because `computeExcludedRemoteOrphans()` wasn't widened to match. | Swap `computeExcludedRemoteOrphans()`'s filter from `this.shouldSkipFile(filePath)` to `!this.isPathSyncable(filePath)` (inverted, since `isPathSyncable` returns `true` for "will sync" — opposite polarity) so both the Preview and the actual remote-cleanup mechanism agree on one definition of "syncable." |

**Plan-conformance (this plan, main-thread pass):** All 5 implementation steps match the diff exactly — `isPathSyncable()` code is byte-for-byte the plan's snippet, `syncImpl()` return-value wiring matches, Notice text matches, `bucketPathsByPattern` rename+polarity matches. The one deviation (editing 2 pre-existing tests, citing step 5) is already logged in `## Deviations`. The major finding above is about a gap in the *prior* plan's scope that this plan's own new code makes newly visible — not a deviation from this plan's own stated steps.

### Run Results

Command: `npm run test -- --run`
Run at: 2026-07-05
Result: 10 test files passed, 120 tests passed, 0 failed (matches the build's own Final run note).

Command: `npx tsc -noEmit -skipLibCheck && npm run build`
Run at: 2026-07-05
Result: clean typecheck, production build succeeds.
