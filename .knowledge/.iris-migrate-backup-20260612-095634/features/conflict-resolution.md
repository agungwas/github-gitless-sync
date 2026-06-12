# Conflict Resolution View

Last updated: 2026-06-06
Updated by plan: PLAN_conflict-and-settings.md

## Overview

The Conflict Resolution View provides a UI for resolving git merge conflicts. It is triggered during the synchronization process when local and remote file changes clash. The view has two modes:
- **Unified View**: Default for mobile (`Platform.isMobile`). Displays the conflict within a single editor view with inline resolution options and a bottom action bar.
- **Split View**: Default for desktop. Shows remote, local, and result editors side by side.

## Files

| File | Role |
|---|---|
| `src/views/conflicts-resolution/view.tsx` | Entry point. `ConflictsResolutionView` (extends `ItemView`), manages the React root and determines `diffMode` (`split` vs `unified`). |
| `src/views/conflicts-resolution/unified-view/unified-view.tsx` | Main container for the Unified View. Used mostly on mobile. |
| `src/views/conflicts-resolution/unified-view/diff-view.tsx` | Core component for Unified View. Contains the `CodeMirror` editor and the bottom action bar with 4 buttons ("Accept all remote", "Accept all local", "Reset conflicts", "Resolve conflict"). The button container uses `flexWrap: "wrap"` to prevent horizontal overflow on narrow mobile screens. |
| `src/views/conflicts-resolution/unified-view/unified-resolution-bar.tsx` | Inline widget above conflict blocks in the editor. Shows 4 clickable text actions ("Accept above", "Accept below", "Accept both", "Discard both"). |
| `src/views/conflicts-resolution/split-view/split-view.tsx` | Main container for the Split View. Used mostly on desktop. |
| `src/views/conflicts-resolution/split-view/diff-view.tsx` | Core component for Split View with remote/local side-by-side editing. |
| `src/views/conflicts-resolution/split-view/actions-gutter.tsx` | Action buttons between split panes. |
| `src/sync-manager.ts` | Triggers `onConflicts` callback when a conflict is detected during `syncImpl()`. |
| `src/main.ts` | `GitHubSyncPlugin.onConflicts()` receives conflict files, stores a `conflictsResolver` promise, and activates the `ConflictsResolutionView`. |

## UI Components & Flow

1. **Triggering**:
   - `SyncManager.syncImpl()` detects conflicts (`findConflicts()`).
   - It pauses sync by `await this.onConflicts(conflicts)`.
   - `GitHubSyncPlugin` opens `ConflictsResolutionView` and stores a `conflictsResolver` promise.

2. **Mobile Context (Unified View)**:
   - Evaluated in `view.tsx`: `if (Platform.isMobile) diffMode = "unified"`.
   - The **Unified View** relies on `CodeMirror` with `unified-resolution-bar.tsx` injected as an inline widget above conflicts.
   - At the bottom of `diff-view.tsx`, there is a flex container with 4 buttons: "Accept all remote", "Accept all local", "Reset conflicts", "Resolve conflict".
   - It also contains `unified-resolution-bar.tsx` which renders an inline row of 4 text buttons: "Accept above | Accept below | Accept both | Discard both".

3. **Resolution Handoff**:
   - Once the user resolves conflicts (by clicking "Resolve conflict" or similar), `resolveAllConflicts` is called.
   - This invokes `this.plugin.conflictsResolver(resolutions)` in `view.tsx`, which resolves the promise in `main.ts` and allows `syncImpl()` to resume.
   - `clearConflicts()` is then called to prevent re-triggering.

## Cross-Module Links

- `SyncManager` → `GitHubSyncPlugin.onConflicts`: Handoff when conflicts are found.
- `GitHubSyncPlugin` → `ConflictsResolutionView`: Activates the Obsidian UI.
- `ConflictsResolutionView` → `GitHubSyncPlugin.conflictsResolver`: Completes the resolution.
