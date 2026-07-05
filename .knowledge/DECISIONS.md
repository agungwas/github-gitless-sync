---
updated: "2026-07-05"
---
# Decisions

## 2026-07-05 — Widen Remote-Orphan Cleanup to Cover syncConfigDir-Off Files
**Chose:** swap `computeExcludedRemoteOrphans()`'s filter from `shouldSkipFile()` to `!isPathSyncable()` (strict widening — every prior case still caught), for `sync`. **Over:** duplicating the syncConfigDir/dot-file checks inline (same duplication problem already rejected once); widening `shouldSkipFile()` itself (risks double-negation at its other call sites, which have their own separate syncConfigDir checks).
**Why:** QA on `plan-fix-preview-accuracy-and-delete-visibility.md` found turning `syncConfigDir` off orphans configDir files on GitHub forever — same bug class the pattern-exclude fix solved, unreached by it since `shouldSkipFile()` has no `syncConfigDir` awareness.
**Plan:** ./features/sync/plans/plan-fix-syncconfigdir-remote-orphans.md

## 2026-07-05 — Fix Preview Accuracy (syncConfigDir) + Surface Remote-Delete Count
**Chose:** new `isPathSyncable()` method (layers `syncConfigDir` gate + dot-file skip on top of `shouldSkipFile()`) for the Preview button's accuracy fix; post-sync Notice count for the delete-visibility mitigation, for `sync`. **Over:** inlining the checks in `tab.ts` (duplicates logic across call sites); fixing `syncConfigDir` only and skipping dot-files (partial fix for no real savings); log-line-only visibility (still requires opening logs to notice); pre-sync confirmation modal (disproportionate — Gate G established the risk is git-history-recoverable, not permanent).
**Why:** QA sweep on `plan-pattern-settings-ux-and-remote-cleanup.md` found 1 major (Preview misreports `.obsidian/*` files when `syncConfigDir` is off, the default) + 1 blocker (delete-on-exclude had no visible confirmation beyond a generic debug log) — human chose `act-on-critique`, then on Gate G reframe accepted a proportionate fix over heavier options.
**Plan:** ./features/sync/plans/plan-fix-preview-accuracy-and-delete-visibility.md

## 2026-07-05 — Pattern Settings UX Fix + Remote-Orphan Cleanup + Local Diff Preview
**Chose:** (1) explicit "+ Add pattern" button, remove `display()`-on-keystroke; (2) delete-from-remote fires on the *next* regular `sync()` via existing `delete_remote` pipeline, not immediately from settings; (3) local-only pattern-preview modal (no GitHub call), for `sync`. **Over:** (1) targeted DOM insert (fights Setting builder, no clean API); (2) immediate remote delete from settings (breaks "remote changes only via explicit Sync" contract) and a manual cleanup button (duplicates what next-sync already covers); (3) remote-aware preview button (adds API dependency to answer what item 2 already resolves) and live per-row match-count (previously rejected for perf reasons in `plan-fix-exclude-patterns-qa-findings.md`).
**Why:** Item 2 reverses `plan-exclude-patterns.md`'s original "exclude never touches remote" decision because real usage showed it surprising; reusing the existing tested `delete_remote` pipeline avoids a new remote-write path entirely.
**Plan:** ./features/sync/plans/plan-pattern-settings-ux-and-remote-cleanup.md

## 2026-07-05 — Harden Exclude-Patterns Against Remaining Minor QA Findings (Option C: split treatment)
**Chose:** Silent internal pattern-length cap in `matchesAny()` (same class as existing blank/malformed handling, no UI) + fully closing the residual sync race via a tracked `pendingMetadataCleanup` promise that `sync()`/`firstSync()` await, for `sync`. **Over:** minimal (same cap, but race fix only narrows via a second `syncing` re-check, doesn't close it), full UX treatment (surfaces the length cap in settings UI — reopens the UI-validation scope-creep concern the original build's Option C already rejected).
**Why:** Full race closure costs about the same code as narrowing it, so no reason to settle for narrower. UI validation is a product decision (threshold, message, hard-block vs warn) that doesn't belong in a reactive hardening pass.
**Plan:** ./features/sync/plans/plan-harden-exclude-patterns.md

## 2026-07-05 — Fix Exclude-Patterns QA Blockers (Option B: blockers + causally-linked majors)
**Chose:** Fix both confirmed blockers (ReDoS in glob matcher → linear-time non-backtracking matcher; manifest deletion in `removeExcludedFromMetadata` → route through `shouldSkipFile`) plus 2 causally-linked perf majors (`this.syncing` race guard, debounce per-keystroke reconciliation), for `sync`. **Over:** blockers-only (defers fixes to files already being reopened — wasteful sequencing), full 21-finding sweep (bundles UX/design decisions into a bugfix pass; "live match-count" idea would introduce a new perf concern).
**Why:** Both blockers were independently confirmed via live reproduction during QA (4.2s ReDoS hang, verified manifest-path match). The 2 majors touch the same files/methods already being fixed — bundling avoids reopening them twice. UX/a11y findings deferred to their own pass.
**Plan:** ./features/sync/plans/plan-fix-exclude-patterns-qa-findings.md

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
