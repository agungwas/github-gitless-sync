---
status: done
completed: "2026-07-05"
slug: fix-exclude-patterns-qa-findings
created: "2026-07-05"
testing: tdd
testing_gaps:
  - "Step 6 (src/settings/tab.ts wiring): scheduleMetadataCleanup() itself IS unit-tested with fake timers (no Setting-builder mock needed, since it's a plain method). But wiring it into the actual onChange/onClick row handlers inside renderPatternList (Test Scenarios 7-8: delete stays immediate, saveSettings never debounced) still needs the same Obsidian Setting-builder mock that was out of scope for the original plan-exclude-patterns build. Verified via typecheck/build + code read-through instead."
qa: done
qa_completed: "2026-07-05"
follow_up: "done — see plan-harden-exclude-patterns.md"
---
# Plan: Fix Exclude-Patterns QA Blockers + Causally-Linked Majors

## Approach

**Rough change (UI/system):** System: exclude/include glob patterns can no longer freeze Obsidian's main thread or silently delete the sync manifest's metadata entry. Also fixes a real race condition and per-keystroke UI jank on large vaults. Nothing new visible to the user — same settings UI as before.

**Chosen: Option B — blockers + causally-linked majors**, from `.knowledge/features/sync/plans/plan-exclude-patterns.md` § `## QA Sweep` § `### Critique` (the QA sweep for the original `exclude-patterns` build; this plan does not redo that analysis — see Impact section below):

1. Replace the regex-backtracking glob matcher in `src/sync-filters.ts` with a linear-time (non-backtracking) matcher — fixes the **confirmed** ReDoS blocker (measured 758ms @ 28 chars, 4.2s @ 32 chars, exponential growth, reproduced live during QA).
2. Route `removeExcludedFromMetadata()` through the existing `shouldSkipFile()` choke point instead of calling `isExcludedPath()` directly — fixes the **confirmed** manifest-deletion blocker (`isExcludedPath(".obsidian/github-sync-metadata.json", ["**/*.json"], [])` was verified to return `true` live during QA, and this method has no manifest guard unlike the other 5 `shouldSkipFile`-routed call-sites).
3. Guard `removeExcludedFromMetadata()` with the existing `this.syncing` flag — fixes the perf-critique's confirmed-plausible race (concurrent mutation of `metadataStore.data.files` with an in-flight `sync()`).
4. Debounce the settings-tab's per-keystroke `removeExcludedFromMetadata()` call — fixes the perf-critique's confirmed per-keystroke full-metadata-store rescan on every character typed.

Rejected alternatives (from Gate A):
- **Option A — blockers only.** Ships the 2 critical fixes fastest, but leaves the `this.syncing` race and per-keystroke jank in code this very plan is already reopening (`sync-manager.ts`, `settings/tab.ts`) — deferring them means touching the same files again later for the same root cause. Rejected: wasteful sequencing, not a scope-discipline win.
- **Option C — full sweep (all 21 QA findings).** Also includes every UX/a11y item: focus preservation on redraw, delete-button race guard, inline pattern-validation feedback, a live "matches N files" indicator per row, scroll-position preservation, distinct per-row tooltips, accessible labels, reserved delete-button space on the trailing row, and re-validating patterns pulled in via synced settings. Rejected: several of these are product/UX **design decisions** (what does an inline warning look like? what does a live match-count UI look like?) that deserve their own deliberate pass, not a bundle reacting to a bugfix QA sweep. The "live match-count" idea in particular would introduce a **new** perf concern (scanning all tracked metadata per row per keystroke) that the original QA critique didn't even anticipate — exactly the kind of scope creep a hardening patch should avoid.

**Explicitly deferred to a future plan (not fixed here):** all UX/a11y findings from the QA critique (focus loss on redraw, delete-race via stale closure index, no inline validation feedback, no live precedence indicator, scroll-position reset, generic tooltips, missing `.setName()` accessible labels, trailing-row layout shift, 3 nits) and the security-major finding about re-validating patterns pulled in via `syncConfigDir`-synced settings (its severity is substantially reduced as a side effect of fix #1 above — a malicious synced pattern can no longer hang the thread, only mildly annoy — but full re-validation-on-load is still open).

## Data Model

No changes to `GitHubSyncSettings` (`excludePatterns`/`includePatterns` stay `string[]`, unchanged). No changes to `FileMetadata`. This plan is a pure bugfix — no new settings, no new metadata fields.

## `src/sync-filters.ts` — Replace Backtracking Regex Matcher with Linear-Time Matcher

**Root cause of the ReDoS:** `globToRegExp("*a*a*a*a*a*a*a*a*a*a*a*ab")` compiles to `^[^/]*a[^/]*a[^/]*a...ab$` — a classic catastrophic-backtracking shape. JS's regex engine explores exponentially many ways to divide the input among the `[^/]*` wildcards when the input doesn't cleanly match. This is a property of the *engine* (backtracking regex), not of any specific escaping bug — no amount of tweaking `GLOB_SPECIAL_CHARS_REGEXP` fixes it. The matcher itself must not use backtracking regex.

**New design — two layers, both non-backtracking:**

1. **Per-segment star matching** (handles `*` within one `/`-delimited segment — this is what the confirmed PoC pattern exploited, since the whole pathological pattern was one segment with no `/` at all):

   ```ts
   // Classic two-pointer "star bookmark" algorithm (same family as LeetCode
   // "Wildcard Matching"), NOT recursion, NOT backtracking regex. Worst-case
   // O(len(text) * len(pattern)) -- polynomial, never exponential, because
   // each retry strictly advances a monotonic bookmark index; there is no
   // path that revisits the same (patternIndex, textIndex) pair twice.
   function matchSegment(patternSegment: string, textSegment: string): boolean {
     let pIdx = 0, tIdx = 0;
     let starPIdx = -1, starTIdx = -1;
     while (tIdx < textSegment.length) {
       if (pIdx < patternSegment.length && patternSegment[pIdx] === "*") {
         starPIdx = pIdx; starTIdx = tIdx; pIdx++;
       } else if (
         pIdx < patternSegment.length &&
         patternSegment[pIdx] === textSegment[tIdx]
       ) {
         pIdx++; tIdx++;
       } else if (starPIdx !== -1) {
         pIdx = starPIdx + 1; starTIdx++; tIdx = starTIdx;
       } else {
         return false;
       }
     }
     while (pIdx < patternSegment.length && patternSegment[pIdx] === "*") pIdx++;
     return pIdx === patternSegment.length;
   }
   ```

   (Sketch for a cold-start implementer — adjust variable names/style to match the file's conventions. Literal non-`*` characters must compare exactly, case-sensitive, no regex-special-char escaping needed since there's no regex involved anymore.)

2. **Segment-sequence matching for `**`** (handles `**` spanning zero or more whole `/`-delimited segments, plus the existing trailing-`/` = directory-match rule):

   ```ts
   // Split both pattern and path on "/". Match segment arrays where a "**"
   // token may consume zero or more whole segments. Use a small DP table
   // (boolean[patternSegs.length+1][pathSegs.length+1]) instead of naive
   // recursion, so even many "**" tokens stay bounded at
   // O(patternSegs.length * pathSegs.length) -- trivially small since
   // realistic path/pattern segment counts are tens, not thousands.
   ```

   Trailing-slash directory semantics (Test Scenario 3 from the original plan) fold into this layer: a pattern ending in `/` matches if the path's segment sequence starts with the pattern's segments followed by anything (equivalent to appending an implicit `**` after the trailing `/`).

3. **`isExcludedPath(filePath, excludePatterns, includePatterns)` keeps its exact public signature** — `matchesAny()`'s per-pattern try/catch, blank-pattern filtering, and the exclude-then-include-override logic (`matchesAny(exclude) && !matchesAny(include)`) are unchanged. Only the internals of "does this one pattern match this one path" change from regex-based to the two-layer matcher above. The try/catch around each pattern match stays (a pattern that somehow still throws — e.g. a future pattern syntax addition — must not abort the whole check), but it is no longer the *only* thing standing between a bad pattern and a hang, since the new matcher has no exponential path at all.

4. **`globToRegExp` is removed.** The existing `src/sync-filters.test.ts` tests titled `describe("globToRegExp", ...)` (calling `globToRegExp(pattern).test(path)`) get rewritten to call the new internal matcher directly with the same behavioral assertions (same inputs/outputs, different call shape — this is a behavior-preserving internal refactor, not a semantic change). No other file in the codebase imports `globToRegExp` (confirmed via `grep -rln "globToRegExp" src/` during the original QA pass — only `sync-filters.ts` and its own test file reference it).

## `src/sync-manager.ts` — Manifest Guard + Syncing Guard

5. **`removeExcludedFromMetadata()`** — replace the direct `isExcludedPath(matchPath, ...)` call with `this.shouldSkipFile(matchPath)`:

   ```ts
   async removeExcludedFromMetadata() {
     if (this.syncing) {
       await this.logger.info("Skipping excluded-metadata cleanup: sync in progress");
       return;
     }
     let changed = false;
     Object.keys(this.metadataStore.data.files).forEach((filePath: string) => {
       const fileMetadata = this.metadataStore.data.files[filePath];
       const matchPath = fileMetadata.localPath ?? filePath;
       if (this.shouldSkipFile(matchPath)) {
         delete this.metadataStore.data.files[filePath];
         changed = true;
       }
     });
     if (changed) {
       await this.logger.info("Removed excluded files from metadata");
       await this.metadataStore.save();
     }
   }
   ```

   `shouldSkipFile()` already special-cases the manifest path (`return false` before checking volatile-artifact/exclude-pattern status — see the original plan's Deviations table) and already checks `isExcludedPath` with the current settings — so this single-line-body swap fixes the manifest bug AND keeps the method behaviorally identical for every other tracked file. Folding in `isVolatileSyncArtifact` (part of `shouldSkipFile`) is harmless: volatile artifacts are already stripped elsewhere every sync, so this is idempotent, not a new side effect.

   **`this.syncing` early-return is safe to skip cleanup on:** the pattern was already saved to `settings.excludePatterns`/`includePatterns` by the caller (`tab.ts`'s `onPatternsChanged`) regardless of whether this method runs. The next call to `removeExcludedFromMetadata()` (next keystroke, or next settings change) will catch up. In the meantime, the in-flight `sync()`'s own `determineSyncActions()` already independently filters excluded files (from the original plan's step 5) — so nothing is lost, only metadata bookkeeping lags by at most one sync cycle.

## `src/settings/tab.ts` — Debounce Per-Keystroke Reconciliation

6. **Debounce only the `removeExcludedFromMetadata()` call inside `onPatternsChanged`, NOT `saveSettings()`.** Settings must still persist to disk immediately on every keystroke (unchanged behavior — no data loss risk if the user closes Obsidian mid-typing); only the expensive full-metadata-store rescan gets debounced:

   ```ts
   private metadataCleanupTimer: number | undefined;

   private scheduleMetadataCleanup() {
     if (this.metadataCleanupTimer !== undefined) {
       window.clearTimeout(this.metadataCleanupTimer);
     }
     this.metadataCleanupTimer = window.setTimeout(async () => {
       await this.plugin.syncManager.removeExcludedFromMetadata();
     }, 400);
   }
   ```

   In `renderPatternList`'s row `onChange`: keep `patterns[index] = value; await this.plugin.saveSettings();` immediate (unchanged), replace the direct `await this.plugin.syncManager.removeExcludedFromMetadata()` call with `this.scheduleMetadataCleanup()` (fire-and-forget, not awaited, since it's now deferred).

   In the delete-button `onClick`: **keep the call immediate, not debounced** — clicks are discrete, not rapid-fire like typing, and there's no perf concern to fix there. Call `await this.plugin.syncManager.removeExcludedFromMetadata()` directly as before (unchanged).

   **Accepted risk:** if the user closes the Obsidian settings tab (or the app) within the 400ms debounce window after their last keystroke, that scheduled cleanup never fires. Non-destructive — the affected file(s) simply stay tracked one sync cycle longer than ideal; the next regular sync's `determineSyncActions()` filters them out of any actual upload/download action regardless (per the original plan's step 5), so this is a bookkeeping lag, not a correctness or data-loss issue. Not worth a `beforeunload`-style flush for this magnitude of risk.

## Open Questions

- [x] **Debounce delay value:** 400ms confirmed. — CONFIRMED 2026-07-05 (`confirmed-both`).
- [x] **`matchSegment`/DP-table implementation detail:** treat as "implement an algorithm meeting this complexity bound and these test scenarios," matching `sync-filters.ts`'s existing style/naming conventions — not a literal patch. — CONFIRMED 2026-07-05 (`confirmed-both`).

## Test Scenarios

1. **ReDoS regression, the exact confirmed PoC:** `isExcludedPath("a".repeat(32), ["*a*a*a*a*a*a*a*a*a*a*a*ab"], [])` returns `false`, and the call **completes in well under 100ms** (wall-clock assertion — this is the entire point of the fix; the old engine took 4.2s on this exact input).
2. **Behavior-preserving regression — every Test Scenario from the original `plan-exclude-patterns.md` must still pass verbatim** against the new matcher: `**` matches any depth (1), single `*` doesn't cross a segment boundary (2), trailing-slash directory match (3), blank-pattern filtering (4), never-throws on a pathological *string* — as opposed to never-*hangs*, which is this plan's new contract (5), include-override semantics 5a-5e, manifest precedence via `isSyncable()`/`determineSyncActions()` (6 — already correct pre-this-plan, just re-verify no regression), `EventsListener.isSyncable()` (7), `determineSyncActions()` (8), ZIP extraction (9).
3. **Manifest guard, the exact confirmed bug:** with `settings.excludePatterns = ["**/*.json"]`, `settings.includePatterns = []`, and `metadataStore.data.files` containing an entry keyed at `${vault.configDir}/${MANIFEST_FILE_NAME}`, calling `removeExcludedFromMetadata()` must leave that entry in place (not deleted).
4. **`this.syncing` guard:** `removeExcludedFromMetadata()` called with `(syncManager as any).syncing = true` returns immediately — no entries deleted, `metadataStore.save()` not called.
5. **`this.syncing` regression guard:** `removeExcludedFromMetadata()` called with `syncing = false` behaves exactly as the original plan's Test Scenario 10 (deletes matching entries, non-destructive to physical files, saves only when something changed).
6. **Debounce, onChange path:** simulate several rapid keystrokes into a pattern row (fake timers); `removeExcludedFromMetadata()` must fire at most once, only after the debounce window elapses following the *last* keystroke — not once per keystroke.
7. **Debounce does NOT apply to delete:** clicking a row's delete button calls `removeExcludedFromMetadata()` immediately (synchronously scheduled within the same tick, not deferred by the debounce timer) — regression guard for the unchanged delete path.
8. **`saveSettings()` is never debounced:** even while a metadata-cleanup call is pending in the debounce window, every keystroke still calls `saveSettings()` immediately (settings persistence must never lag, only the metadata rescan may).

## Edge Cases

| Case | Expected Behavior | Update feature doc? |
|---|---|---|
| The exact confirmed PoC pattern (`*a*a*a*a*a*a*a*a*a*a*a*ab`) against a 32-char non-matching path | Returns `false`, completes in well under 100ms (was 4.2s) | yes |
| Compound pathological case: many `**` tokens combined with many `*` within segments | Still bounded — `**` dimension is DP over segment *counts* (small, tens not thousands), `*` dimension is the linear per-segment matcher; product of two small/linear bounds stays small | no |
| Manifest path with no `localPath` override, pattern `**/*.json` | `shouldSkipFile(matchPath)` returns `false` for the manifest — guard applies via the direct filePath comparison already inside `shouldSkipFile` | yes |
| `removeExcludedFromMetadata()` triggered mid-sync (`this.syncing === true`) | Skipped this call; caught up on the next call or naturally filtered by the in-flight sync's own `determineSyncActions()` — no data loss, only a bookkeeping lag | yes |
| User closes settings tab/app within the 400ms debounce window after last keystroke | Scheduled cleanup never fires; non-destructive, same bookkeeping-lag reasoning as above | yes |
| Delete-button click while a debounced onChange cleanup is still pending | Delete's immediate call and the pending debounced call may both eventually run `removeExcludedFromMetadata()` — idempotent, no conflict, just a harmless redundant rescan | no |

## Deviations

Baseline: clean (89 tests passing, 9 test files) — `npm run test -- --run`, captured 2026-07-05 before any implementation.

Final run: 94/94 passing (10 test files) — `npm run test -- --run`. `npx tsc -noEmit -skipLibCheck` clean. `npm run build` (production esbuild) succeeds. Directly re-confirmed both blockers fixed: exact PoC pattern (`*a*a*a*a*a*a*a*a*a*a*a*ab` vs 32-char input) now takes 0ms (was 4.2s); `removeExcludedFromMetadata()` no longer deletes the manifest entry under `**/*.json`.

| Deviation | Reason | Update feature doc? |
|---|---|---|
| Extracted `scheduleMetadataCleanup()` as a standalone testable method rather than an inline closure inside `onChange` | Lets the debounce mechanism itself be unit-tested with fake timers, with zero Obsidian `Setting`-builder mocking needed (it's a plain method on the class, not DOM-building code) — sidesteps the testing-infrastructure gap noted in the original build for everything else in `tab.ts`. Not in the plan's literal code sketch but same intent. | no |
| Renamed the shared `onPatternsChanged` closure to `onPatternDeleted`, scoped only to the delete-button path | Once `onChange` stopped calling the shared closure (debounced separately), the name `onPatternsChanged` no longer described what it did — it's now delete-only. Naming fix, no behavior change. | no |
| `metadataCleanupTimer` field typed as `number` (not `ReturnType<typeof window.setTimeout>`) | `@types/node`'s global `setTimeout` ambient declaration shadowed the DOM lib's `window.setTimeout` return type inference, causing a real typecheck error (`Type 'number' is not assignable to type 'Timeout'`) — this project already runs in a browser/Obsidian context where `window.setTimeout` always returns `number`, so the explicit type is correct, not a workaround. | no |

## Impact / Affected Areas

Single feature: `sync`. Same 2 files as the original build (`src/sync-filters.ts`, `src/sync-manager.ts`) plus `src/settings/tab.ts` for the debounce. No new files, no composite needed.

**No separate `iris-0b-check-impact` was run.** The QA Sweep in `.knowledge/features/sync/plans/plan-exclude-patterns.md` § `## QA Sweep` § `### Critique` already IS the risk analysis for this follow-up — it was produced by a 4-angle parallel critique (security, ux, perf, error-handling) plus a main-thread plan-conformance pass, with the 2 blocker findings independently confirmed via live reproduction (not just static reading). This plan implements fixes for: both blockers, and 2 of the perf-angle majors (`this.syncing` race, per-keystroke debounce). Referenced, not duplicated, per Iron Law.

## QA Sweep

### Header

```
Runtime: CLI/API-equivalent (override — same reasoning as the original build's QA sweep)
FE detection: package.json has react/react-dom (naive heuristic says FE) — overridden.
  src/settings/tab.ts is touched again this round (debounce wiring), but it's still
  Obsidian's imperative Setting-builder API, not React, and there is no browser-navigable
  app for Playwright to launch.
Critique mode: single-sweep (files: 6, lines: 241, threshold: 10/500 default — both under)
Scenarios: happy 4 / edge 6 / negative 3
Critique: blocker 0 / major 0 / minor 2 / nit 2
Pipeline order: pre-doc-sync (iris-4-sync-docs has not run for this plan yet;
  status: done here just means the build/iris-2 pass is complete)
```

### Taxonomy N/A

| Entry | Reason | Confirm? |
|---|---|---|
| network-fail | No network calls touched by this diff | auto-confirmed |
| auth-fail | No auth/token logic touched | auto-confirmed |
| permission | No filesystem-permission surface changed — pure in-memory matcher + timer logic | auto-confirmed |
| i18n | No new user-facing strings — this diff has zero visible UI change (confirmed: no template/DOM edits in the `tab.ts` diff hunk, only internal method wiring) | **needs human confirm** (FE diff — `tab.ts` touched) |
| a11y | No new DOM elements or visual change — same reasoning as i18n above | **needs human confirm** (FE diff — `tab.ts` touched) |
| slow-network | No network I/O dependent on latency | auto-confirmed |

`boundary`, `empty`, `max`, `concurrent` are all applicable — see Scenario Matrix below.

### Scenario Matrix

| # | Family | Scenario | Source | Expected | Status |
|---|---|---|---|---|---|
| H1 | happy | Exact confirmed ReDoS PoC pattern vs 32-char input | plan Test Scenario 1 | Returns `false`, completes in well under 100ms | ✅ automated, passes (0ms measured, both in-suite and via direct repro) |
| H2 | happy | Manifest entry survives `removeExcludedFromMetadata()` under a matching pattern | plan Test Scenario 3 | Manifest entry not deleted | ✅ automated, passes |
| H3 | happy | `this.syncing === true` → `removeExcludedFromMetadata()` no-ops | plan Test Scenario 4 | No mutation, no `save()` call | ✅ automated, passes |
| H4 | happy | Rapid keystrokes debounce into one `removeExcludedFromMetadata()` call | plan Test Scenario 6 | Fires once, 400ms after the last call | ✅ automated, passes (fake timers) |
| E1 | edge (max) | Compound pathological pattern: many `**` tokens combined with many `*` within a segment | plan Edge Cases row 2 | Still bounded, fast | ⚠️ **not in the automated suite** — manually verified live during this QA pass (0ms on a crafted compound pattern) — see Run Results |
| E2 | edge (boundary/empty) | Every original Test Scenario (1-9) from `plan-exclude-patterns.md` still passes verbatim against the new matcher | plan Test Scenario 2 | No regression | ✅ automated, passes — these tests were left completely untouched in the diff and are still green in the final 94/94 run |
| E3 | edge (concurrent) | `this.syncing` guard — covered by H3 | plan Test Scenario 4/5 | See H3 | ✅ (same as H3) |
| E4 | edge (concurrent) | Residual race: a `sync()` that starts during `removeExcludedFromMetadata()`'s pending `metadataStore.save()` await | discovered during this QA pass, not in the plan | Undefined — narrower than the original bug but not fully closed | ❌ **not covered** — see Critique (minor) |
| E5 | edge | Debounce timer (`this.metadataCleanupTimer`) persists correctly across a `this.display()` redraw (instance field, not DOM state) | reasoned from code structure | Timer survives redraw | ⚠️ **not exercised** — correct by inspection, not verified live (no real-Obsidian-runtime available) |
| E6 | edge | Settings tab/app closed within the 400ms debounce window | plan Edge Cases row 5 | Scheduled cleanup never fires; accepted, non-destructive risk by design | N/A — intentionally not fixed, not a bug to test |
| N1 | negative | Delete-button click stays immediate, not debounced | plan Test Scenario 7 | `removeExcludedFromMetadata()` called synchronously on click | ⚠️ code-verified only (`testing_gaps` — same Obsidian `Setting`-mock limitation as the original build) |
| N2 | negative | `saveSettings()` never debounced, even mid-cleanup-window | plan Test Scenario 8 | Persists every keystroke regardless of pending cleanup | ⚠️ code-verified only (same limitation) |
| N3 | negative | `matchesAny`'s try/catch around the new matcher — does anything still throw? | discovered during this QA pass | Should never throw (no regex left at all) | ✅ manually verified — see Run Results (try/catch is now defensive-only, unreachable in practice) |

### Coverage Gaps

1. **Compound pathological pattern (E1)** never automated — only manually verified once during this QA pass, not committed as a repeatable test. Recommend adding it alongside the existing ReDoS regression test in `sync-filters.test.ts` in a future pass.
2. **Debounce timer survival across `this.display()` redraw (E5)** never exercised live — correct by code inspection (instance field, not DOM-scoped), but not proven under a real redraw.
3. **Test Scenarios 7 & 8 (N1, N2)** — same `testing_gaps` limitation carried over from the original build: wiring inside `renderPatternList`'s actual `onChange`/`onClick` handlers needs an Obsidian `Setting`-builder mock that doesn't exist in this codebase. `scheduleMetadataCleanup()` itself IS unit-tested in isolation (that part doesn't need the mock).
4. **Residual concurrency race (E4)** — found during this QA pass, not in the original plan's scope, never exercised by any test (would require orchestrating two concurrent async call stacks with a controlled await-ordering, more involved than a quick fix).
5. **No real-Obsidian-runtime verification** that the debounce actually removes the per-keystroke jank a user would feel — same class of gap as the original build (manual checklist in `.knowledge/features/sync/qa/exclude-patterns/scenarios.md` still applies, M6 in particular).

### Critique

No blockers, no majors this round — this was a focused bugfix pass and it holds up. 2 minor, 2 nit.

| Severity | Angle | File:line | Finding | Suggested fix |
|---|---|---|---|---|
| minor | security/perf | `src/sync-filters.ts` (`matchesGlobPattern`, `matchSegmentSequence`) | No explicit cap on pattern length before DP-table allocation. The new matcher is polynomial (`O(patternSegments × pathSegments)`), never exponential — verified via direct repro on both the single-segment PoC and a compound `**`-heavy case (both 0ms) — but a user could still paste an extremely long pattern (thousands of chars) into the settings UI with no length limit, and this cost is paid repeatedly (once per tracked file, every sync). Low severity: realistic hand-typed patterns are short, and even a worst-case pathological length only costs a few ms/MB, not a hang. | Add a soft length cap (e.g. reject/warn on patterns over ~500 chars) in the settings UI input validation — a UX decision, not urgent. |
| minor | concurrency | `src/sync-manager.ts` (`removeExcludedFromMetadata`) | The `this.syncing` guard checks at entry, and the delete loop itself is fully synchronous (JS single-threaded — no interleaving possible mid-loop), but there's a narrow window: a `sync()` could start and set `this.syncing = true` while this method's own trailing `await this.metadataStore.save()` is still pending, since that's the one `await` point after the guard check. This is a much narrower race than the pre-fix fully-unguarded version, and any resulting interleaving is idempotent/harmless (same "redundant rescan" class of risk the plan's own Edge Cases table already accepts elsewhere) — not a data-loss path. | Optional hardening: re-check `this.syncing` immediately before the `save()` call too, or have `sync()` itself await any in-flight `removeExcludedFromMetadata()` promise before proceeding. Low priority given the harmless failure mode. |
| nit | error-handling | `src/sync-filters.ts` (`matchesAny`'s try/catch around `matchesGlobPattern`) | The try/catch is no longer reachable in practice — the new matcher is pure string/array indexing with no regex compilation, so nothing in the current call path can throw. This is fine (the plan explicitly kept it "in case a future pattern syntax addition still throws," a reasonable forward-looking hedge), but worth flagging so a future reader doesn't assume it's currently load-bearing. Also worth noting: this side effect **fully resolves** the original QA round's minor error-handling finding about `?` causing a regex `SyntaxError` — there's no regex-escaping logic left at all now, so that entire bug class is structurally eliminated, not just patched (directly verified — see Run Results). | None needed now — just a note for future maintainers. |
| nit | plan-conformance | `plan-fix-exclude-patterns-qa-findings.md` § `## Deviations` | The Deviations row "Extracted `scheduleMetadataCleanup()` as a standalone testable method rather than an inline closure" slightly mischaracterizes itself — the plan's own step-6 code sketch (line ~125) already specified it as a private method, not an inline closure. The only actual deviation is that it got its own dedicated unit test (a testing choice, not a code-structure deviation). No functional impact, just a documentation-accuracy nit. | Reword the Deviations row to say "added dedicated unit test coverage" rather than implying a structural deviation from the plan's sketch. |

### Run Results

Command: `npm run test -- --run`
Run at: 2026-07-05
Result: 94/94 passing (10 test files), 0 failures.

Command: direct re-verification of both fixed blockers (ad-hoc `npx tsx` scripts):
```ts
// ReDoS — exact confirmed PoC
matchesGlobPattern("*a*a*a*a*a*a*a*a*a*a*a*ab", "a".repeat(32)); // 0ms (was 4.2s pre-fix)

// Compound pathological case (E1, not in the automated suite)
matchesGlobPattern("**/plugins/*a*a*a*a*a*a*a*a*a*a*a*ab/**/main.js",
  ".obsidian/plugins/" + "a".repeat(32) + "/nested/deep/path/main.js"); // 0ms

// Manifest guard
isExcludedPath(".obsidian/github-sync-metadata.json", ["**/*.json"], []); // still true
// (expected -- the guard lives in shouldSkipFile(), not isExcludedPath() itself;
//  removeExcludedFromMetadata() now routes through shouldSkipFile(), confirmed by
//  the passing "never deletes the manifest entry" test)

// Round-1 finding closure check (N3): "?" no longer throws, no regex left at all
isExcludedPath("x/main.js", ["?", "**?foo"], []); // false, no exception
```
Run at: 2026-07-05. Result: all confirmed as expected.

Manual (non-automatable) scenarios: E1, E5, N1, N2 above — see Coverage Gaps. No new manual runbook file needed this round (small, focused diff; existing `.knowledge/features/sync/qa/exclude-patterns/scenarios.md` M6/M7 from the original sweep still cover the relevant real-Obsidian-runtime checks).
