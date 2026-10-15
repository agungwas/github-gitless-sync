---
type: implementation
status: done
completed: 2026-10-15
qa: done
qa_completed: 2026-10-15
testing: tdd
created: 2026-10-15
active_skill: ""
active_since: ""
testing_gaps:
  - "tab.ts display() retention field rendering untested (no Setting harness, same gap as other fields)"
---
# Plan — Tombstone Retention (`tombstoneRetentionDays`)

## Goal

Add a Gitless setting `tombstoneRetentionDays` (default 30). During each sync, a metadata row is removed from `github-sync-metadata.json` (local and remote) when all of these hold:
- `deleted === true`,
- `deletedAt` is a number and `now - deletedAt > tombstoneRetentionDays * 86_400_000`,
- the file does not exist in this vault (`vault.adapter.exists(localPath ?? path) === false`).

Today tombstones are kept forever (see `features/sync/README.md` → "Update 2026-10-15 — Tombstone Retention"), so metadata grows by one row per deleted path.

## Approach

**Rough change:** UI: adds a "Deleted file retention (days)" number field to Gitless settings → System: deleted-file rows older than that are dropped from the metadata on the next sync.

Approach named by the human (setting + prune at sync time). Gate A skipped.

Prune runs inside `commitSync()` on `localMetadataSnapshot` before the manifest JSON is built, so the remote metadata and the local metadata shrink in the same commit. The same paths are deleted from live `metadataStore.data.files`.

**Accepted risk (Gate G, human chose `goal-ok` + `no-guard`):** a device that has not synced for longer than `tombstoneRetentionDays` still holds the file with a non-deleted row. After prune, the remote has no row → `determineSyncActions()` "local not in remote" branch (`sync-manager.ts:1572-1585`) emits `upload` → the deleted file is resurrected. Same for a plugin `manifest.json` tombstone (plugin reinstalled on the stale device). An anti-resurrection guard (delete_local when the local row has a sha, remote has no row, and content is unchanged) was offered and rejected.

## Impact Analysis

Features touched: `sync` only.

| File | Change |
|---|---|
| `src/settings/settings.ts` | New field `tombstoneRetentionDays: number`, default `30` |
| `src/settings/tab.ts` | Number text field in the "Sync" section |
| `src/sync-manager.ts` | New `pruneExpiredTombstones()`; called in `commitSync()` before the manifest content is built |
| `src/sync-manager.test.ts` | Tests for prune |
| `src/settings/settings.test.ts` | Default value test (if that file covers defaults) |

No metadata schema change: rows are only removed. `normalizeMetadata()` untouched.

## Implementation Steps

### Step 1 — Setting

- `GitHubSyncSettings`: add `tombstoneRetentionDays: number;` (comment: days a deleted-file row stays in sync metadata).
- `DEFAULT_SETTINGS.tombstoneRetentionDays = 30`.
- Settings are loaded via `Object.assign({}, DEFAULT_SETTINGS, saved)`-style merge in `main.ts` → existing users get 30. Verify that merge exists; if not, default in loader.

Interfaces:
- Consumes: none
- Produces: `settings.tombstoneRetentionDays: number`

### Step 2 — Settings UI

In `src/settings/tab.ts`, "Sync" section (after the window focus/blur toggles, ~line 330), add:

```ts
new Setting(containerEl)
  .setName("Deleted file retention (days)")
  .setDesc("Deleted files stay in sync metadata this many days, then are forgotten once missing from this vault. A device offline longer than this may restore deleted files.")
  .addText((text) => text
    .setPlaceholder("Days")
    .setValue(this.plugin.settings.tombstoneRetentionDays.toString())
    .onChange(async (value) => {
      const days = parseInt(value);
      this.plugin.settings.tombstoneRetentionDays = Number.isNaN(days)
        ? DEFAULT_SETTINGS.tombstoneRetentionDays
        : Math.max(days, 1);
      await this.plugin.saveSettings();
    }));
```

Same pattern as `conflictsAutoCloseDelay` (`tab.ts:498-516`). Minimum 1; no upper clamp.

Interfaces:
- Consumes: `settings.tombstoneRetentionDays`, `DEFAULT_SETTINGS`
- Produces: none

### Step 3 — `pruneExpiredTombstones`

In `SyncManager`:

```ts
const MS_PER_DAY = 86_400_000;

async pruneExpiredTombstones(
  files: { [key: string]: FileMetadata },
  now: number,
): Promise<string[]>
```

- Returns the list of paths that qualify (query; does not mutate — CQS). Caller deletes.
- Skip `${configDir}/${MANIFEST_FILE_NAME}`.
- Qualify: `file.deleted === true && typeof file.deletedAt === "number" && now - file.deletedAt > this.settings.tombstoneRetentionDays * MS_PER_DAY && !(await this.vault.adapter.exists(file.localPath ?? normalizePath(path)))`.
- `deletedAt` null/undefined → never qualifies.

Interfaces:
- Consumes: `FileMetadata`, `this.settings.tombstoneRetentionDays`, `vault.adapter.exists`
- Produces: `pruneExpiredTombstones(files, now): Promise<string[]>`

### Step 4 — Wire into `commitSync()`

In `commitSync()` (`sync-manager.ts:1647`), right before the manifest content block ("Update manifest in list of new tree items", ~line 1757):

```ts
const expired = await this.pruneExpiredTombstones(localMetadataSnapshot, syncTime);
for (const path of expired) delete localMetadataSnapshot[path];
```

Then after `updateBranchHead` succeeds, in the merge-back section (~line 1790), delete the same paths from live metadata **only if the live row is still the same tombstone** (`liveFile?.deleted === true`) — a concurrent event that recreated the file mid-sync must not be erased:

```ts
for (const path of expired) {
  if (this.metadataStore.data.files[path]?.deleted) delete this.metadataStore.data.files[path];
}
```

Log once: `logger.info("Pruned expired tombstones", expired)` when non-empty.

Tree: no tree change needed — a tombstone already has no tree item (its blob was removed in the sync that deleted it).

Interfaces:
- Consumes: `pruneExpiredTombstones`, `localMetadataSnapshot`, `syncTime`
- Produces: none (manifest JSON without expired rows)

## Edge Cases

| Case | Behavior | Update feature doc? |
|---|---|---|
| Device offline > retention holds the file | Resurrected via upload (accepted risk) | yes |
| Plugin `manifest.json` tombstone pruned, stale device still has plugin | Plugin manifest re-uploaded; plugin reappears (accepted risk) | yes |
| File recreated locally after tombstone (exists on disk) | Not pruned; existing reinstall logic (`reconcileConfigDirFiles` mtime vs `deletedAt`) still applies | no |
| `deletedAt` null | Never pruned | no |
| Sync fails before `updateBranchHead` | Live metadata untouched (deletion only after success); next sync retries | no |
| Concurrent vault event recreates path mid-sync | Live row no longer `deleted` → kept | no |
| Clock skew between devices | `deletedAt` from another device's clock; days-scale threshold makes skew irrelevant | no |
| Retention changed later | Applies on next sync; already-pruned rows are gone | no |

## Test Scenarios

- T1: tombstone `deletedAt = now - 31d`, file absent, retention 30 → returned by `pruneExpiredTombstones`.
- T2: tombstone `deletedAt = now - 29d` → not returned.
- T3: tombstone 31d old but file exists on disk → not returned.
- T4: non-deleted row older than 31d → not returned.
- T5: `deletedAt: null` → not returned.
- T6: manifest path itself never returned.
- T7: `localPath` used for the existence check when present.
- T8: `commitSync` → uploaded manifest JSON lacks the expired path; live `metadataStore.data.files` lacks it after success.
- T9: `commitSync` with live row for the expired path changed to `deleted: false` mid-sync → live row kept.
- T10: `DEFAULT_SETTINGS.tombstoneRetentionDays === 30`.

## Open Questions

- none

## Deviations

Baseline: clean (252 tests passing). Command: `npx vitest run`
Final run: `npx vitest run` → 25 files / 265 tests pass; `npm run build` (tsc + esbuild) OK.

| What changed | Why | Update feature doc? |
|---|---|---|
| `pruneExpiredTombstones` compares with `!(now - deletedAt > retentionMs)` and prunes nothing when the setting is missing/NaN (test T11 added) | `undefined * MS_PER_DAY` is NaN; a plain `<=` check would prune every tombstone | yes |
| `uninstall-sync.test.ts` fixture settings set `tombstoneRetentionDays: 36_500` | Fixture uses synthetic `deletedAt: 1000`; default retention pruned those tombstones. Retention is not under test there (not a behavior change of those tests) | no |
| Settings UI field has no test | `tab.ts` `display()` needs an Obsidian `Setting` harness; verified by typecheck + build only | yes (Known Gaps) |
| Live-row cleanup after commit also requires `live.deletedAt === pruned deletedAt` (test T12); existence checks run in parallel | Code review Minor: a re-deleted file mid-sync would lose its fresh tombstone; sequential `exists` calls | no |
| `existsWithExactCase()` added: after `adapter.exists` hits, `adapter.list(parent)` must contain the exact path (tests T13, T14) | QA critique: case-insensitive filesystems never pruned `A.md` while `a.md` existed. Human asked for the fix inside the QA run | yes (Known Constraints: one extra `list` call per expired tombstone whose path exists) |
| Refactor (Clean Code, human-requested): `pruneExpiredTombstones` → `findExpiredTombstones` returning `Map<path, deletedAt>`; `commitSync` delegates to `dropTombstonesFromSnapshot` and `dropTombstonesFromLiveMetadata` (includes the log) | name implied mutation; low-level detail mixed into `commitSync`. No behavior change; 265 tests green | no |
| Refactor (human-requested): `commitSync()` split into `stampResolvedConflictTimes`, `attachShasToTreeFiles` (+ `recordSnapshotSha`, `uploadBinaryBlob`), `writeMetadataIntoTree`, `pushCommit`, `mergeCommittedSnapshotIntoLive`, `applyResolvedConflictContent`. Step order, error messages and comments preserved | `commitSync` mixed several abstraction levels and duplicated the snapshot-SHA if/else. No behavior change; 265 tests green, build OK | no |

## QA Sweep

### Header
Runtime: CLI/API Runbook (non-FE logic; UI field manual). FE detected: Obsidian settings DOM only.
Scenarios: happy 6 / edge 6 / negative 3
Critique: blocker 0 / major 0 / minor 3 / nit 0
Critique mode: single-sweep (files: 5, lines: 114+/11-, threshold: 10/500)
Pipeline order: pre-iris-5

### Taxonomy N/A
| Entry | Reason | Confirm? |
|---|---|---|
| i18n | one English settings label, same as the rest of the tab | auto-confirmed |
| a11y | standard Obsidian `Setting` text input, no custom markup | auto-confirmed |
| auth-fail / permission | no auth or permission code touched | auto-confirmed |
| slow-network | prune is local; no extra requests | auto-confirmed |
| max | no size limit applies; retention has no upper clamp (see critique) | auto-confirmed |

### Scenario Matrix
| # | Family | Scenario | Source | Expected | Covered by |
|---|---|---|---|---|---|
| H1 | happy | 31d tombstone, file absent | plan T1 | pruned | unit T1 |
| H2 | happy | commit drops row from manifest + live | plan T8 | row gone in both | unit T8 |
| H3 | happy | default is 30 | plan T10 | 30 | unit |
| H4 | happy | window boundary, 29d | plan T2 | kept | unit T2 |
| H5 | happy | settings field shows 30 | plan Step 2 | visible | manual M1 |
| H6 | happy | real sync prunes remote row | plan Approach | gone remote + local | manual M3 |
| E1 | edge | value 0 / negative / NaN input | plan Step 2 | min 1 / default 30 | manual M2 |
| E2 | edge | setting undefined | review T11 | prune nothing | unit T11 |
| E3 | edge | `deletedAt` null | plan T5 | kept | unit T5 |
| E4 | edge | metadata file path | plan T6 | never pruned | unit T6 |
| E5 | edge | file exists on disk | plan T3 | kept | unit T3, manual M4 |
| E6 | edge | stale device resurrects (concurrent) | edge-taxonomy: concurrent | file returns (accepted) | manual M6 |
| N1 | negative | non-deleted old row | plan T4 | kept | unit T4 |
| N2 | negative | row recreated / re-deleted mid-sync | plan T9, review T12 | live row kept | unit T9, T12 |
| N3 | negative | sync fails before branch update | edge-taxonomy: network-fail | local row kept | manual M5 |

### Coverage Gaps
- H5/H6/E1/E6/N3 have no automated test: settings `display()` has no harness (known), and no `syncImpl` integration test exists in the repo. Covered by the manual runbook `qa/tombstone-retention/scenarios.md`.

### Critique
| Severity | Angle | File:line | Finding | Suggested fix |
|---|---|---|---|---|
| minor | error-handling | src/settings/tab.ts:343 | no upper clamp; `parseInt("1e9")` is 1 but `99999999999` gives a retention that overflows to never prune (harmless) | optional cap, e.g. 3650 |
| minor | concurrency | src/sync-manager.ts:1614 | case-insensitive filesystem: tombstone `A.md` is never pruned while `a.md` exists on disk | **FIXED at human request**: `existsWithExactCase()` lists the folder to confirm the exact name (tests T13, T14) |
| minor | plan-conformance | src/sync-manager.ts:1616 | first sync after upgrade prunes every tombstone older than 30 days at once (expected by the plan, not mentioned in the setting description) | mention in feature doc Known Constraints |

### Run Results
Command: `npx vitest run` (full) and `npx vitest run src/sync-manager.test.ts src/settings/settings.test.ts`
Run at: 2026-10-15
Result: full suite 25 files / 265 tests pass; targeted 88/88 pass; `npm run build` OK. Manual M1-M6 not run (need a real vault).
