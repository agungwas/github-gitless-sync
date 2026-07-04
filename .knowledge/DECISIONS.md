---
updated: "2026-07-04"
---
# Decisions

## 2026-07-04 — Exclude Files/Folders From Sync by Pattern
**Chose:** Gitignore-style glob (`*`, `**`, trailing `/`) across two separate settings arrays — `excludePatterns` + `includePatterns` (include always wins) — matched via one centralized pure function (`isExcludedPath`), reused at all 9 existing filter call-sites, for `sync`. **Over:** simple wildcard-only glob (imprecise), raw JS regex per row (wrong audience), single ordered list with `!`-prefix negation (order-dependent, harder to explain in UI than two plain lists).
**Why:** Glob has ecosystem precedent (Obsidian Git plugin ships the same feature); two independent lists avoid order-dependence entirely; centralizing touches the 9 scattered filter sites mapped by `iris-0a-explore` once instead of twice.
**Plan:** ./features/sync/plans/plan-exclude-patterns.md

## 2026-06-18 — Converge Illegal-Char Filenames on Remote
**Chose:** Migration scan in `SyncManager` (`migrateIllegalFilenames`) reusing `justDownloaded` suppression + soft-delete tombstone, for `file-validation`. **Over:** rely on rename echo alone (fragile on mobile), hard-delete+recreate keys (breaks delete_remote → resurrects), build-fix only (leaves divergence + legacy `>` files stuck behind downloadFile early-return).
**Why:** Soft tombstone of the old `>` key drives `delete_remote`; new `＞` key (`sha:null`) drives `upload`; one commit = atomic remote rename. `justDownloaded` set true only on laptop disk-rename so mobile's first edit isn't swallowed.
**Plan:** ./features/file-validation/plans/plan-sanitize-remote-convergence.md

## 2026-06-18 — Fix EventsListener Edge Cases (QA follow-up)
**Chose:** Option A — fix both F1 (onModify TypeError guard) and F2 (folder delete localPath check) in one plan under `sync`. **Over:** defer F2.
**Why:** Both are ≤4 lines, same file. Fixing while in scope is cheaper than a separate plan.
**Plan:** ./features/sync/plans/plan-fix-events-listener-edge-cases.md

## 2026-06-18 — Fix EventsListener localPath Key Mismatch
**Chose:** Option C — `resolveMetadataKey()` reverse-lookup helper in `EventsListener` for `sync`. **Over:** Option B (inline `renameFrom` field), Option C+ (remote filename sanitization).
**Why:** C fixes the root correctness bug (ghost entries, wrong dirty/deleted tracking for sanitized-filename files) with minimal scope. B/C+ add efficiency gains negligible for a markdown-only vault.
**Plan:** ./features/sync/plans/plan-fix-events-localpath-lookup.md

## 2026-06-18 — Mobile-Illegal Filename Sanitization on Download
**Chose:** Unicode fullwidth lookalike substitution (`>` → `＞`, etc.) per path segment, with optional `localPath` field on `FileMetadata`. **Over:** skip-on-download, percent-encoding, char-name substitution (`gt`).
**Why:** Fullwidth chars are visually near-identical to originals, allowed on iOS/APFS, and don't require changing metadata keys — a new `localPath` field lets all local filesystem ops resolve the right path without touching sync comparison logic.
**Plan:** ./features/file-validation/plans/plan-sanitize-mobile-filenames.md

## 2026-06-17 — Fix QA Findings: firstSyncFromLocal gap, eager-read, split binary error
**Chose:** Three mechanical fixes — wrap `firstSyncFromLocal` read (missed site), restore lazy eval in `syncImpl` upload path, split `commitSync` binary blob try-catch into separate readBinary/createBlob blocks. **Over:** defer F3 (minor). **Why:** F1 is a real correctness gap; F2 restores original behavior (eliminates unnecessary I/O + edge-case regression); F3 adds minimal complexity for clearer diagnostics.
**Plan:** ./features/sync/plans/plan-fix-qa-findings.md

## 2026-06-17 — Filename Context in Filesystem Error Messages
**Chose:** Wrap each bare filesystem op (mkdir, writeBinary, write, remove, readBinary) and the `getRemoteFileContentWithFallback` re-throw with try-catch that embeds the path in the error message. **Over:** Wrapping at the Promise.all level in syncImpl (too indirect) or logging inside the function before re-throwing (double-logs).
**Why:** All paths are already in scope at each site — 4-line try-catch per site, no abstraction, no control-flow change. The top-level sync() catch log automatically gains filename context without modification.
**Plan:** ./features/sync/plans/plan-download-error-context.md

## 2026-06-12 — Sync in Progress Notice
**Chose:** Add inline Notice to sync methods for sync feature. **Over:** Throwing errors and letting UI handle it.
**Why:** Safest and simplest approach that aligns with existing Notification handling logic.
**Plan:** ./features/sync/plans/plan-sync-in-progress-notice.md

## 2026-06-12 — Open conflict view in a new tab by default
**Chose:** Open conflict view in a new tab (or reuse empty tab) instead of indiscriminately replacing the active tab for `conflict-resolution`.
**Why:** Replacing the active tab is highly disruptive to the user's workflow when a sync triggers in the background. Opening a new tab leverages native Obsidian behavior while preserving context.
**Plan:** ./features/conflict-resolution/plans/plan-conflict-open-new-tab.md

## 2026-06-12 — Force Save Before Sync
**Chose:** Await `TextFileView.save()` on all open editors before sync for `sync`. **Over:** Locking the screen during sync, doing nothing.
**Why:** Safely flushes mobile memory to disk before `adapter.read()` without interrupting user typing flow.
**Plan:** ./features/sync/plans/plan-force-save-before-sync.md
