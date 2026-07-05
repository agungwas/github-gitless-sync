---
status: done
completed: "2026-07-05"
slug: fix-syncconfigdir-remote-orphans
created: "2026-07-05"
testing: tdd
---
# Plan: Widen Remote-Orphan Cleanup to Cover `syncConfigDir`-Off Files

Follow-up to `plan-fix-preview-accuracy-and-delete-visibility.md`'s QA sweep (`act-on-critique`, 2026-07-05): fixes the 1 major finding — `computeExcludedRemoteOrphans()` filters via `shouldSkipFile()` only, which has no `syncConfigDir` awareness, so turning `syncConfigDir` off orphans previously-synced `.obsidian/*` files on GitHub forever (same bug class the pattern-exclude fix solved, reached via the toggle instead of a pattern).

## Approach

**Rough change (UI/system):** System only — turning `syncConfigDir` off and then running a sync now also deletes previously-synced configDir files from GitHub (on the next sync, same as pattern-driven exclusion), instead of silently leaving them there forever.

**Chosen (Gate G eliminated alternatives, `goal-ok` received — no Gate A needed): swap `computeExcludedRemoteOrphans()`'s filter predicate from `this.shouldSkipFile(filePath)` to `!this.isPathSyncable(filePath)`.** `isPathSyncable()` (added in `plan-fix-preview-accuracy-and-delete-visibility.md`) already strictly widens `shouldSkipFile()` with the `syncConfigDir` gate and the configDir dot-file skip — every path `shouldSkipFile()` used to catch is still caught (it's one of the OR'd conditions inside `isPathSyncable()`), so this is a pure widening, not a behavior change for existing pattern-driven orphans.

Eliminated at Gate G:
- **Duplicate the `syncConfigDir`/dot-file checks inline in `computeExcludedRemoteOrphans()`** instead of reusing `isPathSyncable()`. Rejected: identical duplication problem `plan-fix-preview-accuracy-and-delete-visibility.md`'s Fix #1 already rejected once (Option B there).
- **Widen `shouldSkipFile()` itself** instead of adding the check via `isPathSyncable()`. Rejected: `shouldSkipFile()` is called from other sites (`events-listener.ts`'s `isSyncable()`, `reconcileConfigDirFiles()`) that already have their own separate `syncConfigDir` checks — folding the same gate into `shouldSkipFile()` too risks double-negation bugs at those call sites (e.g. a site checking both `shouldSkipFile()` internally-widened AND its own external `syncConfigDir` check would double-apply the same gate).

## `src/sync-manager.ts` — Widen `computeExcludedRemoteOrphans()`'s Predicate

1. In `computeExcludedRemoteOrphans()`, change the filter chain from:
   ```ts
   return Object.keys(files)
     .filter((filePath) => filePath !== `${this.vault.configDir}/${MANIFEST_FILE_NAME}`)
     .filter((filePath) => this.shouldSkipFile(filePath))
     .map((filePath) => ({ type: "delete_remote", filePath }));
   ```
   to:
   ```ts
   return Object.keys(files)
     .filter((filePath) => filePath !== `${this.vault.configDir}/${MANIFEST_FILE_NAME}`)
     .filter((filePath) => !this.isPathSyncable(filePath))
     .map((filePath) => ({ type: "delete_remote", filePath }));
   ```
2. Update the method's doc comment (currently says "Finds paths that now match an exclude pattern...") to also mention the `syncConfigDir`/dot-file cases now covered, e.g. append: "Also catches paths orphaned by turning `syncConfigDir` off, or by a dot-prefixed configDir file — anything `isPathSyncable()` now says isn't synced."

## Open Questions

- [ ] None — Gate G already resolved approach + confirmed the swap is a strict widening with no regression risk.

## Test Scenarios

1. `computeExcludedRemoteOrphans()`: a configDir file (e.g. `.obsidian/plugins/foo/main.js`) present in the raw remote tree, with `syncConfigDir: false` and no matching exclude pattern, now produces a `delete_remote` action (previously produced none — this is the fix).
2. `computeExcludedRemoteOrphans()`: the same configDir file with `syncConfigDir: true` and a non-dot basename, no matching exclude pattern, produces NO action (still syncable).
3. `computeExcludedRemoteOrphans()`: a dot-prefixed configDir file (e.g. `.obsidian/plugins/foo/.hidden`) present in the tree, with `syncConfigDir: true`, produces a `delete_remote` action (new case, via `isPathSyncable()`'s dot-file gate).
4. `computeExcludedRemoteOrphans()`: existing pattern-driven case (a file matching `excludePatterns`, regardless of `syncConfigDir`) still produces a `delete_remote` action — regression check that the widening didn't drop the original behavior.
5. `computeExcludedRemoteOrphans()`: the manifest path present in the raw tree with `syncConfigDir: false` still produces NO action (pre-filtered before the predicate runs, unaffected by the swap).
6. `computeExcludedRemoteOrphans()`: a path matched by both `excludePatterns` and an overriding `includePatterns` entry still produces NO action, regardless of `syncConfigDir` (regression check — include-wins semantics unaffected by the widening).

## Edge Cases

| Case | Expected Behavior | Update feature doc? |
|---|---|---|
| `syncConfigDir` turned off with previously-synced configDir files on remote | Next sync emits `delete_remote` for each, removing them from GitHub | yes |
| `syncConfigDir` left on the whole time, some files excluded via patterns | Unchanged — pattern-driven orphan behavior identical to before this plan | no |
| User relies on old, unmanaged config files sitting on remote from before this feature existed, with `syncConfigDir` off | Those files WILL now be deleted on next sync — this is the intended fix, not a new risk beyond what QA already flagged | yes |
| Dot-prefixed file under configDir with `syncConfigDir` on | Now correctly orphan-deleted too (previously never was, since `shouldSkipFile()` didn't know about dot-files either) | yes |

## Deviations

Baseline: clean (120 tests passing, 10 test files) — `npm run test -- --run`, captured 2026-07-05 before any implementation.

Final run: 123/123 passing (10 test files) — `npm run test -- --run`. `npx tsc -noEmit -skipLibCheck` clean. `npm run build` (production esbuild) succeeds.

| What changed | Why | Update feature doc? |
|---|---|---|
| Added `syncConfigDir: true` to the existing "does not orphan a path matched by both exclude and include patterns" regression test's settings override | That test used a configDir-shaped path (`.obsidian/plugins/gitless/main.js`) with `syncConfigDir` defaulting `false` in the describe block. Under the widened predicate (this plan's whole point), that path is now correctly caught by the `syncConfigDir` gate regardless of the include-pattern override — matching `determineSyncActions()`'s own identical precedence (include only overrides exclude patterns, never the `syncConfigDir` toggle). Adding `syncConfigDir: true` isolates what the test actually meant to verify (pattern precedence) from the new orthogonal `syncConfigDir` dimension, per plan step 1's stated widening. Expected value (`[]`) unchanged — only the settings input was corrected. | no |

## Impact / Affected Areas

- `src/sync-manager.ts` — `computeExcludedRemoteOrphans()`'s filter predicate + doc comment.
- `src/sync-manager.test.ts` — new tests for the widened predicate (configDir + syncConfigDir off, dot-file case), regression tests for existing pattern-driven cases.
- `.knowledge/features/sync/README.md` — update once shipped: the "Settings-triggered metadata cleanup" section's description of `computeExcludedRemoteOrphans()`'s scope (currently says "matches an exclude pattern" only) needs widening to mention `syncConfigDir` + dot-file cases too.
