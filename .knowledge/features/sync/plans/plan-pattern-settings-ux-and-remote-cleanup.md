---
status: in-progress
slug: pattern-settings-ux-and-remote-cleanup
created: "2026-07-05"
testing: tdd
qa: done
qa_completed: "2026-07-05"
follow_up: pending
testing_gaps:
  - "delete_remote switch-case in syncImpl()'s actions.map() (newTreeFiles[path].sha = null) has no dedicated unit test for any action source, including the new computeExcludedRemoteOrphans() actions -- syncImpl() itself has no direct test (pre-existing gap, not introduced by this plan). computeExcludedRemoteOrphans() is tested at the action-computation level; its consumption by the existing switch-case is untested end-to-end."
  - "PatternPreviewModal.onOpen() (the actual rendered list markup) is untested -- same class of Obsidian-DOM gap as tab.ts's display(), which this codebase has consistently deferred to typecheck+build verification (see plan-exclude-patterns.md Deviations). bucketPathsByPattern() (the logic) and collectVaultPaths() (the vault walk) are both directly unit-tested."
---
# Plan: Pattern Settings UX Fix + Remote-Orphan Cleanup + Local Diff Preview

## Approach

**Rough change (UI/system):**
1. UI: Exclude/Include pattern lists in Settings get an explicit "+ Add pattern" button; typing no longer rebuilds the settings tab or steals focus.
2. System: excluding an already-synced file now actually removes it from the GitHub repo — on the *next* regular sync, not immediately when you edit the pattern.
3. UI: a new "Preview pattern matches" button in Settings opens a modal listing every local vault path bucketed into "will sync" vs "excluded by pattern" — local-only, no GitHub call.

### Item 1 — focus-loss on pattern typing

**Chosen: Option A — explicit "+ Add pattern" button.** Remove the `if (isLastRow && value.trim() !== "") { this.display(); }` branch in `renderPatternList()` (`src/settings/tab.ts:68-70`) entirely — typing into any row, including the last one, only saves + debounces cleanup, never rebuilds the DOM. Add a button below each list ("+ Add pattern") that pushes one blank string onto the array and calls `this.display()` on click only — an explicit user action, not a keystroke side-effect, so losing focus on click is a non-issue (there's nothing to type into at that moment).

Rejected:
- **Option B — targeted DOM insert on type.** Keep auto-grow-on-type but insert the new row's DOM node directly instead of calling `display()`. Rejected: `Setting` (Obsidian's builder class used for every row) has no supported "insert a new Setting after this one" API — doing this cleanly means bypassing the builder and hand-rolling DOM nodes for the new row, fragile and undocumented, for a behavior (auto-grow-on-type) the user explicitly said gets in the way anyway.

### Item 2 — excluded file never deleted from remote

**Chosen: Option A — delete fires on the next regular sync(), via the existing `delete_remote` pipeline.** Settings-tab behavior is unchanged: `performExcludedMetadataCleanup()` still immediately forgets the local tracking entry for a newly-excluded path (confirmed prior design, `plan-exclude-patterns.md` Edge Cases table) and still never touches the physical local file. What's new is entirely inside `syncImpl()` (`src/sync-manager.ts`): after fetching the raw remote tree (`files`, from `getRepoContent()`), compute the set of paths that are both (a) `shouldSkipFile(path) === true` under current settings and (b) still present as a key in `files` (i.e. GitHub still has a blob for that path from before it was excluded). Emit a `delete_remote` action for each such path, appended to the existing `actions` array — reusing the `delete_remote` case already implemented in the upload/download/delete loop (`sync-manager.ts:639-643`, `newTreeFiles[path].sha = null`) untouched.

This is a pure *addition* — `determineSyncActions()` itself is not modified; it already silently drops excluded paths from its own consideration (`sync-manager.ts:1189`), so there's no risk of double-emitting an action for the same path.

Rejected:
- **Option B — immediate remote delete from settings.** Call `GithubClient` directly from the debounced settings-tab cleanup, deleting the file from GitHub the moment a matching pattern is typed (or shortly after, debounced). Rejected: every other remote-affecting action in this codebase happens through an explicit "Sync" click (`main.ts` / `sync-manager.ts:437` "Sync already in progress" flow) — a silent background delete triggered by typing in Settings breaks that contract and risks unpleasant surprise/data loss with no confirmation step. Also requires building a brand-new one-off remote-write path (new tree/commit call) outside the existing, tested `commitSync()` flow.
- **Option C — manual "Clean up excluded files" button.** A dedicated button the user must explicitly click to trigger the delete for currently-orphaned excluded files. Rejected: Option A already covers this automatically the next time the user does what they were going to do anyway (click Sync); a whole separate UI affordance + a second one-off commit path duplicates logic Option A gets for free by extending the existing sync flow.

### Item 3 — pattern preview/diff button

**Chosen: Option B — local-only pattern tester.** A new button in Settings (near the Exclude/Include headings) that walks the vault root via `vault.adapter.list()` (same recursive-walk technique already used in `reconcileConfigDirFiles()`), runs every discovered path through `shouldSkipFile()`, and opens a `Modal` (already imported in `tab.ts`) with two sections: "Will sync" and "Excluded by pattern". No GitHub API call, no auth/rate-limit dependency, instant.

Explicitly reconsidered given item 2 landing in the same plan: item 2 makes the "stuck orphan on remote" scenario self-healing on the next sync, so a button whose job is specifically to surface remote orphans has much less standing use — the local-only view (does my pattern match what I expect?) covers the remaining real need without a network dependency.

Rejected:
- **Option A — preview-sync button (dry-run of `syncImpl()`'s read-only half).** Would also categorize upload/download/delete-remote/delete-local by hitting `getRepoContent()` for real. More complete, but adds a GitHub API call (rate limit, requires valid configured token/repo) to answer a question item 2 already resolves automatically — not worth the dependency once item 2 ships.
- **Option C — live "matches N files" count per pattern row.** Already explicitly rejected on the record in `plan-fix-exclude-patterns-qa-findings.md`'s DECISIONS entry, for introducing a new perf concern (full metadata/vault scan per keystroke) the prior hardening pass deliberately avoided taking on. Reintroducing it here would contradict that logged decision without new justification.

## Goal Pressure-Test Note (from Gate G)

Item 1 was already flagged as a known, deferred UX finding in `plan-fix-exclude-patterns-qa-findings.md` ("focus loss on redraw") — this plan is the deferred fix finally landing, not a new discovery. Item 2 reverses a previously-confirmed design decision (`plan-exclude-patterns.md`, 2026-07-04: exclude = forget-locally-only, physical/remote files untouched) because the human's actual usage exposed it as surprising in practice. Item 3 is net-new, scoped down at Gate A from a remote-aware preview to a local-only one given item 2's fix reduces its necessity.

**Raised → resolved (surfaced at Gate G, `goal-ok` received):** earlier in this conversation item 2 was described as needing "a new remote-write path from settings, not from sync flow." On reflection that was wrong — the chosen approach reuses the existing `delete_remote` pipeline that only ever runs from an explicit `sync()` call, adding no new write path and no settings-triggered remote mutation.

## `src/settings/tab.ts` — Explicit Add-Row Button + Local Pattern Preview

1. In `renderPatternList(containerEl, patterns, placeholder)`:
   - Remove the auto-grow branch: delete `if (isLastRow && value.trim() !== "") { this.display(); }` from the `onChange` handler (currently `tab.ts:68-70`).
   - Remove the "always keep one trailing blank row" auto-push at the top of the method (currently `tab.ts:49-51`) — replaced by the explicit button below, so the list only ever contains rows the user actually added (no more implicit trailing blank).
   - After the `patterns.forEach(...)` loop, add:
     ```ts
     new Setting(containerEl).addButton((button) =>
       button
         .setButtonText("+ Add pattern")
         .onClick(async () => {
           patterns.push("");
           this.display();
         }),
     );
     ```
   - Every row now gets a delete (trash) button, including what was previously the "last" row — drop the `if (!isLastRow)` guard around the existing `row.addButton(...)` trash-button block (currently `tab.ts:74-85`), since there's no implicit blank row to protect anymore.
2. Add a new private method `private async showPatternPreview(): Promise<void>` in `GitHubSyncSettingsTab`:
   - Walk the vault root recursively via `this.app.vault.adapter.list()`, same loop shape as `reconcileConfigDirFiles()` in `sync-manager.ts:741-754` (stack of folders, pop, list, push subfolders, collect files).
   - For each collected path, call `this.plugin.syncManager` — expose `shouldSkipFile` as a `public` (or package-visible) method on `SyncManager` (currently `private shouldSkipFile` at `sync-manager.ts:691`; change visibility only, no logic change) so the settings tab can call it directly without duplicating `isExcludedPath` wiring.
   - Bucket every path into `willSync: string[]` / `excluded: string[]`.
   - Open a new `Modal` subclass (e.g. `PatternPreviewModal`, new class in `tab.ts` or a new `src/settings/pattern-preview-modal.ts` file) rendering two headed lists (`Will sync (N)`, `Excluded by pattern (N)`), each path as a plain list item. Empty list renders "None".
3. Add a button to trigger it, placed once (covers both lists together, since `shouldSkipFile` already evaluates exclude+include jointly): near the "Sync Exclusions" / "Sync Inclusions" headings, `new Setting(containerEl).setName("Preview pattern matches").addButton((b) => b.setButtonText("Preview").onClick(() => this.showPatternPreview()))`.

## `src/sync-manager.ts` — Delete-Remote-On-Exclude + Visibility Change

4. Change `private shouldSkipFile(filePath: string): boolean` (`sync-manager.ts:691`) to `shouldSkipFile(filePath: string): boolean` (drop `private`) — needed for item 3's settings-tab call in step 2 above. No other change to this method.
5. In `syncImpl()` (`sync-manager.ts:474` onward), after `const { files, sha: treeSha } = await this.client.getRepoContent(...)` and after building `remoteMetadata.files` via `filterRemoteMetadataFiles`, add a new step computing orphaned-excluded paths still present in the raw tree:
   ```ts
   const excludedRemoteOrphans: SyncAction[] = Object.keys(files)
     .filter((filePath) => filePath !== `${this.vault.configDir}/${MANIFEST_FILE_NAME}`)
     .filter((filePath) => this.shouldSkipFile(filePath))
     .map((filePath) => ({ type: "delete_remote", filePath }));
   ```
   (The manifest exclusion mirrors `shouldSkipFile`'s own internal manifest guard — belt-and-suspenders since `shouldSkipFile` already returns `false` for the manifest, but keep the explicit filter here as a readability guard against future manifest-guard changes.)
6. Append `...excludedRemoteOrphans` into the `actions` array construction (`sync-manager.ts:555-562`), alongside the existing `determineSyncActions(...)` and `conflictActions` spreads. No signature change to `determineSyncActions()` itself.
7. Verify (via new test, see Test Scenarios) that the existing `delete_remote` handling in the `actions.map()` switch (`sync-manager.ts:639-643`) requires no change — it only reads `action.filePath` and mutates `newTreeFiles`, which is keyed from the raw `files` tree regardless of action origin.

## Open Questions

- [x] **"+ Add pattern" button placement** — CONFIRMED 2026-07-05: one separate button per list (Exclude list gets its own, Include list gets its own — 2 buttons total, matches step 1's per-list `renderPatternList` call sites).
- [x] **`excludedRemoteOrphans` vs conflicts overlap** — CONFIRMED 2026-07-05: assumption holds as-is, no extra guard needed. Human's framing: if a path is excluded, conflict handling doesn't apply to it at all.

## Test Scenarios

1. `renderPatternList`: typing a non-blank value into any row (including what was previously the trailing blank row) does NOT call `this.display()` — assert via spy that `display` is not invoked from `onChange`.
2. Clicking "+ Add pattern" pushes exactly one `""` onto the passed `patterns` array and calls `this.display()` exactly once.
3. Every row (no exceptions) renders a delete/trash button; clicking it removes exactly that row, calls `onPatternDeleted()` (`saveSettings()` + `removeExcludedFromMetadata()`), then `display()`.
4. `shouldSkipFile()` remains callable and correct with the same behavior as before (regression: existing `sync-manager.test.ts` `shouldSkipFile` describe block, `sync-manager.test.ts:399+`) after the visibility change from `private` to public.
5. `syncImpl()`: given a `files` (raw tree) entry for `.obsidian/plugins/foo/main.js` with a real `sha`, and `excludePatterns: ['**/main.js']`, `includePatterns: []` — resulting `actions` contains `{ type: 'delete_remote', filePath: '.obsidian/plugins/foo/main.js' }`, and the manifest path is never included even if a pattern like `**/*.json` would otherwise match it.
6. `syncImpl()`: given a path that matches an exclude pattern but has NO entry in the raw `files` tree (never was synced), no `delete_remote` action is emitted for it — `excludedRemoteOrphans` only fires for paths GitHub still has.
7. `syncImpl()`: a path present in both `excludePatterns` and `includePatterns` matches (include wins) is NOT included in `excludedRemoteOrphans` — `shouldSkipFile` already returns `false` for it.
8. End-to-end via `newTreeFiles`: after the `delete_remote` action from `excludedRemoteOrphans` is processed by the existing switch-case, `newTreeFiles[path].sha === null`, so `commitSync()`'s tree omits that blob on the next commit (existing `delete_remote` behavior, unit-test that the new action source flows into it correctly).
9. `showPatternPreview()`: given a mocked `vault.adapter.list()` tree and a set of exclude/include patterns, produces the correct `willSync` / `excluded` buckets, calling the now-public `shouldSkipFile()` (or an injected equivalent in the test) rather than reimplementing `isExcludedPath` logic in the settings tab.

## Edge Cases

| Case | Expected Behavior | Update feature doc? |
|---|---|---|
| Exclude pattern added for a file that was never synced (no remote presence) | No `delete_remote` action emitted; local metadata still forgotten as before | yes |
| Exclude pattern added for a file currently on remote | Local metadata forgotten immediately (settings-tab behavior unchanged); `delete_remote` emitted on the *next* `sync()` call, not immediately | yes |
| Manifest path happens to match a broad exclude pattern (e.g. `**/*.json`) | Never included in `excludedRemoteOrphans` — explicit filter + `shouldSkipFile`'s own manifest guard, belt-and-suspenders | yes |
| User never clicks Sync after excluding an already-synced file | File stays on remote indefinitely (unchanged from today) — cleanup is tied to the next sync, not automatic/background | yes |
| "+ Add pattern" clicked with 0 existing rows | Pushes the first `""` row, same as any other click | no |
| All rows deleted from a list | List renders empty, "+ Add pattern" button still present to start again | no |
| Pattern Preview button clicked with an empty vault | Modal renders both sections as "None" | no |
| Pattern Preview walks a very large vault | Local-only, synchronous-ish walk — no network call, no rate-limit risk; potential UI-thread cost on huge vaults is accepted as-is (same cost class as existing `reconcileConfigDirFiles()` walk, not a new risk) | no |

## Deviations

Baseline: clean (101 tests passing, 10 test files) — `npm run test -- --run`, captured 2026-07-05 before any implementation.

Final run: 111/111 passing (10 test files) — `npm run test -- --run`. `npx tsc -noEmit -skipLibCheck` clean. `npm run build` (production esbuild) succeeds.

| What changed | Why | Update feature doc? |
|---|---|---|
| Extracted `computeExcludedRemoteOrphans()` as its own private method on `SyncManager` instead of inlining the `Object.keys(files).filter(...).map(...)` directly in `syncImpl()` as the plan step 5 snippet showed | Matches this codebase's existing convention of testing orchestration sub-pieces (`shouldSkipFile`, `determineSyncActions`, `filterRemoteMetadataFiles`) as independently-bindable private methods rather than inline blocks buried in `syncImpl()`, which itself has no direct test coverage. No behavior difference from the plan. | yes |
| Added a local `Setting`/`PluginSettingTab`/`Modal` mock inside `tab.test.ts` (`vi.mock("obsidian", ...)`) | Needed to unit-test `renderPatternList()`'s row-wiring (Test Scenarios 1-3) at all — the shared `vitest.setup.ts` mock never exported `Setting`, so `new Setting(...)` threw. Scoped to this test file only. | no |
| Added `Modal` to the shared `vitest.setup.ts` mock (previously not exported at all) | `PatternPreviewModal extends Modal` is evaluated at module-load time (class definition), unlike the pre-existing `new Modal(...)` call inside the Reset button's `onClick` (lazy, only evaluated on click). Any test file that transitively imports `tab.ts` now needs `Modal` defined at import time — `main.test.ts` failed with "Class extends value undefined" until this was added. | no |
| `showPatternPreview()`'s Modal-rendering (`PatternPreviewModal.onOpen()`) verified via typecheck + build only, not TDD | Same class of Obsidian-DOM gap this codebase already deferred for `tab.ts`'s `display()` in `plan-exclude-patterns.md` (documented there via `testing_gaps`). The pure bucketing logic (`bucketPathsByPattern`) and the vault walk (`collectVaultPaths`) — the actual testable logic — are both TDD'd; only the leaf-level `createEl`/list-rendering is unverified by a test. | yes |
| `delete_remote` switch-case consumption of `computeExcludedRemoteOrphans()`'s actions not unit-tested end-to-end | `syncImpl()` has no direct test at all in this codebase (pre-existing gap, confirmed by grep before writing tests) — every other `syncImpl()` sub-piece is tested the same way: at the point where it produces its own output (`determineSyncActions`, `filterRemoteMetadataFiles`, and now `computeExcludedRemoteOrphans`), not through a full `syncImpl()` integration test. | no |

## Impact / Affected Areas

- `src/settings/tab.ts` — `renderPatternList()` rewritten (remove auto-grow, add explicit button, drop last-row trash-button guard); new `showPatternPreview()` method + new Modal.
- `src/sync-manager.ts` — `shouldSkipFile()` visibility change (`private` → public); new `excludedRemoteOrphans` computation + action-array append inside `syncImpl()`.
- `src/settings/tab.test.ts` — new/updated tests for button behavior, no-display-on-type, preview modal bucketing.
- `src/sync-manager.test.ts` — new tests for `excludedRemoteOrphans` behavior in `syncImpl()`.
- `.knowledge/features/sync/README.md` — update "Settings-triggered metadata cleanup" and "Settings UI mechanics" sections (written 2026-07-05 during `iris-0a-explore`) to reflect the new behavior once this ships — this plan changes facts that doc currently states as current behavior.

## QA Sweep

### Header

Runtime: FE detected (`react` in `package.json` dependencies) → nominally Playwright Automation Script, but **skipped-no-runtime**: Obsidian Desktop is a native Electron app requiring a manually built/installed plugin inside a real vault; Playwright is not installed locally (`npx playwright --version` fails) and this sandbox has no network access to install it. UI click-through scenarios are recorded as a manual checklist instead (`.knowledge/features/sync/qa/pattern-settings-ux-and-remote-cleanup/scenarios.md`). The underlying logic (bucketing, orphan detection, matcher) IS automatable and was executed directly — see Run Results.

Critique mode: single-sweep (files: 5, lines: 464, threshold: 10 files / 500 lines)

Scenarios: happy 5 (H1-H5) / edge 3 (E1-E3, of which E1/E3 automated, E2 manual-known-gap) / negative 1 (N1, manual)

Critique: blocker 1 / major 1 / minor 2 / nit 0

Pipeline order: pre-iris-4 (plan `status: in-progress`, feature doc not yet synced — findings below flow into iris-4)

### Taxonomy N/A

| Entry | Reason | Confirm? |
|---|---|---|
| max | Pattern-length cap (500 chars) is pre-existing, hardened in `plan-harden-exclude-patterns.md`, untouched by this plan | auto-confirmed |
| network-fail | `computeExcludedRemoteOrphans()` is pure/local over already-fetched `files` — no new network call introduced | auto-confirmed |
| auth-fail | No new auth surface | auto-confirmed |
| permission | Local filesystem reads only, same class as existing `reconcileConfigDirFiles()` | auto-confirmed |
| i18n | No i18n system in this codebase; new strings are plain English, consistent with the rest of the plugin | auto-confirmed |
| slow-network | No new network call | auto-confirmed |
| a11y | FE diff (new buttons) — **not** marked N/A, see Critique finding #3 below | needs human confirm (flagged, not skipped) |

### Scenario Matrix

| # | Family | Scenario | Source | Expected | Status |
|---|---|---|---|---|---|
| H1 | happy | type into last row of exclude list | plan Approach item 1 | no `display()` call, focus kept | automated — `tab.test.ts` "never calls display() when typing" |
| H2 | happy | click "+ Add pattern" | plan Approach item 1 | one blank row pushed, `display()` called once | automated — `tab.test.ts` "+ Add pattern button pushes exactly one blank row" |
| H3 | happy | delete a row (not the last remaining one) | plan Approach item 1 | row removed, save + cleanup + redraw | automated — `tab.test.ts` "every row gets a working delete button" |
| H4 | happy | exclude an already-synced file, then sync | plan Approach item 2, Edge Case row 2 | `delete_remote` action emitted, file removed from GitHub tree on next commit | automated (unit level) — `sync-manager.test.ts` `computeExcludedRemoteOrphans` describe block; **manual** for the real end-to-end GitHub call (H4 in scenarios.md) |
| H5 | happy | click "Preview pattern matches" | plan Approach item 3 | modal buckets vault paths into will-sync / excluded | automated (logic level) — `bucketPathsByPattern`/`collectVaultPaths` tests; **manual** for the rendered modal (`PatternPreviewModal.onOpen()` is a documented `testing_gaps` item) |
| E1 | edge (empty) | delete every row down to zero | plan Edge Case row 6 | list empty, "+ Add pattern" still present | reasoned from code (button added unconditionally after the `forEach`, no guard) — not independently unit-tested at 1→0; recorded as Coverage Gap below |
| E2 | edge (boundary) | Preview with `syncConfigDir=false` (default) and configDir files present | not in plan's Edge Cases table — found during critique | `.obsidian/*` files should show "Excluded" | **FAILS** — see Critique finding #1 (blocker) |
| E3 | edge (concurrent) | pattern edited via settings while a `sync()` is already in-flight | plan Goal Pressure-Test riskiest-unknown; existing `this.syncing` guard on `removeExcludedFromMetadata()` | settings-triggered cleanup no-ops during an in-flight sync (pre-existing guard); `computeExcludedRemoteOrphans()` only reads already-fetched `files` synchronously, no interleaving possible in single-threaded JS | verified by code inspection, not a new race — no test needed beyond existing coverage |
| N1 | negative | rapid repeated "+ Add pattern" clicks | edge-taxonomy: boundary | each click adds exactly one row, no double-add | manual (N1 in scenarios.md) — synchronous handler, no debounce needed, but not exercised live |

### Coverage Gaps

- E1 (0-row boundary for "+ Add pattern") reasoned from code, not independently unit-tested. Low risk (no branching on `patterns.length` in the button's own path), but flagging per Iron Law rather than silently asserting it's fine.
- N1 (rapid-click de-dup) not exercised — the click handler is synchronous with no debounce, so each click is a fully separate, sequential DOM event; risk is low but unverified live.

### Critique

| Severity | Angle | File:line | Finding | Suggested fix |
|---|---|---|---|---|
| blocker | correctness / data-safety | (config, not code) — human's actual `includePatterns: [".obsidian/plugins/gitless", ...]` | Verified via direct script execution against the real matcher (see Run Results): this pattern has **no trailing slash**, so under existing (pre-this-plan) glob semantics it only matches the literal 4-segment path `.obsidian/plugins/gitless` itself, never anything nested under it. `.obsidian/plugins/gitless/main.js` is still excluded=`true`. Once item 2 ships, the **next sync will delete the human's own gitless plugin's files from GitHub**, because they're still classified as excluded-but-on-remote. This isn't a code bug in this plan — the matcher behaves exactly as `plan-exclude-patterns.md` specified and tested — but it's a real, immediate data-loss risk against the human's actual current settings. | Human should update `includePatterns` to `.obsidian/plugins/gitless/` (trailing slash) or `.obsidian/plugins/gitless/**` before running a sync with this build. Verified fix works: re-ran the same script with the trailing slash and `.obsidian/plugins/gitless/main.js` / `data.json` both come back `excluded: false`, while `.obsidian/plugins/other/main.js` correctly stays `true`. |
| major | correctness | `src/settings/tab.ts` — `showPatternPreview()` | Preview buckets every vault path using `shouldSkipFile()` alone. `shouldSkipFile()` does NOT check `settings.syncConfigDir` — that gating lives separately in `sync-manager.ts:1209` (`determineSyncActions`), `:1492` (`loadMetadata`), `:1528`. `DEFAULT_SETTINGS.syncConfigDir` is `false`. Result: for most installs (default toggle off), every `.obsidian/*` file is shown under "Will sync" in the preview even though it is never actually synced while the toggle is off — the preview's core promise ("shows which files will sync") is wrong for the common case. Also doesn't mirror the dot-file skip `reconcileConfigDirFiles()` applies (`sync-manager.ts:759`), a smaller instance of the same root cause. | Bucket using a predicate that also accounts for `syncConfigDir` (e.g. a small wrapper/exposed method mirroring the `sync-manager.ts:1209` check), not `shouldSkipFile()` alone. |
| minor | error-handling | `src/settings/tab.ts` — `showPatternPreview()` `onClick` | No try/catch around the vault walk. If `vault.adapter.list()` throws, the click silently does nothing (no `Notice`) — inconsistent with "Copy logs"/"Clean logs" buttons in the same file, which both catch and show `new Notice(...)` on failure. | Wrap in try/catch, show a `Notice` on failure, matching the existing convention in this file. |
| minor | a11y | `src/settings/tab.ts` — both "+ Add pattern" buttons (Exclude list, Include list) | Both buttons share the identical accessible name "+ Add pattern" — a screen-reader user navigating by control name (not visual position) can't distinguish which list a given button adds to. | Differentiate the label per list, e.g. "+ Add exclusion" / "+ Add inclusion". |

**Plan-conformance (main-thread only pass):** No deviations found beyond what's already logged in the plan's own `## Deviations` table (all pre-disclosed: `computeExcludedRemoteOrphans` extraction, local `obsidian` mocks, shared `Modal` mock addition, 2 testing_gaps). Every plan step (1-7) traced to a matching diff hunk. No silent scope drift.

### Run Results

Command: `npm run test -- --run`
Run at: 2026-07-05
Result: 10 test files passed, 111 tests passed, 0 failed (matches the build's own Final run note).

Command: `npx tsx -e '<script exercising isExcludedPath() with the human's exact reported excludePatterns/includePatterns>'`
Run at: 2026-07-05
Result:
```
.obsidian/plugins/foo/main.js -> excluded: true
.obsidian/plugins/gitless/main.js -> excluded: true        // <- still excluded, see blocker finding
.obsidian/plugins/gitless/data.json -> excluded: false
.obsidian/plugins/other/data.json -> excluded: false
```
Follow-up run with `includePatterns: [".obsidian/plugins/gitless/", ...]` (trailing slash added):
```
.obsidian/plugins/gitless/main.js -> excluded: false
.obsidian/plugins/gitless/data.json -> excluded: false
.obsidian/plugins/other/main.js -> excluded: true
```
Confirms the trailing-slash fix resolves it without over-including the sibling `other` plugin.
