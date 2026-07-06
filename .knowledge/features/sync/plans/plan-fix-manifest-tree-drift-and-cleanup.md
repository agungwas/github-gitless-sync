---
status: in-progress
slug: fix-manifest-tree-drift-and-cleanup
created: "2026-07-07"
testing: tdd
testing_gaps:
  - "Steps 1-3 wiring inside syncImpl() (snapshot capture, determineSyncActions param swap, download-guard call site) has no dedicated new test — syncImpl() is a private orchestration method with zero direct tests anywhere in this codebase (pre-existing, documented in sync/README.md Known Gaps). The decision logic it wires together (isPhantomManifestEntry(), commitSync()'s snapshot-based manifest build + merge-back, determineSyncActions() itself) IS unit-tested per Test Scenarios 3, 4, 5, 7. Verified via full suite (127/127 green) + tsc -noEmit + code read-through against plan steps 1-3 and 5."
---
# Plan: Fix Manifest/Tree Drift Race + Crash Guard + Stuck-Entry Convergence

Impact analysis: `./fix-manifest-tree-drift-and-cleanup-impact.md`

## Approach

**Rough change (system):** No visible UI change. Internally: (1) a sync that hits a
manifest entry with no matching git-tree item no longer crashes — it skips that entry
and self-corrects the next commit; (2) a file created on disk *while* a sync is already
running in the background is no longer able to leak into that sync's committed manifest
without its content — it's picked up cleanly on the next sync instead.

**Chosen: Option A — Snapshot-freeze.** Take one immutable snapshot of local metadata
right after `reconcileConfigDirFiles()` and `migrateIllegalFilenames()` have applied their
own legitimate this-sync mutations (i.e. right before `findConflicts()`/`determineSyncActions()`
run). Use that same snapshot as the single source of truth for both (a) computing this
sync's actions and (b) serializing the manifest committed to GitHub. Any vault-change event
that mutates live local metadata *after* the snapshot is taken (e.g. a plugin writing its
data file, or the user creating a note, while sync is awaiting a GitHub API round-trip) is
invisible to this sync's manifest — it stays live-only, `dirty: true`, and gets its own
correct upload action on the *next* sync.

**Why this beat the alternatives:**
- **Option B (re-scan-and-fold before commit)** would catch concurrently-created files
  in the *same* sync cycle instead of deferring one cycle, but requires duplicating the
  upload branch's content-reading and text/binary handling in a second location, and
  duplicating the "file no longer exists" race guard (`sync-manager.ts:599-617`) a second
  time — more surface area for a second version of the same bug class, for a benefit
  (one sync cycle sooner) that doesn't matter in practice: a file created mid-sync is, by
  definition, only seconds away from the next interval/manual sync anyway.
- **Option C (guard-only, leave the race)** ships faster but doesn't satisfy the
  "harden root-cause" scope already chosen at the `iris-0b-check-impact` stage, and leaves
  a recurring band-aid pattern — every future occurrence loses one sync cycle's worth of
  the affected file's content, indefinitely, instead of the race being closed once.
- The user's own framing during Gate G ("move metadata upload to be last") pointed at the
  right defect — not that the manifest write happens too early (it already happens right
  before `createTree`), but that the **snapshot used to build the action list and the
  snapshot used to build the manifest content were never the same object at the same
  point in time**. Option A is the direct fix for that specific gap.

**Crash guard is shared baseline across all options, not an alternative** — it is required
regardless of which race-prevention option was picked, because it's the only thing that
converges the *already-stuck* `Operasi.md` entry sitting in the repo's current HEAD commit
today, and because *some* defensive check at the download call site is needed no matter how
tight the race-prevention gets (e.g. a manifest hand-edited outside the plugin would produce
the same missing-tree-entry shape without the sync ever having a race at all).

## Implementation Steps

### Step 1 — Capture the local-metadata snapshot in `syncImpl()`

Location: `src/sync-manager.ts`, immediately after the existing
`const migratedOldKeys = await this.migrateIllegalFilenames(remoteMetadata.files);` line
(currently `sync-manager.ts:509`) and before `findConflicts()` (currently line 511). This
placement is deliberate: it must run *after* `reconcileConfigDirFiles()` (line 480) and
`migrateIllegalFilenames()` (line 509) so their legitimate this-sync additions/re-keys are
captured, and *before* anything that yields to the event loop for an extended period
(network calls in `findConflicts()`, the potentially long `onConflicts()` UI wait, and the
upload/download network calls) so the window during which a concurrent vault event could
land un-captured starts as late as possible.

```ts
const localSnapshot: { [key: string]: FileMetadata } = Object.fromEntries(
  Object.entries(this.metadataStore.data.files).map(([k, v]) => [k, { ...v }]),
);
```

**Interfaces:**
- Consumes: `this.metadataStore.data.files: { [key: string]: FileMetadata }` (live object,
  read at this specific point in `syncImpl()`, after `reconcileConfigDirFiles()` and
  `migrateIllegalFilenames()` have already applied their mutations to it).
- Produces: `localSnapshot: { [key: string]: FileMetadata }` — an independent object with
  independently-copied per-path `FileMetadata` entries (mutating `localSnapshot[path].sha`
  later must never mutate `this.metadataStore.data.files[path]` and vice versa). Consumed
  by Step 2 (`determineSyncActions()`), Step 3 (download guard), and Step 4 (`commitSync()`).

### Step 2 — Route `determineSyncActions()` and the action-processing blocks through the snapshot

Location: `sync-manager.ts:561-565` (the `determineSyncActions()` call) — change the second
argument from `this.metadataStore.data.files` to `localSnapshot`.

Location: `sync-manager.ts:594-656` (the upload/`delete_remote` action-processing
`Promise.all`) — every read/write currently targeting `this.metadataStore.data.files[action.filePath]`
(lines 599, 608-611, and the analogous write for a successful upload) must instead target
`localSnapshot[action.filePath]`, so that this sync's per-file outcome (dirty cleared, sha
set, or tombstoned as deleted) lands in the object that becomes the manifest, not directly
in live data.

`determineSyncActions()` itself (`sync-manager.ts:1118` onward) requires **no internal logic
change** — it already takes `localFiles` as a parameter; this step only changes what object
the caller passes in.

**Interfaces:**
- Consumes: `localSnapshot` (from Step 1), `remoteMetadata.files: { [key: string]: FileMetadata }`
  (unchanged, still the parsed manifest blob).
- Produces: `actions: SyncAction[]` (unchanged shape/contract — existing callers/tests of
  `determineSyncActions()` are unaffected since its own signature and logic don't change).
  Mutates `localSnapshot` in place for entries touched by upload/delete_remote processing.

### Step 3 — Add the download-crash guard, tombstoning phantom entries into the snapshot

Location: `sync-manager.ts:660-667` (the download branch inside the second `Promise.all`).
Before calling `this.downloadFile(files[action.filePath], ...)`, check whether
`files[action.filePath]` is defined. If it is `undefined` (the manifest/`remoteMetadata.files`
listed this path as live, but the raw tree from `getRepoContent()` has no matching item):

- Do **not** call `downloadFile()` for this action (prevents the crash).
- Log a warning naming the file path and that it was skipped as a "manifest references a
  file missing from the remote tree" case.
- Write a tombstone into the snapshot: `localSnapshot[action.filePath] = { path: action.filePath, sha: null, dirty: false, justDownloaded: false, lastModified: Date.now(), deleted: true, deletedAt: Date.now() }` — this mirrors the existing shape used by the upload-skip precedent (`sync-manager.ts:608-611`), so the *next* line that serializes the manifest (Step 4) marks this path `deleted`, converging the remote manifest away from the phantom reference.

This is the mechanism that self-heals the currently-stuck `Operasi.md` entry: whichever
device runs this fix and completes one full sync will commit a manifest with
`Operasi.md.deleted = true`, and every subsequent sync (on any device, fixed or not, since
`reconcileRemoteMetadataWithTree()`/`determineSyncActions()` already respect the `deleted`
flag) stops generating the download action for it.

**Interfaces:**
- Consumes: `files: { [key: string]: GetTreeResponseItem }` (raw tree, unchanged), `action.filePath: string`, `localSnapshot` (read + write).
- Produces: mutates `localSnapshot[action.filePath]` to a deleted tombstone; no change to
  the download branch's return type (still `Promise<void>` per action).

### Step 4 — Change `commitSync()` to build the manifest from the snapshot, then merge back

Location: `sync-manager.ts:1299` onward. New signature:

```ts
async commitSync(
  treeFiles: { [key: string]: NewTreeRequestItem },
  baseTreeSha: string,
  localMetadataSnapshot: { [key: string]: FileMetadata },
  conflictResolutions: ConflictResolution[] = [],
)
```

Changes inside the function body:
- Lines 1333-1401 (per-file SHA computation for `treeFiles` entries with `content`): change
  every `this.metadataStore.data.files[filePath]` read/write to `localMetadataSnapshot[filePath]`.
- Lines 1317-1320 (pre-commit conflict-resolution `lastModified` stamping): change
  `this.metadataStore.data.files[resolution.filePath].lastModified` to
  `localMetadataSnapshot[resolution.filePath].lastModified` — this write affects what gets
  serialized into the manifest at line 1406, so it must target the snapshot.
- Lines 1403-1406 (manifest content): change
  `JSON.stringify(this.metadataStore.data)` to
  `JSON.stringify({ lastSync: this.metadataStore.data.lastSync, files: localMetadataSnapshot })`.
- Lines 1433-1452 (post-commit local-disk write of resolved conflict content, and its
  `lastModified` stamp): **leave targeting live `this.metadataStore.data.files`** — this runs
  after `updateBranchHead()` has already succeeded, and it's establishing this device's own
  local bookkeeping for future conflict-avoidance, not manifest content that's already been
  committed. No change needed here.
- Immediately after `updateBranchHead()` succeeds (after line 1430, before the existing
  conflict-resolution-content write block at 1433): add
  `Object.assign(this.metadataStore.data.files, localMetadataSnapshot);` — this overwrites
  live entries with the snapshot's this-sync outcomes (sha updates, tombstones from Step 3)
  for every key present in the snapshot, while leaving any live-only key untouched (a file
  created by a concurrent vault event during this sync, which was never part of the
  snapshot, survives in live data exactly as the event left it — `dirty: true`, ready to be
  picked up as an ordinary upload action on the next sync).
- The existing `this.metadataStore.save()` at the end (line 1456) is unchanged — it now
  persists the post-merge state.

**Interfaces:**
- Consumes: `localMetadataSnapshot` (from Step 1, mutated by Steps 2/3), `treeFiles`,
  `baseTreeSha`, `conflictResolutions` (all unchanged in shape from the existing signature).
- Produces: the manifest blob committed to GitHub reflects exactly
  `{ lastSync, files: localMetadataSnapshot-as-of-this-commit }` — never anything added to
  live local metadata after the snapshot was taken. After a successful commit,
  `this.metadataStore.data.files` is updated via the merge-back (existing live-only keys
  preserved, snapshot keys overwritten with this sync's outcome).

### Step 5 — Update the other 2 `commitSync()` call sites for signature compliance

Location: `firstSyncFromRemote()` (`sync-manager.ts:370`) and `firstSyncFromLocal()`
(`sync-manager.ts:439`). Both already build their `newTreeFiles`/`treeFiles` by exhaustively
enumerating every non-deleted entry in `this.metadataStore.data.files` (confirmed in the
impact analysis — neither path seeds from a stale base tree, so neither can exhibit this
drift in practice). No behavior change is intended for these two flows; add, immediately
before each existing `await this.commitSync(newTreeFiles, treeSha)` call, a plain snapshot
of the same shape as Step 1 and pass it as the new third argument:

```ts
const localSnapshot = Object.fromEntries(
  Object.entries(this.metadataStore.data.files).map(([k, v]) => [k, { ...v }]),
);
await this.commitSync(newTreeFiles, treeSha, localSnapshot);
```

**Interfaces:**
- Consumes: `this.metadataStore.data.files` (live, at each call site's existing call time —
  no change to when these methods run relative to anything else).
- Produces: `localSnapshot` argument satisfying `commitSync()`'s new required parameter; no
  other observable change to `firstSyncFromRemote()`/`firstSyncFromLocal()` behavior.

### Step 6 — Extract the download-guard predicate for testability, add/update tests

Extract Step 3's "is this path missing from the raw tree" check into a small named
predicate (e.g. `private isPhantomManifestEntry(files: { [key: string]: GetTreeResponseItem }, filePath: string): boolean { return files[filePath] === undefined; }`) so it can be
unit-tested directly rather than only reachable through the untested `syncImpl()` integration
surface (`syncImpl()` has zero direct tests anywhere in this codebase today — extracting the
predicate avoids adding to that gap for at least the decision logic, even though the
`Promise.all` wiring around it remains covered only indirectly).

Add/update tests in `src/sync-manager.test.ts`:
- New `describe('commitSync manifest snapshot')`: assert that `commitSync()`'s serialized
  manifest content matches the passed-in `localMetadataSnapshot`, and specifically does
  **not** include a key that exists only in `(syncManager as any).metadataStore.data.files`
  but not in the snapshot argument (proves the snapshot, not live data, is the manifest
  source).
- New test in that same `describe`: after a successful `commitSync()`, assert a live-only
  key (present in `metadataStore.data.files` before the call, absent from the snapshot
  argument) is still present and unmodified afterward (proves the merge-back doesn't drop
  concurrent local state).
- New `describe('isPhantomManifestEntry')` (or wherever Step 6's predicate lands): table
  test for defined-in-tree (false) vs. undefined-in-tree (true).
- Existing `describe('determineSyncActions with exclude patterns ...')` (`sync-manager.test.ts:505-537`)
  must continue to pass unmodified — confirms the parameter-source change (Step 2) doesn't
  alter `determineSyncActions()`'s own behavior.
- Existing `describe('downloadFile')` (`sync-manager.test.ts:135,297`) and
  `describe('commitSync binary blob')` (`sync-manager.test.ts:222`) must continue to pass —
  confirms `downloadFile()`'s own contract and the binary-blob SHA path are unaffected by
  the snapshot plumbing.

**Interfaces:**
- Consumes: existing test scaffolding in `sync-manager.test.ts` (`mockVault`, `mockSettings`,
  the `(syncManager as any).metadataStore`/`.client` override pattern already used throughout
  the file).
- Produces: passing vitest specs asserting every behavior listed in `## Test Scenarios` below.

## Open Questions

- [x] Confirm the phantom-entry tombstone shape proposed in Step 3 (`sha: null, dirty: false, deleted: true, deletedAt: Date.now()`) is acceptable — **confirmed**, use as proposed.
- [x] Confirm no manual/direct GitHub-side edit of the current stuck manifest is wanted as a faster interim fix — **confirmed**, no manual edit; the guard alone converges `Operasi.md` once a device completes a sync on the fixed code.
- [x] Confirm extracting the guard predicate (Step 6) is preferred over leaving it fully inline in `syncImpl()` — **confirmed**, extract as `isPhantomManifestEntry()`.

## Test Scenarios

1. A manifest entry for a path absent from the raw remote tree (`files`), with a corresponding `download` `SyncAction`, does not throw — the sync completes, and that path is skipped for download.
2. After scenario 1's sync commits, the manifest content passed to `createTree()` has `deleted: true, deletedAt: <timestamp>` for that path (self-heals within the same commit, not deferred to a second cycle).
3. `commitSync()`'s manifest JSON is built strictly from the `localMetadataSnapshot` argument (plus this-sync's own sha/tombstone mutations to it) — a key added directly to `(syncManager as any).metadataStore.data.files` after the snapshot was constructed but before `commitSync()` is called must **not** appear in the serialized manifest content.
4. After a successful `commitSync()`, a key that existed live (in `metadataStore.data.files`) but not in the snapshot argument remains present and unchanged in `metadataStore.data.files` afterward — proves the post-commit merge-back preserves concurrently-added local state instead of clobbering it.
5. `determineSyncActions()`'s existing behavior (upload/download/delete_local/delete_remote/exclude-pattern filtering — `sync-manager.test.ts:505-537`) is unchanged when called with a snapshot object structurally identical to what was previously passed by live reference.
6. `firstSyncFromRemote()` and `firstSyncFromLocal()` continue to commit a manifest containing every non-deleted locally-tracked file, unaffected by the added snapshot argument at their `commitSync()` call sites.
7. `isPhantomManifestEntry()` (or equivalent extracted predicate) returns `true` when `files[filePath]` is `undefined` and `false` when it resolves to a valid tree item, independent of `sha`/`mode`/`type` field values.

## Deviations

**Baseline:** clean, 123 tests passing (`npm run test -- --run`) before any change.

| What changed | Why | Update feature doc? |
|---|---|---|
| Steps 1-6 implemented exactly as planned — no logic deviation. | N/A | no |
| Fixed 2 pre-existing `commitSync()` call sites in `sync-manager.test.ts` ("commitSync binary blob" describe, `sync-manager.ts` binary-blob error-path tests) to pass `{}` as the new required `localMetadataSnapshot` argument. | Step 4's signature change (adding a required 3rd param) makes the old 2-arg calls fail to compile/behave correctly; both tests throw before the snapshot is ever read, so `{}` is a safe placeholder. | no |
| Fixed 1 pre-existing call site in `sync-manager-migration.test.ts` (`T10: conflict write path - honors localPath`) to pass an explicit snapshot (containing the same entry already set on live `metadataStore.data.files`) as the 3rd argument, shifting `resolutions` to the 4th (`conflictResolutions`) slot. | Same as above — this test's assertions (`mockVault.adapter.write` calls) are unchanged; only the call arguments needed updating for the new signature. | no |
| New test's `treeFiles` literal in `sync-manager.test.ts` (`commitSync manifest snapshot` describe) cast `as any`. | TS narrows the literal's inferred type without a `content` field; the test reads `.content` after `commitSync()` mutates it. Same pattern as other test files in this suite casting ad-hoc mock objects. | no |
| Steps 1-3's `syncImpl()` wiring has no dedicated new test (see `testing_gaps` in frontmatter). | `syncImpl()` has zero direct tests anywhere in this codebase (pre-existing gap, documented in `sync/README.md` Known Gaps) — the decision logic it wires together is unit-tested per Test Scenarios 3, 4, 5, 7 instead. | no |

**Final run:** `npm run test -- --run` → 10 test files passed, 127/127 tests passing (123 baseline + 4 new: 2 `isPhantomManifestEntry`, 2 `commitSync manifest snapshot`). `npx tsc -noEmit` → clean, no errors.
