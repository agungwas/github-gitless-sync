---
status: done
testing: none
created: "2026-06-18"
completed: "2026-06-18"
qa: done
qa_completed: "2026-06-18"
follow_up: pending
---

# Plan: Fix EventsListener localPath Key Mismatch

## Goal

Fix ghost-entry bug and broken metadata tracking in `EventsListener` for files with sanitized `localPath`. When a file is downloaded with an illegal-char name (e.g. `"foo >.md"` → disk `"foo ＞.md"`), Obsidian fires events for the disk path but metadata is keyed by the remote path. Direct key lookup fails → ghost entries, wrong entries marked dirty/deleted.

## Approach

**Chosen: Option C — `resolveMetadataKey()` reverse-lookup helper in `EventsListener`.**

Add a private helper that first tries direct key lookup, then falls back to searching for an entry whose `localPath` matches the given path. Apply in `onCreate`, `onModify`, `onDelete`. `onRename` benefits automatically since it calls `onDelete` and `onCreate`.

**Rejected:** Option B (inline `renameFrom` field) — adds metadata schema complexity for negligible gain on a markdown-only vault. Option C+ (remote filename sanitization on upload) — out of scope for this fix.

**Affected features:** `sync`, `file-validation` (side-effect — ghost entry bug fixed).

## Implementation Steps

### Step 1 — Add `resolveMetadataKey()` helper to `EventsListener`

In `src/events-listener.ts`, add private method after the constructor:

```ts
private resolveMetadataKey(filePath: string): string {
  if (this.metadataStore.data.files[filePath]) {
    return filePath;
  }
  const entry = Object.entries(this.metadataStore.data.files).find(
    ([, meta]) => meta.localPath === filePath
  );
  return entry ? entry[0] : filePath;
}
```

O(n) over metadata entries — acceptable for typical vault sizes. Called only on FS events.

### Step 2 — Update `onCreate` to use resolved key

Replace direct `this.metadataStore.data.files[file.path]` lookup with resolved key for the `justDownloaded` check. New entry (user-created file) still writes at `file.path`.

```ts
private async onCreate(file: TAbstractFile) {
  if (!this.isSyncable(file.path)) { ... return; }
  if (file instanceof TFolder) { return; }

  const resolvedKey = this.resolveMetadataKey(file.path);
  const data = this.metadataStore.data.files[resolvedKey];
  if (data && data.justDownloaded) {
    this.metadataStore.data.files[resolvedKey].justDownloaded = false;
    await this.metadataStore.save();
    await this.logger.info("Updated just downloaded created file", file.path);
    return;
  }

  // Brand new file — create entry at file.path as before
  this.metadataStore.data.files[file.path] = { ... };
}
```

### Step 3 — Update `onModify` to use resolved key

Replace direct lookup with `resolveMetadataKey(file.path)`. Apply resolved key for `justDownloaded` check and for setting `lastModified` / `dirty`.

### Step 4 — Update `onDelete` to use resolved key

After extracting `filePath`, resolve: `const resolvedKey = this.resolveMetadataKey(filePath)`. Use `resolvedKey` for the `!this.metadataStore.data.files[resolvedKey]` guard and for setting `deleted`/`deletedAt`. Keep `isSyncable(filePath)` check on the original path (disk path is what was deleted).

`onRename` calls `onDelete(oldPath)` → benefits automatically.

## Open Questions

None.

## Deviations

Baseline: testing:none — existing suite 41 tests green. Command: `npm run test`.
Final run: 41/41 passing. No regressions.

| What changed | Why | Update feature doc? |
|---|---|---|
| Used `Object.keys(...).find()` instead of `Object.entries()` in `resolveMetadataKey` | `Object.entries` not in lib ES6 tsconfig; `Object.keys` + index lookup achieves same result | no |
| Added `TAbstractFile`, `TFile`, `TFolder` classes to `vitest.setup.ts` | These Obsidian types were missing from mock — required for any EventsListener test to pass `instanceof` checks | no |

## QA Sweep

### Header
Runtime: CLI/API — unit test via vitest (non-FE, no Playwright)
Scenarios: H5 / E2 / N2
Critique: blocker 0 / major 0 / minor 1 / nit 0
Pipeline order: pre-iris-5
Critique mode: single-sweep (files: 1, lines: 33, threshold: 10/500)

### Taxonomy N/A
| Entry | Reason | Confirm? |
|---|---|---|
| boundary | no numeric limits | auto-confirmed |
| max | no size constraints | auto-confirmed |
| network-fail | no network calls in EventsListener | auto-confirmed |
| auth-fail | no auth logic | auto-confirmed |
| permission | no permission checks | auto-confirmed |
| i18n | no user-facing strings | auto-confirmed |
| a11y | non-FE diff | auto-confirmed |
| slow-network | no network | auto-confirmed |
| concurrent | see E2, E3 in matrix | applicable |

### Scenario Matrix
| # | Family | Scenario | Source | Expected |
|---|---|---|---|---|
| H1 | happy | Normal file created by user | plan Step 2 | `metadata[file.path]` created with `sha:null, dirty:true` |
| H2 | happy | Sanitized file create event: `justDownloaded` cleared, no ghost | plan Goal | `metadata["foo >.md"].justDownloaded=false`; no `metadata["foo ＞.md"]` |
| H3 | happy | Normal file modified | plan Step 3 | `dirty=true`, `lastModified` updated on correct key |
| H4 | happy | Sanitized file modified after download | plan Step 3 | `metadata["foo >.md"].dirty=true`; no crash |
| H5 | happy | Normal file deleted | plan Step 4 | `metadata["foo.md"].deleted=true` |
| H6 | happy | Sanitized file deleted | plan Step 4 | `metadata["foo >.md"].deleted=true`; not ghost |
| H7 | happy | Sanitized file renamed `"foo ＞.md"→"bar.md"` | plan Step 4 + onRename | `metadata["foo >.md"].deleted=true`; `metadata["bar.md"]` created |
| E1 | edge | Empty metadata on create | edge-taxonomy: empty | No crash; new entry created at `file.path` |
| E2 | edge | Two create events for same sanitized file | edge-taxonomy: concurrent | `justDownloaded` cleared idempotently; no ghost |
| E3 | edge | Two concurrent modify events for sanitized file | edge-taxonomy: concurrent | Both find same `resolvedKey`; last write wins; MetadataStore queue serializes saves |
| N1 | negative | Modify event for file not in metadata | plan (pre-existing) | TypeError on line 125 — pre-existing bug, not regressed |
| N2 | negative | Delete event for untracked file | plan Step 4 | Early return, no crash |
| N3 | negative | Rename for non-syncable paths | EventsListener.isSyncable | No metadata changes |

### Critique
| Severity | Angle | File:line | Finding | Suggested fix |
|---|---|---|---|---|
| minor | error-handling | `src/events-listener.ts:125` | `onModify` crashes with TypeError if `metadata[resolvedKey]` is undefined (file not tracked yet — e.g. modify fires before create in some edge cases). Pre-existing before this PR; `resolveMetadataKey` fallback to `file.path` preserves prior behavior. | Add guard: `if (!this.metadataStore.data.files[resolvedKey]) return;` before line 125 |
| nit | plan-conformance | `src/events-listener.ts:160` | `resolveMetadataKey` placed AFTER `onRename` in file — plan said "after the constructor". Functionally identical; just order preference. | No action needed |

### Run Results
Command: `npm run test -- --reporter=verbose`
Run at: 2026-06-18
Result: 47/47 passing (41 baseline + 6 new QA scenarios H2, H4, H6, H7, E1, N2)
QA scenarios file: `.knowledge/features/sync/qa/plan-fix-events-localpath-lookup/scenarios.md`
QA verify script: `.knowledge/features/sync/qa/plan-fix-events-localpath-lookup/verify.test.ts`
