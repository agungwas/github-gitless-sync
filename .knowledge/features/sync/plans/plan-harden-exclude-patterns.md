---
status: done
completed: "2026-07-05"
slug: harden-exclude-patterns
created: "2026-07-05"
testing: tdd
---
# Plan: Harden Exclude-Patterns Against the 2 Remaining Minor QA Findings

## Approach

**Rough change (UI/system):** System only — absurdly long patterns are now silently ignored (never match anything) instead of costing repeated DP-allocation time/space; the residual race between a settings-triggered metadata cleanup and an in-flight sync is now fully closed, not just narrowed.

**Chosen: Option C — split treatment**, from `.knowledge/features/sync/plans/plan-fix-exclude-patterns-qa-findings.md` § `## QA Sweep` § `### Critique` (the QA sweep for that build; this plan does not redo that analysis):

1. **Pattern-length cap stays silent/internal** — `matchesAny()` in `src/sync-filters.ts` treats any pattern over a length threshold as non-matching, the same silent-failure class already used for blank patterns and (formerly) malformed regex patterns. No new UI surface.
2. **Race fully closed, not just narrowed** — `SyncManager` tracks its own in-flight `removeExcludedFromMetadata()` call as a promise; `sync()` and `firstSync()` both await it (if set) immediately after acquiring the `this.syncing` lock, before touching `metadataStore.data.files` themselves. This fully serializes the two code paths instead of shrinking the race window to a single microtask boundary.

Rejected alternatives (from Gate A):
- **Option A — minimal.** Same silent pattern-length cap, but the race fix is just a second `this.syncing` re-check immediately before `metadataStore.save()`. Smaller diff, but only narrows the race window (to one microtask boundary) rather than closing it — unsatisfying when full closure costs roughly the same amount of code (a promise field + one `await` at 2 call sites).
- **Option B — full UX treatment.** Same race fix as this plan, but surfaces the pattern-length cap in the settings UI (visible rejection/feedback) instead of silent internal handling. Rejected: this reopens the exact "UI validation is a product/UX design decision, not a bugfix" scope-creep concern that got the original plan's Option C (full sweep) rejected — what threshold reads well to a user, what the rejection message says, whether it's a hard block or a warning are all product calls, not just code. Also touches `settings/tab.ts` again, which already carries a known testing-infrastructure gap (no Obsidian `Setting`-builder mock in this codebase).

## Goal Pressure-Test Note (from Gate G)

Both findings are genuinely low-severity — the original QA report explicitly characterized their failure modes as harmless (an over-long pattern only costs a bounded amount of time/memory once per check, not a hang; the race's worst case is an idempotent redundant metadata rescan, not data loss or corruption). This plan is proactive hardening, not a response to an observed problem. Approved anyway (`goal-ok`) for the test coverage and deviation tracking a small proper plan gives, over a bare quick-patch.

## `src/sync-filters.ts` — Pattern-Length Cap

1. Add a named constant near the top of the file (alongside `SEGMENT_WILDCARD`/`DEEP_WILDCARD`):
   ```ts
   const MAX_PATTERN_LENGTH = 500;
   ```
   (500 chars mirrors the QA report's own suggested threshold — generous for any realistic hand-typed glob, small enough to bound worst-case DP-table cost.)

2. In `matchesAny()`, after the existing blank-pattern check, add a length check that treats an over-long pattern the same way — skip it, don't call `matchesGlobPattern` at all:
   ```ts
   function matchesAny(filePath: string, patterns: string[]): boolean {
     return patterns.some((pattern) => {
       const trimmed = pattern.trim();
       if (trimmed === "") return false;
       if (trimmed.length > MAX_PATTERN_LENGTH) return false;
       try {
         return matchesGlobPattern(trimmed, filePath);
       } catch {
         return false;
       }
     });
   }
   ```
   This applies identically to both `excludePatterns` and `includePatterns` (same `matchesAny` helper) — an over-long pattern in either list is silently inert: it can never exclude anything, and it can never protect anything via the include-override either. No special-casing needed between the two lists.

## `src/sync-manager.ts` — Close the Residual Race

3. Add a private field next to `metadataCleanupTimer`-style state (near the existing `syncing` field):
   ```ts
   private pendingMetadataCleanup: Promise<void> | null = null;
   ```

4. Split `removeExcludedFromMetadata()` into a public entry point (unchanged external behavior and signature) and a private worker that does the actual mutation, so the entry point can track the worker's promise:
   ```ts
   async removeExcludedFromMetadata() {
     if (this.syncing) {
       await this.logger.info("Skipping excluded-metadata cleanup: sync in progress");
       return;
     }
     const cleanup = this.performExcludedMetadataCleanup();
     this.pendingMetadataCleanup = cleanup;
     try {
       await cleanup;
     } finally {
       if (this.pendingMetadataCleanup === cleanup) {
         this.pendingMetadataCleanup = null;
       }
     }
   }

   private async performExcludedMetadataCleanup() {
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
   The `finally` block's identity check (`this.pendingMetadataCleanup === cleanup`) guards against a subtle ordering issue: if a second `removeExcludedFromMetadata()` call somehow started and replaced `pendingMetadataCleanup` with a newer promise before the first one's `finally` ran, the first call must not null out the *second* call's still-in-flight promise. In practice this can't happen today (the `this.syncing` early-return prevents overlapping calls from this method itself), but the guard costs nothing and removes a latent trap if that invariant ever changes.

5. In `sync()` (~line 440) and `firstSync()` (~line 94): immediately after `this.syncing = true;`, await any in-flight cleanup before doing anything else:
   ```ts
   this.syncing = true;
   if (this.pendingMetadataCleanup) {
     await this.pendingMetadataCleanup;
   }
   // ... existing try/await impl/... unchanged below this point
   ```
   Setting `this.syncing = true` *before* this await is deliberate: any `removeExcludedFromMetadata()` call arriving during the wait now sees `this.syncing === true` and skips immediately (via the existing guard from the prior plan), instead of piling up a second concurrent cleanup.

## Open Questions

- [x] **`MAX_PATTERN_LENGTH = 500`:** confirmed. — CONFIRMED 2026-07-05 (`confirmed-both`).
- [x] **Symmetric length cap on both `excludePatterns` and `includePatterns`:** confirmed as the right default. — CONFIRMED 2026-07-05 (`confirmed-both`).

## Test Scenarios

1. **Pattern over `MAX_PATTERN_LENGTH` in `excludePatterns`:** `isExcludedPath(path, [veryLongPattern], [])` returns `false` — the over-long pattern never excludes anything, silently.
2. **Pattern over `MAX_PATTERN_LENGTH` in `includePatterns`:** `isExcludedPath(path, ["**/main.js"], [veryLongPattern])` where the over-long pattern *would* otherwise have matched and overridden the exclude — still returns `true` (exclude wins; the over-long include is silently inert, never overrides).
3. **Boundary — pattern exactly at `MAX_PATTERN_LENGTH`:** still matches normally (off-by-one check: `length > MAX` rejects, `length === MAX` does not).
4. **Regression — realistic short patterns unaffected:** every existing `sync-filters.test.ts` case (all under the threshold by orders of magnitude) continues to pass unchanged.
5. **Race closure, `sync()` path:** with a controllable/delayed `metadataStore.save()` mock, start `removeExcludedFromMetadata()` (don't await its resolution yet), then call `sync()` — assert `sync()`'s own metadata-touching work does not begin until the pending cleanup's `save()` resolves.
6. **Race closure, `firstSync()` path:** same shape as (5), for `firstSync()` — regression/coverage for both entry points, since the original QA finding only examined `sync()`.
7. **No unnecessary blocking:** when `pendingMetadataCleanup` is `null` (no cleanup in flight), `sync()`/`firstSync()` proceed immediately with no added delay — regression guard.
8. **`pendingMetadataCleanup` clears after resolution:** after a cleanup completes, `this.pendingMetadataCleanup` is `null` again — a later, unrelated `sync()` call doesn't await a stale already-resolved promise (harmless either way, but verifies the `finally` block actually runs and nulls out correctly).

## Edge Cases

| Case | Expected Behavior | Update feature doc? |
|---|---|---|
| Pattern exactly `MAX_PATTERN_LENGTH` chars long | Matches normally — the cap is `>`, not `>=` | yes |
| Over-long pattern appears in both `excludePatterns` and `includePatterns` simultaneously | Both inert — behaves as if neither pattern existed for that check | no |
| `removeExcludedFromMetadata()` called twice in a row with no `sync()` in between | Second call's `this.syncing` check is unaffected (still false); both cleanups run sequentially since JS awaits each fully before the next call starts (no overlap in this codebase's call pattern) | no |
| `sync()` called when no cleanup is pending | No behavior change from before this plan — `pendingMetadataCleanup` is `null`, the `if` is skipped | no |
| `firstSync()` racing a pending cleanup, same as `sync()` | Same closure applies — both entry points now serialize identically against a pending cleanup | yes |

## Deviations

Baseline: clean (94 tests passing, 10 test files) — `npm run test -- --run`, captured 2026-07-05 before any implementation.

Final run: 101/101 passing (10 test files) — `npm run test -- --run`. `npx tsc -noEmit -skipLibCheck` clean. `npm run build` (production esbuild) succeeds.

| Deviation | Reason | Update feature doc? |
|---|---|---|
| Added `Notice.prototype.hide` stub polyfill to `sync-manager.test.ts` (mirrors the existing `Array.prototype.last`/`.contains` polyfill pattern) | Step 5's "no unnecessary blocking" test is the first test in this file to let `sync()` run all the way to its success path, which calls `notice.hide()` — the mocked `Notice` (`vi.fn()` in `vitest.setup.ts`) has no such method. Same class of test-infra gap as the earlier polyfills, not a production issue. | no |

## Impact / Affected Areas

Single feature: `sync`. Same 2 files as both prior rounds (`src/sync-filters.ts`, `src/sync-manager.ts`). No new files, no composite needed, no UI changes (so `settings/tab.ts` is untouched this round — unlike the previous plan).

**No separate `iris-0b-check-impact` was run.** The QA Sweep in `.knowledge/features/sync/plans/plan-fix-exclude-patterns-qa-findings.md` § `## QA Sweep` § `### Critique` already IS the risk analysis this plan responds to (2 minor findings, both independently reasoned through and confirmed low-severity during that QA pass). Referenced, not duplicated, per Iron Law.
