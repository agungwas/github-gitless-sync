---
status: approved
testing: tdd
created: "2026-06-18"
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

| What changed | Why | Update feature doc? |
|---|---|---|
| Baseline: | | |
