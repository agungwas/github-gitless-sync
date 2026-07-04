---
status: done
completed: "2026-07-05"
testing: tdd
created: "2026-06-18"
qa: done
qa_completed: "2026-07-05"
---

# Plan: Fix EventsListener Edge Cases (QA Follow-up)

## Goal

Address two minor findings from QA sweep of `plan-fix-events-localpath-lookup`:

1. **F1 — `onModify` TypeError**: if a file is not in metadata when `onModify` fires (rare: modify event before create event), `this.metadataStore.data.files[resolvedKey].lastModified` throws TypeError on undefined.
2. **F2 — Folder delete misses sanitized children**: the folder branch in `onDelete` checks `trackedPath.startsWith(folderPrefix)` against metadata keys only. If the folder's disk path is sanitized (e.g. `"folder ＞/"`) but metadata key is `"folder >/"`, children are never matched and remain non-deleted.

## Approach

**Chosen: Option A — fix both in `src/events-listener.ts` in one plan.**

F1: Add early-return guard before the `lastModified` / `dirty` writes in `onModify`.  
F2: In the folder delete branch, also check the file's `localPath` against `folderPrefix` in addition to the metadata key.

Both are ≤4 lines each. Same file. No schema change.

**Rejected:** Deferring F2 — the gap is now documented and fixing it while in scope is cheapest.

**Affected features:** `sync`, `file-validation` (side-effect — folder sanitization correctness).

## Implementation Steps

### Step 1 — F1: Guard in `onModify` for missing metadata entry

In `src/events-listener.ts`, after the `justDownloaded` block in `onModify` (currently line ~124), add:

```ts
if (!this.metadataStore.data.files[resolvedKey]) {
  return;
}
```

Before:
```ts
this.metadataStore.data.files[resolvedKey].lastModified = Date.now();
this.metadataStore.data.files[resolvedKey].dirty = true;
```

### Step 2 — F2: Check `localPath` in folder delete branch

In `onDelete`, inside the `file instanceof TFolder` branch, update the `forEach` filter to also match files whose `localPath` starts with `folderPrefix`:

```ts
// Before:
if (
  trackedPath.startsWith(folderPrefix) &&
  !this.metadataStore.data.files[trackedPath].deleted
)

// After:
const fileMeta = this.metadataStore.data.files[trackedPath];
const diskPath = fileMeta.localPath ?? trackedPath;
if (
  (trackedPath.startsWith(folderPrefix) || diskPath.startsWith(folderPrefix)) &&
  !fileMeta.deleted
)
```

## Test Scenarios

### Failure Verification

Test file: `src/events-listener.test.ts`

| Test | Expected pre-impl | Actual pre-impl |
|---|---|---|
| F1-T1: onModify untracked file no crash | resolves | rejects with `TypeError: Cannot set properties of undefined (setting 'lastModified')` ✅ |
| F1-T2: onModify tracked file updates dirty (regression) | passes | passes ✅ |
| F2-T3: sanitized folder delete marks children deleted | `deleted: true` | children NOT marked deleted ✅ |
| F2-T4: normal folder delete marks children deleted (regression) | passes | passes ✅ |

## Open Questions

None.

## Deviations

Baseline: clean (101 tests passing, 10 test files) — `npm run test -- --run`, captured 2026-07-05.

Final run: 101/101 passing (10 test files) — `npm run test -- --run`. `npx tsc -noEmit -skipLibCheck` clean.

| What changed | Why | Update feature doc? |
|---|---|---|
| No code changes made this session | Both fixes (F1 guard, F2 localPath check) and their tests (F1-T1..F2-T4 in `src/events-listener.test.ts`) already landed in commit `520dcb7` ("feat: converge illegal-char filenames on remote & fix events-listener type error/lookup bugs") — a prior session implemented this plan's steps but left the plan frontmatter at `status: approved` instead of marking it done. This run verified the implementation matches the plan exactly (line-for-line) and all 9 tests in the file pass, then closed the paperwork. | no |

## QA Sweep

### Header
Runtime: CLI/API Runbook (non-FE — this diff touches only `src/events-listener.ts`, no UI files; repo has `react` as a dependency but it's unused by this plan's scope)
Critique mode: single-sweep (files: 2, lines: 183, threshold: 10/500)
Scenarios: happy 2 / edge 1 / negative 1
Coverage gaps: 1 (minor, see below)
Pipeline order: pre-iris-5 — `iris-4-sync-docs` has not run for this plan yet (status was set to `done` directly by `iris-2-run-build` after discovering the implementation pre-existed; feature doc not yet reconciled)

### Taxonomy N/A
| Entry | Reason | Confirm? |
|---|---|---|
| max | no size/quantity limits relevant to event-handler guards | auto-confirmed |
| concurrent | no new shared async state; guards are synchronous checks before existing awaits | auto-confirmed |
| network-fail | no network calls in `events-listener.ts` | auto-confirmed |
| auth-fail | no auth logic in this file | auto-confirmed |
| permission | no filesystem-permission logic touched | auto-confirmed |
| a11y | non-FE diff, no UI | auto-confirmed |
| slow-network | no network involved | auto-confirmed |

### Scenario Matrix
| # | Family | Scenario | Source | Expected |
|---|---|---|---|---|
| H1 | happy | `onModify` on a tracked file still updates `dirty`/`lastModified` | plan Test Scenarios F1-T2 | fields update as before |
| H2 | happy | `onDelete` on a normal (non-sanitized) folder marks children deleted | plan Test Scenarios F2-T4 | children `deleted: true` |
| E1 | edge (boundary + i18n) | `onDelete` on a folder whose disk name was sanitized (`＞` vs remote `>`) marks children matched via `localPath` as deleted | plan Test Scenarios F2-T3 | children `deleted: true` |
| N1 | negative (boundary/empty) | `onModify` fires for a file with no metadata entry at all (modify-before-create ordering) | plan Test Scenarios F1-T1 | resolves without throwing, no metadata created |

### Coverage Gaps
| Gap | Why it matters | Severity |
|---|---|---|
| `onDelete` folder branch with zero tracked files in `metadataStore.data.files` (empty-metadata case) not explicitly tested | `Object.keys({}).forEach(...)` is a trivial no-op and clearly safe by inspection, but the taxonomy's `empty` entry has no dedicated test — differs from F2-T4 which always has ≥1 file | minor |

### Critique
| Severity | Angle | File:line | Finding | Suggested fix |
|---|---|---|---|---|
| minor | plan-conformance | src/events-listener.ts:75-78 | Plan's pseudocode OR'd `trackedPath.startsWith(folderPrefix) \|\| diskPath.startsWith(folderPrefix)`; shipped code only checks `actualLocalPath` (which falls back to `trackedPath` when `localPath` is unset). Functionally this is a deliberate simplification, not a regression — `folderPrefix` is always built from the disk path Obsidian hands to `onDelete`, so matching the remote-keyed `trackedPath` directly (as the plan's OR would) risks a false-positive match on any remote key that coincidentally shares the same string prefix as the disk folder, even when the file's real disk location differs. The shipped version's fallback already reproduces the OR's only correct case (no `localPath` present) and avoids the incorrect one. | No fix needed — confirm this reading and update the plan text (or note it as an intentional deviation) rather than "fixing" code to literally match the pseudocode |
| minor | error-handling | src/events-listener.ts:120 | `onModify`'s new guard (`if (!data) return;`) exits silently with no log line distinguishing "not tracked, skipped" from the generic "Received modify event" logged at the top of the function — makes this path indistinguishable from a normal early-syncable-check skip when reading logs | Optional: add `await this.logger.info("Skipped modify for untracked file", file.path);` before the return, mirroring the logging style used elsewhere in this file |
| nit | ux | src/events-listener.ts:69,79 | `folderPrefix` and `deletedAt` recomputed per top-level call but fine; no action needed | — |

### Run Results
Command: `npm run test -- --run src/events-listener.test.ts`
Run at: 2026-07-05 10:55
Result: 9/9 passed (all 4 plan scenarios + 5 pre-existing regression tests in the same file)

Command: `npm run test -- --run` (full suite)
Run at: 2026-07-05 10:52
Result: 101/101 passed, 10 test files
