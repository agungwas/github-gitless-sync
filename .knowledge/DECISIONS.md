---
updated: "2026-06-12"
---
# Decisions

## 2026-06-12 — Sync in Progress Notice
**Chose:** Add inline Notice to sync methods for sync feature. **Over:** Throwing errors and letting UI handle it.
**Why:** Safest and simplest approach that aligns with existing Notification handling logic.
**Plan:** ./features/sync/plans/plan-sync-in-progress-notice.md

## 2026-06-12 — Open conflict view in a new tab by default
**Chose:** Open conflict view in a new tab (or reuse empty tab) instead of indiscriminately replacing the active tab for `conflict-resolution`.
**Why:** Replacing the active tab is highly disruptive to the user's workflow when a sync triggers in the background. Opening a new tab leverages native Obsidian behavior while preserving context.
**Plan:** ./features/conflict-resolution/plans/plan-conflict-open-new-tab.md
