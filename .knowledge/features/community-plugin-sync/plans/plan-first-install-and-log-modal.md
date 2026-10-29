---
status: done
type: implementation
testing: tdd
created: "2026-10-29"
completed: "2026-10-29"
active_skill: ""
active_since: ""
qa: done
qa_completed: "2026-10-29"
---
# Plan: First-install sync recovery and log modal

## Goal and evidence

A plugin installed on Android should sync to a Mac where its folder is absent, and subsequent syncs should preserve the installed state unless an explicit uninstall occurs. The Mac log on 2026-10-29 08:40–08:41 WIB records a scheduled download of `lazy-plugins/manifest.json`, deferred upload of missing `data.json`, and `ENOENT` writing a conflict resolution. Android subsequently reports a remote uninstall conflict. The logs prove those events, not why the folder was absent or which device originally produced the tombstone. First reproduce the suspected mechanisms; do not treat them as established historical cause.

The log modal should display a narrow timestamp column, a message column, and a separate level column to the right of the message. Clicking an entry reveals its additional data beneath the message; clicking again hides it.

## Approach

System/UI: restore missing plugin files and folders safely during sync, and make log details expandable in the existing modal.

Extend the existing `SyncManager`, filesystem adapter and `LogsModal`; no new metadata schema, plugin inventory, filesystem dependency, or separate UI surface. The user requested dedicated functions to check whether a path is absent and create its folder. `adapter.exists()` reports absence, not an error code: use it for an existence check and preserve actual operation errors rather than calling every failure ENOENT. A minimal mkdir-only patch would not repair a missing manifest skipped by matching metadata or stale committed snapshot. Reordering the entire transaction without proof would risk changing conflict and concurrency semantics; first prepare destination directories before remote publication and explicitly report a post-publication failure if the later write fails. It is not possible to guarantee a future write will succeed solely through a preflight check.

Affected knowledge: `community-plugin-sync` (owner), `sync` (download and commit snapshot), and existing log modal behavior in `src/settings/logs-modal.ts` (no separate feature doc currently). Impact analysis: none previously created. Avoid changing actual uninstall semantics, enabled-list merge policy, or recording new shared metadata fields.

## Steps

Each step follows TDD: write focused behavioral test, verify RED, implement smallest change, verify GREEN. Record commands, failing assertions, and outcomes. Use current working directory. Do not change user vault, live repository, or actual plugin settings during reproduction.

### 1. Reproduce first-install and identify failure path

- Extend `src/plugin-sync/uninstall-sync.test.ts` or add a focused two-device in-memory fixture with real `SyncManager.syncImpl`, an Android publisher, a Mac adapter enforcing parent-directory existence, separate metadata, pinned snapshots and a fake Git tree. Model failed operations faithfully instead of silently creating directories.
- Demonstrate missing destination folder and conflict-selected `data.json`; assert what happens before and after the remote branch update. Separately reproduce local metadata with matching manifest SHA but no physical file; check whether `downloadFile` skips it. Include a remote live manifest against a local tombstone and inspect the committed metadata. If any test is already green, preserve its evidence and do not claim it caused the observed incident.
- Test a remote-only manifest, a downloaded changed manifest, and a previously tombstoned manifest; verify tree, live metadata, committed snapshot, and filesystem separately.
- **Interfaces:**
  - **Consumes:** `SyncManager.syncImpl(): Promise<number>` (accessed through existing test internals); `downloadFile(file: GetTreeResponseItem, lastModified: number, remoteMetadata?: FileMetadata): Promise<FileMetadata>`; `Metadata`, `FileMetadata`, `PluginSyncCoordinator`.
  - **Produces:** deterministic failing regression scenarios and explicit recorded results for each hypothesis; no production interface.

### 2. Dedicated path checks and parent creation

- Introduce focused filesystem helpers in a suitable module, e.g. `src/fs-paths.ts`, accepting Obsidian `DataAdapter` and normalized vault-relative paths. Define `isPathMissing(adapter: DataAdapter, path: string): Promise<boolean>` using `exists`; define `ensureParentDirectory(adapter: DataAdapter, filePath: string): Promise<void>` to create missing ancestor directories from root to parent. Do not create the filename as a folder. Handle root-level files without a mkdir.
- Ensure creation is idempotent; if a concurrent mkdir fails, recheck the exact folder and only suppress that error if the directory now exists. Do not suppress permission, invalid-path, or unresolved I/O errors. Keep the original error as cause and include the path in context. Reject paths escaping the vault instead of constructing an outside path. Consider that exists alone cannot distinguish a file from a directory: use `stat` when a path is occupied and fail if it is not a folder.
- Use these helpers in `downloadFile` and conflict-resolution destination preparation; replace existing duplicated folder creation there while preserving sanitized paths. Check operation-level ENOENT only when represented by a reliable structured `code`; do not parse arbitrary error text and mislabel errors. Handle a missing parent race with at most one recreate-and-retry, without masking the final error.
- **Interfaces:**
  - **Consumes:** `DataAdapter.exists(normalizedPath: string): Promise<boolean>`, `DataAdapter.stat(normalizedPath: string): Promise<Stat | null>`, `DataAdapter.mkdir(normalizedPath: string): Promise<void>`, `normalizePath(path: string): string`.
  - **Produces:** `isPathMissing(adapter: DataAdapter, path: string): Promise<boolean>`, `ensureParentDirectory(adapter: DataAdapter, filePath: string): Promise<void>`, and `withParentDirectoryRetry<T>(adapter, filePath, operation): Promise<T>`; errors propagate with destination and cause.

### 3. Restore files and maintain committed snapshot

- Change `downloadFile` to skip matching SHA only when the normalized/sanitized destination exists as a file; a missing file must fetch its blob and create its parent. Reject a directory occupying the file path. Test both matching SHA cases, including `localPath` mappings and a disappeared folder.
- After each successful download, put the specific downloaded remote entry into `localSnapshot`, using the successful local download metadata and remote authoritative SHA/timestamp. Do not include unrelated live-only changes or overwrite concurrent updates. A successful download of a live file must not republish a stale local tombstone; a remote-only downloaded file must appear in committed metadata. Preserve explicit remote uninstall tombstones and existing deletion conflict handling.
- Review `downloadFile` no-op return and update the snapshot only when the destination really exists; never copy arbitrary live metadata wholesale into the frozen snapshot. Preserve guards against manifest/tree drift and concurrent vault events.
- **Interfaces:**
  - **Consumes:** `downloadFile(file: GetTreeResponseItem, lastModified: number, remoteMetadata?: FileMetadata): Promise<FileMetadata>`; `isPathMissing(adapter: DataAdapter, path: string): Promise<boolean>`; `localSnapshot: Record<string, FileMetadata>`; `remoteMetadata.files`.
  - **Produces:** downloaded files present locally and corresponding committed `FileMetadata` reflecting the accepted remote live state; no schema change.

### 4. Conflict destination and publication failures

- For resolutions that require local writes, prepare each normalized, sanitized parent before `pushCommit` in `commitSync`, including first-install plugin settings. Preserve `accept-uninstall` exclusion. Ensure no write or mkdir is performed for an accepted removal.
- Keep remote publication and local application semantics explicit: if preparation fails, fail before branch update; a later write may still fail after publication, so surface an accurate error that remote commit may already exist. Do not assert atomicity or blindly retry a remote commit. Test both pre-publication directory failure and post-publication local write failure, including original error cause.
- For the narrow missing-parent race, ensure and retry the failed local write once only on a reliable missing-path signal, and never convert permission or generic failures to ENOENT. Preserve existing concurrent-edit protections and update timestamps only after successful writes.
- **Interfaces:**
  - **Consumes:** `ensureParentDirectory(adapter: DataAdapter, filePath: string): Promise<void>`; `withParentDirectoryRetry<T>(adapter, filePath, operation): Promise<T>`; `shouldApplyConflictContent(resolution: ConflictResolution): boolean`; `pushCommit(treeFiles: Record<string, NewTreeRequestItem>, baseTreeSha: string, baseCommitSha?: string): Promise<void>`; `applyResolvedConflictContent(conflictResolutions: ConflictResolution[], syncTime: number): Promise<void>`.
  - **Produces:** prepared destinations before remote publication; accurately surfaced pre/post-publication failure; unchanged `commitSync(...): Promise<void>` external signature.

### 5. Log modal layout and row disclosure

- Update `src/settings/logs-modal.ts` and `styles.css`: table headers and cell order `Timestamp (local) | Message | Level`; constrain timestamp and level to content-sized narrow columns, let message wrap, preserve local timestamp formatting and original UTC title.
- Default additional data to hidden. Clicking anywhere on an entry with `additional_data !== undefined` toggles formatted JSON underneath the message in the same message cell; no extra column. Allow multiple entries to expand independently. Entries without additional data remain noninteractive. Preserve `null`, `false`, `0`, empty string, malformed JSON, and literal text rendering; never inject HTML.
- Provide a keyboard-focusable control with accessible expanded state and an obvious disclosure indicator. Enter/Space and pointer activation toggle identically; text selection and existing Copy/Clean/Close actions remain usable. Ensure no double toggles from bubbled events.
- Make narrow/mobile layout readable without message or data clipping. Preserve scrolling, sticky headings, log ordering, original Copy payload, clean/read errors, and in-flight open/close guards.
- **Interfaces:**
  - **Consumes:** `LogsModal` constructor `(app: App, readLogs: () => Promise<string>, clearLogs: () => Promise<void>)`; existing `parseEntry(line: string)` return shape; raw JSONL logs.
  - **Produces:** three accessible table columns; per-entry expanded/collapsed UI; no changes to log format or constructor signature.

### 6. Clarify plugin uninstall conflict action

- In `src/views/conflicts-resolution/plugin-uninstall-conflict.tsx`, rename **Keep local plugin and settings** to **Keep installed**, and **Accept uninstall and remove local changes** to **Uninstall**. The keep action still chooses `keep-local`; this is a label change, not a new guarantee that package installation or enablement has already completed.
- Update affected button queries in `plugin-uninstall-conflict.test.tsx` and `plugin-uninstall-integration.test.tsx`. Verify both desktop split and mobile unified views still deliver `keep-local` and `accept-uninstall` without modifying their existing behavior.
- **Interfaces:**
  - **Consumes:** `PluginUninstallConflict` props `{ pluginId: string; localPaths: string[]; onResolve: (choice: PluginUninstallChoice) => void }`; `PluginUninstallChoice = "keep-local" | "accept-uninstall"`.
  - **Produces:** clearer button text; unchanged callback, resolution choice, and sync semantics.

### 7. Verification

- Run focused Vitest cases for path helpers, `src/sync-manager.test.ts`, plugin two-device fixture, and `src/settings/logs-modal.test.ts`; run `npm run test -- --run` and `npm run build`.
- Exercise the modal at desktop and mobile widths, opening and closing individual rows with pointer and keyboard; verify long JSON wrapping and no data clipping. Use available UI surface or record any limitation rather than claim device QA.
- If physical Mac and Android test vaults are available, use disposable vaults and an isolated repository for the full flow. Do not modify the user's real vault as part of this plan. Record actual evidence, timings, and remaining uncertainty in build artifacts.
- **Interfaces:**
  - **Consumes:** npm scripts `test` and `build`; the behavioral scenarios below; available test harness or disposable Obsidian vaults.
  - **Produces:** test/build results, red/green evidence, UI checks, and a clear physical-device verification status.

## Test Scenarios

| Scenario | Expected behavior |
|---|---|
| Android installs plugin; Mac lacks folder | Mac downloads manifest, creates folder, installs and syncs; Android keeps it after next sync. |
| Matching metadata SHA but manifest absent | Download recreates manifest and folder instead of silently returning. |
| Matching metadata SHA and file present | Existing no-download optimization remains. |
| Matching metadata SHA and directory at file path | Fail clearly instead of recording a directory as a downloaded file. |
| Conflict `data.json` parent absent | Parent is created, resolution written and sync completes. |
| Local tombstone, remote live file downloaded | Committed snapshot reflects accepted live file, not stale deletion. |
| Remote-only downloaded file | Corresponding live metadata survives commit alongside remote tree entry. |
| Explicit remote uninstall and real local edits | Existing keep-local / accept-uninstall choices remain correct; absent folder alone never proves uninstall. |
| Explicit plugin uninstall | Plugin unloads and its folder, files, and nested folders are removed recursively. |
| Multiple missing ancestors or root-level file | Missing ancestors created in order; root-level file requires no parent mkdir. |
| Parent is a file, permission failure, or invalid path | Error propagates with path and cause; no false success or blanket suppression. |
| Concurrent mkdir / missing-parent write race | Existing folder succeeds; reliable ENOENT gets at most one retry; other errors propagate. |
| mkdir and existence recheck both fail | Preserve original mkdir error as cause and retain recheck failure in diagnostics. |
| Parent creation fails before publication | No remote branch update occurs. |
| Local write fails after publication | Error accurately states remote may already be updated; no false atomicity claim. |
| Concurrent unrelated metadata event | Frozen snapshot excludes unrelated live-only change and existing concurrency tests remain green. |
| Plugin uninstall conflict button | Keep label explicitly says installed; both choices preserve existing callbacks in split and unified views. |
| Modal row with object, null, false, zero, or empty string data | Only message initially visible; click or keyboard toggles exact safely rendered data beneath it. |
| Modal row with no data or malformed log | Row remains readable, without a misleading disclosure control. |
| Mobile width and long JSON | Timestamp, message, level, and expanded data remain readable via wrapping/scrolling. |
| Copy, clean, close and asynchronous reopen | Existing behavior and raw copied text remain intact. |

## Edge Cases

| Case | Handling | Update feature doc? |
|---|---|---|
| File disappears between exists and write | Retry once only for reliable missing-path errors; propagate other failures. | yes |
| mkdir fails and path recheck also fails | Keep original mkdir error as cause; include the recheck error as secondary context. | no |
| Download succeeds while other metadata changes | Include only the download result in frozen snapshot; preserve concurrent live edits. | yes |
| Remote has a genuine uninstall | Keep existing explicit conflict resolution and tombstone semantics. | yes |
| JSON value is falsey or absent | Distinguish absent from present falsey data in disclosure UI. | no |
| Remote publication succeeded before local write failure | Report remote commit may have happened; do not claim rollback. | yes |

## Deviations

Baseline before logging-toggle adjustment: clean — 298 tests passed across 28 files. Command: `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run` (2026-10-29 11:13 WIB).

Baseline before error-logging review fixes: clean — 282 tests passed across 26 files. Command: `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run` (2026-10-29 11:00 WIB).

Baseline: clean — 265 tests passed across 25 files. Command: `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run`. `npm` was unavailable in PATH; direct bundled Node invocation ran project Vitest successfully.

Follow-up baseline before QA diagnostic fix: clean — 281 tests passed across 26 files. Command: `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run` (2026-10-29 10:21 WIB).

Final run after QA diagnostic fix: 282 tests passed across 26 files. Typecheck `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc --noEmit --skipLibCheck` and production build `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node esbuild.config.mjs production` both passed (2026-10-29 10:33 WIB).

Final run after error-logging review fixes: 298 tests passed across 28 files. Typecheck `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc --noEmit --skipLibCheck`, production build `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node esbuild.config.mjs production`, and `git diff --check` passed (2026-10-29 11:13 WIB).

Final run after logging-toggle correction: 300 tests passed across 28 files. Typecheck `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc --noEmit --skipLibCheck`, production build `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node esbuild.config.mjs production`, and `git diff --check` passed (2026-10-29 11:38 WIB).

| Deviation | Reason | Update feature doc? |
|---|---|---|
| `downloadFile` now returns accepted `FileMetadata` | Sync needs exact download result for frozen manifest snapshot without copying mutable live metadata. Existing callers may ignore return value. | yes |
| Shared retry helper covers binary downloads and conflict writes | One structured `ENOENT` race gets one parent recreation and write retry; generic errors still propagate. | yes |
| User requested explicit uninstall-folder verification | Existing reconciler already calls recursive `rmdir`; test adapter now models and asserts actual folder removal. | yes |
| Error-path logging hardened after Iris-3 review | Preserve nested filesystem causes; report swallowed staging, cleanup, rollback, scan and migration errors when logging is enabled. | yes |
| Logging toggle contract corrected by user | `enableLogging: false` means automatic logger initialization and writes do not create the log file or append entries; initialize lazily when logging becomes enabled. | yes |

### TDD evidence

Command prefix for focused runs: `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run`.

| Slice | Command | RED evidence | GREEN evidence |
|---|---|---|---|
| Baseline | `vitest.mjs run` | — | 265 tests passed, 25 files. |
| Matching SHA / missing first-install path | `src/sync-manager.test.ts -t 'downloads a manifest with a matching metadata SHA when the local file is missing'`; `src/plugin-sync/uninstall-sync.test.ts -t 'downloads live plugin files when matching metadata remains but local folder is missing'` | Blob fetch was skipped; the integration test observed no `writeBinary`. Snapshot check then failed because committed rows retained tombstones. | Focused tests passed; manifest and settings committed live, and a second sync produced no conflict. |
| Path helpers | `src/fs-paths.test.ts` | Five tests failed against interface-only stubs: missing check, mkdir order, file-vs-folder, concurrent mkdir, and error/path handling. | Five helper tests passed. |
| Uninstall folder | `src/plugin-sync/reconciler.test.ts -t 'unloads and removes the folder of a plugin the remote tombstoned'` | Folder existence stayed true because fake `rmdir` did nothing. | Recursive fake adapter removed folder and contents; assertion passed. |
| Conflict destinations / write races | `src/sync-manager.test.ts -t 'commitSync conflict destinations'`; `src/sync-manager.test.ts -t 'recreates a vanished parent and retries a binary write once on ENOENT'` | No preflight failure, structured ENOENT retry, or post-publication context; download failed on first ENOENT. | Five conflict tests passed; downloads retry ENOENT once, while generic write errors stay single-attempt. |
| Logs modal | `src/settings/logs-modal.test.ts` | Seven tests failed on old columns/disclosure; keyboard activation failed before key handling. | Twenty tests passed, covering falsey JSON, row/pointer/keyboard disclosure, independent rows, copy, cleanup, and errors. |
| Uninstall labels | `src/views/conflicts-resolution/plugin-uninstall-conflict.test.tsx src/views/conflicts-resolution/plugin-uninstall-integration.test.tsx` | Five component and split/unified cases could not find shortened labels. | All tests passed; both callbacks retain existing choices. |
| Matching-SHA destination type | `src/sync-manager.test.ts -t 'does not accept a matching-SHA directory as a downloaded file'` | Test resolved metadata without inspecting destination type. | Test passes after requiring `stat.type === "file"`; directory paths now fail clearly. |
| Preserve mkdir cause when recheck fails | `src/fs-paths.test.ts -t 'preserves mkdir failure when the existence recheck also fails'` | Expected cause `EACCES` and both diagnostics; received cause `EIO` from recheck. | Focused path helper suite passes (6 tests); wrapper keeps mkdir error as cause and includes recheck error in message. |
| Logger persistence and fallback | `src/logger.test.ts` | Disabled logging still created a file and persisted ERROR entries; append failure rejected without fallback. | Disabled logging performs no file I/O; enabled logging initializes lazily, preserves nested causes, and reports logger path failures to fallback (6 tests pass). |
| Removal-scan and package staging paths | `src/plugin-sync/reconciler-logging.test.ts` | Two removal-scan failures produced no entries; staging failure lacked a logged path and `EACCES`. | Scan list/read and staging failures log paths plus nested cause when enabled; disabled logging writes no entries (9 tests pass). |
| Installer staging, cleanup, and rollback | `src/plugin-sync/installer-logging.test.ts` | Staging mkdir error was swallowed; cleanup and rollback failures produced no diagnostics (3 failures). | Staging errors propagate with path/cause; cleanup and rollback errors log affected path and code (3 tests pass). |
| Sync and first-sync error handling | `src/sync-manager.test.ts -t 'logs nested filesystem causes'` and `-t 'logs first-sync filesystem failures'` | Logger rejection skipped the failure Notice; first-sync path failures had no log entry. | Both paths preserve nested causes; sync Notice survives logger failure; unreadable manifests log path and cause. |
| Metadata commit persistence | `src/sync-manager.test.ts -t 'propagates metadata persistence failure during commit'` | `commitSync()` resolved before its unawaited metadata write rejected. | Awaited persistence now rejects through sync error handling; startup metadata-load failures are logged with serialized cause. |
| Filename migration path errors | `src/sync-manager-migration.test.ts -t 'logs folder creation failures'` and `-t 'logs file migration failures'` | Both swallowed path failures bypassed ERROR logging. | Folder and rename failures log paths, destination, filesystem codes, and causes. |
| Final verification after logging fixes | `vitest.mjs run`; `tsc --noEmit --skipLibCheck`; `node esbuild.config.mjs production`; `git diff --check` | — | 300 tests passed across 28 files; typecheck, production build, and diff check passed. |
| Parent-enforcing integration fixture | `src/plugin-sync/uninstall-sync.test.ts -t 'downloads live plugin files when matching metadata remains but local folder is missing'` | Strict write failed with `ENOENT` because fixture mkdir did not create directories. | Fixture mkdir creates tracked directories; strict writes pass and second sync remains clean. |
| Final verification | `vitest.mjs run`; `tsc --noEmit --skipLibCheck`; `node esbuild.config.mjs production` | — | 281 tests passed across 26 files; typecheck and production build passed. |

Initial implementation verification: 281 tests passed across 26 files. Bundled Node TypeScript check and production esbuild build passed. `npm` is absent from PATH, so direct bundled Node commands replaced npm scripts. Desktop/mobile visual QA and physical Mac/Android vault sync were not run at that stage; the later QA sweep records browser evidence and device limitations.

## Open Questions

None. User selected dedicated path functions, TDD, the timestamp / message / level column order, and a keep button that explicitly says installed.

## QA Sweep

### Header

- Runtime: Playwright Automation Script (frontend diff; production `LogsModal` and `styles.css` exercised in a headed browser harness with Obsidian host shims).
- Scenarios: 5 happy / 10 edge / 4 negative.
- Critique: 0 blocker / 0 major / 1 minor / 0 nit.
- Critique mode: parallel-angles (files: 12, lines: 605, threshold: 10 files / 500 lines).
- Pipeline order: pre-iris-5.
- Device QA: physical Mac/Android sync and actual Obsidian mobile touch remain untested; runbook requires disposable vaults and an isolated repository.
- Coverage gaps waived by user approval: physical device sync and slow-network injection remain deferred.

### Taxonomy N/A

| Entry | Reason | Confirm? |
|---|---|---|
| auth-fail | Authentication and credential handling were unchanged; no auth code path is part of this patch. | auto-confirmed |
| i18n | This patch changes existing English UI labels; repository has no localization surface. | **needs human confirmation — i18n marked N/A on FE diff** |

### Scenario Matrix

| # | Family | Scenario | Source | Expected |
|---|---|---|---|---|
| H1 | happy | Android installs plugin; Mac starts without its plugin folder; Mac syncs, then Android syncs again. | Plan Test Scenarios: first-install and tombstone cases; `uninstall-sync.test.ts` | Mac creates folders and downloads files; committed metadata stays live; next sync creates no uninstall conflict. |
| H2 | happy | Matching metadata SHA and existing local file. | Plan Test Scenarios: matching-SHA optimization; `sync-manager.test.ts` | No blob fetch or rewrite. |
| H3 | happy | Remote-only plugin file downloads and enters committed snapshot. | Plan Test Scenarios: remote-only file; `sync-manager.test.ts`, `uninstall-sync.test.ts` | Remote file and live metadata remain aligned after commit. |
| H4 | happy | Resolve plugin uninstall conflict using both button choices. | Plan Test Scenarios: conflict button; conflict component and integration tests | **Keep installed** preserves `keep-local`; **Uninstall** preserves `accept-uninstall`. |
| H5 | happy | Open logs with ordinary message and additional data. | Plan Step 5; `logs-modal.test.ts`; headed Playwright | Three columns render; only message appears until disclosure; level sits to its right. |
| E1 | edge | Create multiple missing ancestors and a root-level file destination. | Plan Edge Cases: path creation; `fs-paths.test.ts` | Ancestors are created in order; root-level file creates no directory. |
| E2 | edge | Display an 8 KiB JSON field, then inspect at 390 px viewport. | Plan Test Scenarios: long JSON/mobile; headed Playwright | Data wraps; horizontal scrolling reveals Level without document clipping. |
| E3 | edge | Empty logs and `null`, `false`, `0`, empty-string, or absent additional data. | Plan Edge Cases: falsey data; headed Playwright | Empty state is clear; present falsey values remain distinct; absent data has no disclosure. |
| E4 | edge | Toggle independent rows with pointer, Enter, and Space; select message text. | Plan Step 5 accessibility/interaction requirements; headed Playwright | Each row toggles independently; keyboard works; text selection does not expand a row. |
| E5 | edge | Scroll the narrow log table to inspect timestamp, message, and level. | Plan Test Scenarios: mobile readability; headed Playwright | Horizontal scroll exposes each column; long content remains readable. |
| E6 | edge | Receive explicit remote uninstall with local edits; accept uninstall. | Plan Test Scenarios: uninstall semantics/folder cleanup; `uninstall-sync.test.ts`, `reconciler.test.ts` | Existing conflict choice stays intact; accepted removal unloads plugin and deletes its folder recursively. |
| E7 | edge | Concurrent mkdir, one structured ENOENT write race, and unrelated metadata edit. | Plan Edge Cases: races/concurrent changes; `fs-paths.test.ts`, `sync-manager.test.ts` | One retry only; concurrent directory creation is accepted only if folder exists; unrelated metadata stays out of frozen snapshot. |
| E8 | edge | Clean/copy logs, close and reopen while prior read is pending. | Plan Test Scenarios: copy/clean/close/reopen; headed Playwright | Raw log text copies; clean empties view; Close removes modal; stale response cannot replace reopened logs. |
| E9 | edge | Delay GitHub blob response during a disposable first-install sync. | edge-taxonomy: slow-network; manual runbook | Sync waits; no success is reported before fetch/write completes. **Not run; manual checklist pending.** |
| E10 | edge | GitHub blob request fails during a download. | edge-taxonomy: network-fail; existing `sync-manager.test.ts` cases | Failure is surfaced; no false successful download metadata is recorded. |
| N1 | negative | Matching-SHA destination is a directory; reject traversal or absolute vault path. | Plan Test Scenarios: path type/invalid path; `sync-manager.test.ts`, `fs-paths.test.ts` | Fail with path context; do not fetch or write outside vault. |
| N2 | negative | Parent component is a file, or mkdir fails with permission error before publication. | Plan Test Scenarios: parent/permission/pre-publication; `fs-paths.test.ts`, `sync-manager.test.ts` | Propagate path and cause; branch head is not updated. |
| N3 | negative | Local conflict write fails after remote publication, including failed ENOENT retry. | Plan Test Scenarios: post-publication write failure; `sync-manager.test.ts` | Error states remote commit may already exist and preserves write cause. |
| N4 | negative | Log input is malformed or contains HTML-like text. | Plan Test Scenarios: malformed/safe rendering; headed Playwright | Raw line stays readable as text; no element is injected. |

### Coverage Gaps

| Missing execution | Reason |
|---|---|
| Physical Mac/Android first-install sync and actual Obsidian theme/touch behavior | No disposable device vaults or isolated repository were available; runbook provides a safe checklist. |
| Slow-network injection against GitHub blob fetch | Browser harness covers delayed modal reads, but no isolated remote/network throttle was available. |

### Critique

| Severity | Angle | File:line | Finding | Suggested fix |
|---|---|---|---|---|
| minor | error-handling | `src/fs-paths.ts:70` | If `mkdir` fails and its follow-up `exists` check also fails, the check wrapper replaces the original mkdir error as the cause. | Preserve mkdir as primary cause and retain the recheck failure as context. |

No actionable findings from security, UX/accessibility, or performance/concurrency angles. Plan-conformance review found implementation and documented behavior aligned; the physical-device limitation is recorded above. Critique is advisory; no implementation code changed during QA.

Follow-up: the minor cause-preservation finding was fixed through Iris-2; regression RED/GREEN and final verification appear under `## Deviations`.

### Run Results

- Command: `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run`
- Run at: 2026-10-29 10:21 WIB
- Result: PASS — 26 test files, 281 tests.
- Command: `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node .knowledge/features/community-plugin-sync/qa/plan-first-install-and-log-modal/helpers/qa-run.mjs`
- Run at: 2026-10-29 10:27 WIB
- Result: PASS — headed Chromium; pointer, Enter/Space, text selection, falsey values, malformed input, safe rendering, long JSON, mobile scroll, Copy/Clean/Close, and async reopen.
- Mobile measure: viewport/document 390 px; content 311 px; table content 383 px; Level column becomes visible after horizontal scroll.
- Host limitation: browser harness uses shipped modal source and CSS with host shims; no Obsidian vault opened.
- QA artifacts: `.knowledge/features/community-plugin-sync/qa/plan-first-install-and-log-modal/` (runbook, helper, execution log, screenshots, angle reviews).
