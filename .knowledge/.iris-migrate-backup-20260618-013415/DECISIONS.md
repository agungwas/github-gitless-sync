---
updated: "2026-06-18"
---
# Decisions

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
