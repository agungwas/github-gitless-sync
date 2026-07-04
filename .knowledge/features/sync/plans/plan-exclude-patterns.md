---
status: done
completed: "2026-07-04"
slug: exclude-patterns
created: "2026-07-04"
testing: tdd
testing_gaps:
  - "Step 8 (src/settings/tab.ts UI): no Setting/TextComponent/Modal mock exists in vitest.setup.ts and no prior tab.ts test file exists in this codebase. Building a full chainable Obsidian Setting-builder mock is disproportionate scope for one UI wiring step. Implemented directly, verified via typecheck/build + read-through against plan step 8 + Test Scenario 11, not per-task TDD."
qa: done
qa_completed: "2026-07-04"
follow_up: "done — see plan-fix-exclude-patterns-qa-findings.md"
---
# Plan: Exclude Files/Folders From Sync by Pattern

## Approach

**Rough change (UI/system):** UI: adds two separate lists under Settings → Sync — "Sync Exclusions" (glob patterns to exclude, e.g. `**/main.js`) and "Sync Inclusions" (glob patterns that always override an exclusion, e.g. `gitless/**/main.js`). Each list auto-adds a new blank row when the last one is filled, and each row gets a delete button. **Updated 2026-07-04 per human request:** originally a single list with gitignore `!`-prefix negation; split into two lists instead — no order-dependence to explain, no "put the `!` row below the exclude" gotcha.

**Chosen: gitignore-style glob (`*`, `**`, trailing `/` = directory), matched through one centralized pure function reused at every existing filter call-site.**

Rejected alternatives (from Gate A):
- **Simple wildcard-only (`*` crosses `/`, no `**`)** — trivial to implement, but can't distinguish "this directory only" from "any depth," which is exactly the distinction needed to target `.obsidian/plugins/*/main.js` without also catching unrelated `main.js` files elsewhere. Rejected: too imprecise for the stated goal.
- **Raw JS regex per row** — zero glob-conversion code to write, but exposes raw regex syntax to a non-dev, note-taking audience (steepest learning curve of the three), and needs try/catch hardening so a malformed pattern can't crash sync. Rejected: wrong audience fit.
- Gitignore-style glob has direct precedent in this ecosystem (the Obsidian Git community plugin ships the same `.gitignore`-exclude feature), so users likely already know the syntax.

**Why centralize instead of touching 9 call-sites individually:** `iris-0a-explore` mapped 9 scattered filter checks in `sync/README.md` (`## File Filtering — All Check Points`) with no single choke point today (`isVolatileSyncArtifact` covers 5, `syncConfigDir` gating duplicated inline at 3, ZIP extraction re-implements its own checks). Bolting exclude-pattern checks onto all 9 individually would triple the maintenance surface. Centralizing into one pure matcher + one combined `shouldSkipFile()` helper touches the same 9 sites once, not twice, and leaves the codebase with a single choke point for all future "should this file sync" questions.

## Data Model

```ts
// src/settings/settings.ts
interface GitHubSyncSettings {
  // ...existing fields
  excludePatterns: string[];
  // gitignore-style glob patterns. A path matching ANY entry is excluded,
  // unless it also matches an includePatterns entry (include always wins).
  // May contain a trailing "" as the open input slot.
  includePatterns: string[];
  // gitignore-style glob patterns that force-override an exclusion.
  // Independent list from excludePatterns -- order between/within the two
  // lists does not matter, only "does any exclude match" and "does any
  // include match". May contain a trailing "" as the open input slot.
}

// DEFAULT_SETTINGS.excludePatterns = []
// DEFAULT_SETTINGS.includePatterns = []
```

**Two separate lists instead of `!`-prefix negation — revised 2026-07-04 per human request.** Original design used one ordered list with gitignore-style `!pattern` negation (last-match-wins). Human asked for exclude/include to be visually and structurally separate. New semantics: a path is excluded if any `excludePatterns` entry matches AND no `includePatterns` entry matches — include always wins, regardless of list order or which setting the user edited most recently. This is simpler than order-dependence (no "the negation row must come after the exclude row" gotcha to explain in the UI) and still has no git-style tree-pruning limitation, since the matcher evaluates the full file list per-pattern rather than walking/pruning a directory tree — a `main.js` under `gitless/` is re-included by `includePatterns` even if a directory-trailing-slash pattern in `excludePatterns` would otherwise catch its parent folder.

## New Module: `src/sync-filters.ts`

Pure functions, no class state — importable by both `SyncManager` and `EventsListener` without coupling them to each other.

```ts
export function globToRegExp(pattern: string): RegExp
// Gitignore-like glob semantics:
//   *   -> matches any run of chars EXCEPT "/"
//   **  -> matches any run of chars INCLUDING "/"
//   trailing "/" on the pattern -> matches the dir and everything under it
// All other regex-special chars in the literal segments are escaped.
// Anchored: matches the path as a whole (^...$), tested against the
// forward-slash-normalized relative vault path.

function matchesAny(filePath: string, patterns: string[]): boolean
// - Filters out blank/whitespace-only entries before matching (the trailing
//   "open input slot" row must never act as match-all).
// - Wraps each globToRegExp(...).test(filePath) in try/catch; a pattern that
//   fails to compile is skipped for that call (never throws, never aborts sync).
// - Returns true if any non-blank pattern matches. (internal helper, not exported)

export function isExcludedPath(
  filePath: string,
  excludePatterns: string[],
  includePatterns: string[],
): boolean
// - excluded = matchesAny(filePath, excludePatterns)
// - included = matchesAny(filePath, includePatterns)
// - Returns `excluded && !included` -- include always wins, independent of
//   list order or which list the user edited most recently.
```

## Implementation Steps

1. **`src/settings/settings.ts`** — add `excludePatterns: string[]` and `includePatterns: string[]` to `GitHubSyncSettings`, add both as `[]` to `DEFAULT_SETTINGS`.

2. **`src/sync-filters.ts`** (new file) — implement `globToRegExp()` and `isExcludedPath()` as specified above. Add unit tests covering the glob semantics in Test Scenarios below (this file gets full TDD treatment even in a no-test build, given it's pure logic with tricky edge cases).

3. **`src/events-listener.ts`** — in `isSyncable()` (line 177), add exclude-pattern check. It must sit AFTER the manifest/workspace/log checks (those take precedence — manifest is always syncable regardless of user patterns) and apply regardless of `syncConfigDir`, mirroring how the existing config-dir gate works today:
   ```ts
   private isSyncable(filePath: string) {
     if (filePath === manifest) return true;
     if (filePath === workspace.json || workspace-mobile.json) return false;
     if (filePath === log file) return false;
     if (isExcludedPath(filePath, this.settings.excludePatterns, this.settings.includePatterns)) return false;
     if (this.settings.syncConfigDir && filePath.startsWith(configDir)) return true;
     return true;
   }
   ```

4. **`src/sync-manager.ts`** — add a new private method next to `isVolatileSyncArtifact()`:
   ```ts
   private shouldSkipFile(filePath: string): boolean {
     return (
       this.isVolatileSyncArtifact(filePath) ||
       isExcludedPath(filePath, this.settings.excludePatterns, this.settings.includePatterns)
     );
   }
   ```
   Replace the 5 direct `isVolatileSyncArtifact(filePath)` call sites with `shouldSkipFile(filePath)`, EXCEPT keep the manifest-file special case unaffected in each (manifest never gets to these checks in the first place, or is checked/excepted explicitly before — verify at each site):
   - `filterRemoteMetadataFiles()` (~676)
   - `removeVolatileArtifactsFromLocalMetadata()` (~696)
   - `reconcileConfigDirFiles()` (~714, the `if (this.isVolatileSyncArtifact(filePath)) continue;` line)
   - `loadMetadata()` (~1434, the `if (this.isVolatileSyncArtifact(filePath)) return;` line)
   - `addConfigDirToMetadata()` (~1494, the `if (this.isVolatileSyncArtifact(filePath)) return;` line)

5. **`src/sync-manager.ts` — `determineSyncActions()`** (~1041-1169): the existing tail filter that drops config-dir actions when `syncConfigDir=false` (~1157-1166) must ALSO drop any action whose `filePath` matches `isExcludedPath()`, independent of `syncConfigDir`. Extend the filter predicate rather than adding a second `.filter()` pass:
   ```ts
   return actions.filter((action: SyncAction) => {
     if (isExcludedPath(action.filePath, this.settings.excludePatterns, this.settings.includePatterns)) return false;
     if (action.filePath === manifestPath) return true;
     return this.settings.syncConfigDir || !action.filePath.startsWith(this.vault.configDir);
   });
   ```
   This is the site that also protects already-tracked files that only just started matching a newly-added pattern (mid-session), since `determineSyncActions` runs every regular sync.

6. **`src/sync-manager.ts` — `firstSyncFromRemote()` ZIP extraction** (~222-260): add an exclude-pattern check alongside the existing hidden-file check (~255-260), before the file is written to disk:
   ```ts
   if (isExcludedPath(targetPath, this.settings.excludePatterns, this.settings.includePatterns)) {
     await this.logger.info("Skipping excluded file", targetPath);
     continue;
   }
   ```
   Place it after the manifest-exception config-dir check (~222-229) and before the write, so excluded files are never written to disk on first sync from remote either.

7. **`src/sync-manager.ts`** — add `removeExcludedFromMetadata()`, mirroring the existing `removeConfigDirFromMetadata()` pattern: walks `metadataStore.data.files`, deletes any entry whose key (or `localPath`) matches `isExcludedPath()` against the CURRENT `settings.excludePatterns` + `settings.includePatterns`, saves metadata if changed. Does NOT touch the physical file on disk (same non-destructive contract as `removeConfigDirFromMetadata`). Call this after ANY change to either list (exclude add, or include add/remove — an include removal can turn a previously-protected file back into an exclusion match).

8. **`src/settings/tab.ts`** — add two `Setting.setHeading()` blocks after the existing "Sync configs" toggle (~194): "Sync Exclusions" and "Sync Inclusions". Both render the identical dynamic-list UI, so extract one shared private helper, e.g. `renderPatternList(containerEl, patterns: string[], onChange: () => void)`, and call it twice (once per array) rather than duplicating the row logic:
   - One `Setting` row per entry in the array (ensure it always has at least one trailing `""` entry when rendering — append one in-memory if the last stored entry is non-blank).
   - Each row: a text input + a delete button (hidden/disabled on the trailing blank row, since there's nothing to delete).
     - Exclusions row placeholder: `"e.g. **/main.js"`.
     - Inclusions row placeholder: `"e.g. gitless/**/main.js"`.
   - `.setDesc()` on each heading: Exclusions — "Files matching these patterns are never synced." Inclusions — "Files matching these patterns are always synced, even if also matched by an exclusion above." Make the "include always wins" precedence explicit so users don't need to reason about list order.
   - Row `onChange(value)`: update `patterns[index] = value`; save settings; call `this.plugin.syncManager.removeExcludedFromMetadata()`; if this was the LAST row and `value.trim() !== ""`, push a new `""` and call `this.display()` to redraw (adds the next blank row). Do NOT call `this.display()` on every keystroke of non-last rows — only on row-count-changing transitions (new row appended, row deleted) — to avoid losing input focus while typing.
   - Delete button `onClick()`: splice the entry out of the array, save settings, call `removeExcludedFromMetadata()` (needed here too now — deleting an include-pattern row can turn a previously-protected file back into an exclusion match), call `this.display()` to redraw.

## Open Questions

- [x] **Pattern matching root:** patterns match against the vault-relative path (e.g. `.obsidian/plugins/foo/main.js`), same convention as `filePath` used everywhere else in `sync-manager.ts`/`events-listener.ts`. — CONFIRMED 2026-07-04 (`confirmed-both`).
- [x] **Re-inclusion when an exclude pattern is removed/edited (not the include list):** not auto re-added to metadata; next regular sync's existing local/remote diff logic re-adopts it naturally — no new method needed. — CONFIRMED 2026-07-04 (`confirmed-both`).

## Test Scenarios

1. `globToRegExp("**/main.js")` matches `.obsidian/plugins/foo/main.js` and `.obsidian/plugins/foo/bar/main.js`; does NOT match `mainjs.md` or `main.jsx`.
2. `globToRegExp(".obsidian/plugins/*/main.js")` matches `.obsidian/plugins/foo/main.js`; does NOT match `.obsidian/plugins/foo/bar/main.js` (single `*` does not cross `/`).
3. `globToRegExp(".obsidian/plugins/foo/")` (trailing slash) matches `.obsidian/plugins/foo/main.js` and any nested path under that dir.
4. `isExcludedPath()` ignores blank/whitespace-only entries in either array — an `excludePatterns` (or `includePatterns`) array like `["", "**/main.js", ""]` behaves identically to `["**/main.js"]`.
5. `isExcludedPath()` never throws on a pathological pattern string; a pattern that fails to compile is skipped, not fatal.
5a. `isExcludedPath("gitless/plugins/foo/main.js", ["**/main.js"], ["gitless/**/main.js"])` returns `false` (matches both lists — include wins).
5b. `isExcludedPath("other/plugins/foo/main.js", ["**/main.js"], ["gitless/**/main.js"])` returns `true` (only excludePatterns matches, includePatterns doesn't apply to this path).
5c. `isExcludedPath("gitless/plugins/foo/main.js", ["**/main.js"], [])` returns `true` with an empty includePatterns array (include list being empty never suppresses an exclude).
5d. A file-level include always wins even under a directory-trailing-slash exclude: `isExcludedPath("gitless/plugins/foo/main.js", [".obsidian/plugins/"], ["gitless/**/main.js"])` — wait, this specific case: exclude pattern doesn't even match this path (different dir), so result is `false` regardless; use a matching pair instead: `isExcludedPath("gitless/plugins/foo/main.js", ["gitless/"], ["gitless/**/main.js"])` returns `false` — include overrides a directory-level exclude on the same path, with no tree-pruning limitation (matcher checks the full file list per-pattern, not a directory walk that stops descending).
5e. List order/edit-recency doesn't matter: `isExcludedPath(p, exclude, include)` gives the same result regardless of which array element was added or edited most recently, or the position of matching entries within either array.
6. Manifest file (`{configDir}/github-sync-metadata.json`) is synced even if a user pattern would otherwise match it (e.g. pattern `**/*.json`) — precedence check in `isSyncable()` and `determineSyncActions()`.
7. `EventsListener.isSyncable()` returns `false` for a newly created file matching an exclude pattern — the file is never added to metadata on `create`.
8. `SyncManager.determineSyncActions()` drops an `upload`/`download` action for any file matching an exclude pattern, even when that file is already present in both local and remote metadata (pattern added after the file was already tracked).
9. `firstSyncFromRemote()` (ZIP extraction) never writes an excluded file to disk — verify via a mocked ZIP entry whose path matches a configured pattern.
10. `removeExcludedFromMetadata()` deletes matching entries from `metadataStore.data.files` without calling any vault delete/write API (no physical file touched).
11. Settings UI: typing a non-blank value into the last (previously blank) row appends exactly one new blank row below it. Typing into a middle row does not add or remove rows. Clicking delete on a row removes exactly that row and does not affect others. This behavior is independent per list — adding a row in Exclusions does not affect Inclusions' row count and vice versa.

## Edge Cases

| Case | Expected Behavior | Update feature doc? |
|---|---|---|
| Manifest path matches a user's exclude pattern | Manifest stays always-synced (checked before pattern match in both `isSyncable()` and `determineSyncActions()`) | yes |
| Empty (`""`) pattern row | Ignored — never treated as match-all | yes |
| Pattern added that matches an already-tracked file | File dropped from local+remote metadata via `removeExcludedFromMetadata()` on next settings change; physical local file untouched | yes |
| Pattern removed/edited to no longer match a previously-excluded file | Not auto re-added; picked up naturally on next regular sync via existing local/remote diff logic (see Open Questions) | yes |
| Volatile files (log, workspace.json) | Still filtered by `isVolatileSyncArtifact()` regardless of exclude patterns — unaffected by this feature | no |
| `syncConfigDir=false` + a configDir-targeting exclude pattern | No conflict — configDir files are already fully excluded by the existing toggle; pattern match is redundant but harmless | no |
| Malformed/pathological pattern string | `isExcludedPath()` catches compile errors per-pattern, logs nothing fatal, sync continues treating that one pattern as non-matching | no |
| Path matches both an `excludePatterns` entry and an `includePatterns` entry | Include always wins — file is synced, regardless of which list was edited more recently or either array's internal order | yes |
| Include pattern targets a file under a directory-trailing-slash exclude (e.g. `.obsidian/plugins/`) | Include still overrides it — matcher evaluates the full file list per-pattern, no git-style tree-pruning limitation | yes |
| Include-pattern row deleted, and the file it used to protect still matches an exclude pattern | File is dropped from metadata via `removeExcludedFromMetadata()` (same reconciliation as adding a new exclude pattern) | yes |

## Deviations

Baseline: clean (67 tests passing, 9 test files) — `npm run test -- --run`, captured 2026-07-04 before any implementation.

Final run: 95/95 passing (10 test files) — `npm run test -- --run`. `npx tsc -noEmit -skipLibCheck` clean. `npm run build` (production esbuild) succeeds. Step 8 (`src/settings/tab.ts`) verified via typecheck + production build rather than per-task TDD — see `testing_gaps` in frontmatter.

| Deviation | Reason | Update feature doc? |
|---|---|---|
| Updated `makeSettings()` mock in `.knowledge/features/sync/qa/plan-fix-events-localpath-lookup/verify.test.ts` to include `excludePatterns: []`/`includePatterns: []` | That ephemeral QA verify file was part of the baseline-green suite (counted in the 9 test files / 67 tests) and its local settings mock predates this plan's new fields; step 3's `isSyncable()` change made it crash (`Cannot read properties of undefined (reading 'some')`) via `isExcludedPath`. Fixed the mock, not the assertions — genuine regression, not a pre-existing failure. | no |
| Added manifest-path guard directly inside `shouldSkipFile()` (`sync-manager.ts`), rather than only "verifying at each site" as step 4 said | The 5 call sites swapped to `shouldSkipFile()` never previously special-cased the manifest (only `isVolatileSyncArtifact` needed no such guard, since it never matches the manifest) — but a user exclude pattern like `**/*.json` COULD now match the manifest at those sites, silently dropping it from metadata. Centralizing the guard in `shouldSkipFile()` itself (rather than repeating it at 5 call sites) keeps the single-choke-point property the plan's Approach section argues for, and guarantees Test Scenario 6 (manifest always synced) holds everywhere `shouldSkipFile` is used, not just in `isSyncable()`/`determineSyncActions()`. | yes |
| Updated `(syncManager as any).settings` override in `sync-manager-migration.test.ts` T8 test to include `excludePatterns: []`/`includePatterns: []` | Same class of regression as above — T8 fully replaces `settings` with a bare object for a narrow assertion, which now needs the two new array fields since `filterRemoteMetadataFiles` → `shouldSkipFile` → `isExcludedPath` runs during `syncImpl()`. Fixed the mock, not the assertions. | no |
| Added `Array.prototype.last` polyfill to `sync-manager.test.ts` (mirrors the existing `Array.prototype.contains` polyfill pattern in `sync-manager-migration.test.ts`) | Needed to actually exercise `reconcileConfigDirFiles()` in a new test — Obsidian provides `.last()` at runtime but the test environment doesn't; no existing test in this file previously called a code path using it. | no |
| Also added `Array.prototype.contains` polyfill to `sync-manager.test.ts` | Needed to exercise `determineSyncActions()` directly — same class of missing-Obsidian-global gap, this file had never called that method before. | no |
| Rewrote `determineSyncActions()`'s tail filter as a single `.filter()` predicate (manifest-always-true → exclude-pattern check → configDir check) instead of adding a second filter pass | Plan step 5 said "extend the filter predicate rather than adding a second `.filter()` pass" — implemented exactly as specified, restructured as an early-return chain for readability. | no |
| Added `vi.mock('@zip.js/zip.js', ...)` + mocked `commitSync()` to test `firstSyncFromRemote()` in isolation | No prior test coverage existed for this method at all (confirmed via grep before writing the test) — needed a full mock of the ZIP reader plus a stub for the trailing `commitSync()` call (which itself needs deep GithubClient mocking out of scope for this plan) to isolate the exclude-pattern behavior at the write step. | no |

## Impact / Affected Areas

Single feature: `sync`. No composite needed — all touched files (`settings.ts`, `tab.ts`, `sync-manager.ts`, `events-listener.ts`) already live under `sync`'s ownership per the existing feature doc's file table. New file `src/sync-filters.ts` is a sync-owned utility.

No separate `iris-0b-check-impact` was run — `iris-0a-explore` already produced an equivalent map of every filter call-site (`sync/README.md` § "File Filtering — All Check Points"), which this plan's centralization step (4) directly consumes.

## QA Sweep

### Header

```
Runtime: CLI/API-equivalent (override — see note below)
FE detection: package.json has `react`/`react-dom` as dependencies (naive heuristic says FE) —
  overridden because this is an Obsidian desktop plugin. The actual UI surface changed by this
  plan (src/settings/tab.ts) is Obsidian's imperative PluginSettingTab/Setting builder API, NOT
  React, and there is no browser-navigable web app for Playwright to launch. React in this repo
  only backs an unrelated conflict-resolution diff view, untouched by this plan. Human may override
  this call if they want a Playwright-against-Electron rig set up instead.
Critique mode: parallel-angles (files: 10, lines: 543, threshold: 10/500 default — both exceeded)
Scenarios: happy 4 / edge 6 / negative 3
Critique: blocker 2 / major 11 / minor 6 / nit 3
Pipeline order: pre-iris-4 (iris-4-sync-docs / feature-doc sync has NOT run yet for this plan)
```

### Taxonomy N/A

| Entry | Reason | Confirm? |
|---|---|---|
| network-fail | No new network calls introduced — pure local glob matching; existing sync network paths untouched | auto-confirmed |
| auth-fail | No auth/token logic touched by this diff | auto-confirmed |
| permission | No new filesystem-permission surface — skip logic is in-memory bookkeeping / write-avoidance only, doesn't touch fs permission paths | auto-confirmed |
| slow-network | No new network I/O dependent on latency | auto-confirmed |
| i18n | No i18n infrastructure exists anywhere in this plugin — new strings are English-only like every other existing settings-tab string | **needs human confirm** (FE diff — `tab.ts` changed) |

`boundary`, `empty`, `max`, `concurrent`, `a11y` are all applicable — see Scenario Matrix and Critique below.

### Scenario Matrix

| # | Family | Scenario | Source | Expected | Status |
|---|---|---|---|---|---|
| H1 | happy | Exclude pattern skips a file end-to-end (isSyncable false + determineSyncActions drops the action) | plan Test Scenarios 7, 8 | File never tracked/synced | ✅ automated, passes |
| H2 | happy | Include pattern overrides a matching exclude | plan Test Scenario 5a | File syncs despite matching exclude | ✅ automated, passes |
| H3 | happy | ZIP extraction on first-sync-from-remote skips excluded files | plan Test Scenario 9 | Excluded file never written to disk | ✅ automated, passes |
| H4 | happy | Settings UI: add pattern via dynamic row, persisted + reconciled | plan Test Scenario 11, step 8 | New blank row appears; `removeExcludedFromMetadata()` called | ⚠️ code-verified (typecheck/build) only — no real-Obsidian-runtime check (see Coverage Gaps) |
| E1 | edge (boundary) | Single `*` does not cross a path-segment boundary | plan Test Scenario 2 | `.obsidian/plugins/*/main.js` matches one level, not nested | ✅ automated, passes |
| E2 | edge (boundary) | Trailing-slash directory pattern excludes whole subtree | plan Test Scenario 3 | Matches dir + everything under it | ✅ automated, passes |
| E3 | edge (empty) | Empty/whitespace-only pattern row ignored, never treated as match-all | plan Test Scenario 4 | No-op, not a wildcard exclude | ✅ automated, passes |
| E4 | edge | List order / edit-recency independence between exclude and include arrays | plan Test Scenario 5e | Same result regardless of array order | ✅ automated, passes |
| E5 | edge (concurrent) | Settings-triggered `removeExcludedFromMetadata()` fires while a `sync()` is mid-flight | perf critique finding | Undefined today — not guarded by `this.syncing` | ❌ **not covered** — see Coverage Gaps + Critique (perf, major) |
| E6 | edge (max) | Pathological/long wildcard-heavy pattern against a realistic file path | none in plan — discovered during this QA pass | Should degrade gracefully, bounded time | ❌ **FAILS** — confirmed catastrophic backtracking (see Critique, security blocker + Run Results) |
| N1 | negative | Malformed pattern string never *throws* | plan Test Scenario 5 | `isExcludedPath()` catches compile errors, returns false for that pattern | ✅ automated, passes (but see N1 caveat below) |
| N2 | negative | Manifest path matching a user's exclude pattern must never be excluded | plan Test Scenario 6, Edge Cases table | Manifest always synced | ⚠️ **partially fails** — holds for `isSyncable()`/`determineSyncActions()` (tested), **FAILS for `removeExcludedFromMetadata()`** (never tested, confirmed broken — see Critique blocker) |
| N3 | negative | Include-pattern row deleted while it was protecting an excluded file | plan Edge Cases table | File dropped from metadata via reconciliation | ✅ automated, passes (`removeExcludedFromMetadata` general case) |

**N1 caveat:** the plan's own contract was "never throws," which the try/catch genuinely delivers. It was never a stated contract that a pattern "never hangs" — E6 shows that gap was real and unstated, not a broken promise, but it's a shipping risk regardless.

### Coverage Gaps

1. **Test Scenario 6 (manifest precedence) was never actually written as a test for any of the 3 sites that need it.** The plan's Deviations table asserts the centralized `shouldSkipFile()` guard "guarantees Test Scenario 6 ... holds everywhere `shouldSkipFile` is used" — true for the 5 sites that route through `shouldSkipFile`, but `removeExcludedFromMetadata()` (step 7) does **not** route through `shouldSkipFile` and was never given its own manifest-guard test. This gap is exactly why the blocker below shipped undetected through TDD.
2. **`max` taxonomy (pathological pattern performance) was never exercised by any test** — the ReDoS blocker below was found only by manually reproducing it in this QA pass (Run Results), not by the test suite.
3. **`concurrent` taxonomy (mid-sync settings edit) was never exercised** — flagged only by static reading (perf critique), not run against a real race.
4. **No real-Obsidian-runtime verification of the settings UI** — focus-loss-on-redraw, the async-delete race, and general click-through behavior are all read from source only (ux critique), consistent with the `testing_gaps` already recorded in this plan's frontmatter for step 8. Manual checklist at `.knowledge/features/sync/qa/exclude-patterns/scenarios.md` (M1–M7) is unexecuted pending a real Obsidian install.

### Critique

Merged from 4 parallel subagent passes (security, ux, perf, error-handling) + 1 main-thread plan-conformance pass. Deduped by file:line + finding. Ranked most-severe first.

| Severity | Angle | File:line | Finding | Suggested fix |
|---|---|---|---|---|
| blocker | security | `src/sync-filters.ts:20-25` (`matchesAny`), `src/sync-filters.ts:3-17` (`globToRegExp`) | **CONFIRMED by direct reproduction** (see Run Results): a wildcard-heavy pattern like `*a*a*a*a*a*a*a*a*a*a*a*ab` compiles to `^[^/]*a[^/]*a...ab$` — classic catastrophic-backtracking shape. Measured 758ms for a 28-char non-matching input, 4.2s for 32 chars — clearly exponential. This runs synchronously on every file path, every sync tick, every FS event, every ZIP entry. A user typing one bad pattern can freeze the Obsidian main thread for the plugin's entire lifetime of that pattern. | Cap pattern length/wildcard-segment count before compiling, and/or replace with a linear-time glob matcher (e.g. segment-by-segment matching instead of backtracking regex); add a time/step budget so a pathological pattern degrades instead of hanging. |
| blocker | security + plan-conformance | `src/sync-manager.ts:1582-1596` (`removeExcludedFromMetadata`) | **CONFIRMED**: `isExcludedPath(".obsidian/github-sync-metadata.json", ["**/*.json"], [])` returns `true` (verified live). Unlike the other 5 call-sites (all routed through `shouldSkipFile()`, which explicitly guards the manifest path), `removeExcludedFromMetadata()` calls `isExcludedPath()` directly with no manifest exemption — a pattern like `**/*.json` silently deletes the manifest's metadata entry. This also violates the plan's own Approach rationale for centralizing into `shouldSkipFile()` ("a single choke point for all future 'should this file sync' questions") — this method bypasses that choke point entirely. Root-caused by a Coverage Gap: Test Scenario 6 was never written for this method. | Add the same manifest-path guard used in `shouldSkipFile()` before the `delete`, or better: route this method through `shouldSkipFile()` itself instead of calling `isExcludedPath()` directly, restoring the single-choke-point property the plan argued for. |
| major | perf | `src/sync-filters.ts:20-25`, called from `src/sync-manager.ts:701,717,749,1180,1477,1530` and `src/events-listener.ts:192` | `matchesAny` recompiles a fresh `RegExp` per pattern on every call — no memoization. At vault scale (thousands of files), this means thousands of regex (re)compilations per sync pass, repeated on every FS event during bulk operations. Compounds the ReDoS risk above (a bad pattern is retested from scratch, every time). | Cache compiled patterns in a `Map<string, RegExp>`, invalidated when `excludePatterns`/`includePatterns` are saved. |
| major | perf | `src/settings/tab.ts:37-48` → `src/sync-manager.ts:1582` | `removeExcludedFromMetadata()` fires on **every keystroke** in any pattern row (not on blur), and itself iterates the entire tracked-metadata map. For a large vault, typing one pattern re-scans the whole store per character. | Debounce `onPatternsChanged` (e.g. 300-500ms), or only call `removeExcludedFromMetadata()` on blur/row-count-change, not on every character. |
| major | perf | `src/sync-manager.ts:1582-1596` vs. `this.syncing` guard used at `src/sync-manager.ts:95,441` | `removeExcludedFromMetadata()` is not guarded by `this.syncing` and can run concurrently with an in-flight `sync()`, mutating the same `metadataStore.data.files` object mid-diff (`determineSyncActions`, `filterRemoteMetadataFiles`, etc. all read/write it too). Race window is real but unexercised (Coverage Gap E5). | Guard with `this.syncing` (skip/queue) or share the same mutex `sync()` uses before mutating metadata from a settings-triggered path. |
| major | security | `src/settings/settings.ts:9-11` | `excludePatterns`/`includePatterns` are synced as part of plugin settings when `syncConfigDir` is enabled (if the plugin's own config file lives under the synced configDir) — a repo collaborator with write access could remotely plant a ReDoS payload or a manifest-matching pattern into another user's client with no re-validation on load. | Re-apply pattern validation (length/complexity cap from the ReDoS fix) after every settings load, not only at the UI entry point. |
| major | ux | `src/settings/tab.ts:41-46` | Typing the first character into the trailing blank row immediately triggers `this.display()` (full `containerEl.empty()` + rebuild), destroying the input's DOM node and losing focus after exactly one keystroke — user must re-click to keep typing. This is the plan's own step-8 design (code conforms to it), but the design itself has this UX bug. | Preserve focus/caret across the redraw — refocus the same row index and restore cursor position after `this.display()`. |
| major | ux | `src/settings/tab.ts:51-59` | Delete handler is `async` (awaits I/O) before `this.display()`. A second delete click on a different row during that await window splices via a stale closured `index`, silently deleting the wrong pattern with no confirmation/undo. | Ignore/disable further row interaction while a delete is in flight, or splice by value/identity instead of closured index. |
| major | ux | `src/settings/tab.ts:37-48` | No UI feedback when a pattern is malformed/unparseable — silently treated as non-matching per plan, with zero signal to the user that their exclusion isn't active. | Validate on change/blur, surface an inline warning state when a pattern fails to compile. |
| major | ux | `src/settings/tab.ts:245-261` | No live feedback when include/exclude precedence causes a no-op (e.g. a broad include already covers a new exclude) — only static `.setDesc()` copy explains precedence, with no per-row signal. | Show a live match indicator per row (e.g. "matches N files" / "overridden by inclusion X"). |
| minor | error-handling | `src/sync-filters.ts:1` (`GLOB_SPECIAL_CHARS_REGEXP`) | **CONFIRMED**: the escape class omits `?`. A pattern like `?` or `**?foo` makes `new RegExp("^?$")` throw `SyntaxError: Nothing to repeat`. Currently non-fatal only because every caller happens to go through `matchesAny`'s try/catch — `globToRegExp` itself has zero internal protection, so any future direct caller (e.g. a UI pattern-preview feature) would crash unhandled. | Add `?` to the escape char class; consider wrapping `new RegExp(...)` inside `globToRegExp` itself so "never throws" is the function's own property, not a convention every caller must remember. |
| minor | perf | `src/settings/tab.ts:41-46,58` | Every redraw from finishing/deleting a pattern rebuilds `containerEl` from scratch, typically resetting scroll position — disruptive with a long pattern list. | Capture and restore `scrollTop` across the redraw. |
| minor | error-handling | `src/settings/tab.ts:31-33` | `onPatternsChanged` awaits `saveSettings()`/`removeExcludedFromMetadata()` with no try/catch — a failure becomes a silent unhandled rejection. Matches the pre-existing "Sync configs" toggle's same gap (not a new pattern), but this one fires per-keystroke instead of per-toggle, multiplying exposure. | Wrap in try/catch, surface failures via `Notice` at least for this new high-frequency codepath. |
| minor | error-handling | `src/sync-manager.ts:1582-1596` | Deletes in-memory entries before the awaited `save()`; if `save()` rejects, no rollback — in-memory/on-disk metadata diverge. Mirrors `removeConfigDirFromMetadata`'s pre-existing no-rollback shape, but now reachable far more often (every pattern edit vs. an occasional toggle). | Catch `save()` failures, log/report divergence, or debounce (ties into the perf finding above). |
| minor | ux | `src/settings/tab.ts:52-54` | All trash buttons share an identical generic "Remove" tooltip with no per-row distinguishing text — a screen-reader user tabbing through several can't tell which pattern each one deletes. | Include the pattern value in the tooltip, e.g. `Remove "${pattern}"`. |
| minor | ux | `src/settings/tab.ts:37-40` | No `.setName()` on pattern rows — no persistent accessible label beyond the placeholder, which isn't a robust accessible-name substitute once filled. | Add a short `.setName()` (e.g. "Pattern") or an explicit `aria-label`. |
| minor | ux | `src/settings/tab.ts:37-61` | Trailing blank row omits the delete button entirely instead of reserving its space — likely causes a visible width/layout shift when a row transitions from "last" to "non-last". | Render a disabled/hidden same-size trash button on the trailing row instead of omitting it. |
| nit | perf | `src/sync-filters.ts:20-21` (`matchesAny`) | Confirmed correct: `.some()` short-circuits at first match — no change needed. | none |
| nit | ux | `src/settings/tab.ts:26-28,42` | A cleared middle row is visually indistinguishable from the true trailing "add new" row (both blank, but the cleared one still has a delete button and the true one doesn't) — subtle but noted. | Consider a visual affordance distinguishing the true "add" row. |
| nit | ux | `src/settings/tab.ts:259-261` | Inclusions placeholder example (`gitless/**/main.js`) assumes context (re-including a plugin's own build folder) that's non-obvious for a non-technical audience. | Use a more generic, self-explanatory example. |

### Run Results

Command: `npm run test -- --run`
Run at: 2026-07-04
Result: 95/95 passing (10 test files), 0 failures — full regression suite, unchanged from build.

Command: manual ReDoS reproduction (ad-hoc Node scripts, not part of the test suite):
```js
function build(pattern) {
  const segs = pattern.split("*").map(s => s.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp("^" + segs + "$");
}
const re = build("*a*a*a*a*a*a*a*a*a*a*a*ab"); // mirrors globToRegExp's output shape
re.test("a".repeat(28)); // → 758ms
re.test("a".repeat(32)); // → 4243ms
```
Run at: 2026-07-04. Result: **confirms E6 fails / security blocker #1 is real** — exponential blowup, not a false positive from static analysis.

Command: manifest-exclusion direct repro (`npx tsx -e '...'`):
```ts
import { isExcludedPath } from "./src/sync-filters";
isExcludedPath(".obsidian/github-sync-metadata.json", ["**/*.json"], []); // → true
```
Run at: 2026-07-04. Result: **confirms N2 partially fails / security blocker #2 is real** — this is exactly the input `removeExcludedFromMetadata()` would delete on.

Manual (non-automatable) scenarios: see `.knowledge/features/sync/qa/exclude-patterns/scenarios.md` M1–M7, unexecuted (no real Obsidian install in this environment).
