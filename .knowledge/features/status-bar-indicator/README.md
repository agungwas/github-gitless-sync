---
last_updated: "2026-06-13"
updated_by_plan: "none"
decision: "none"
---
# Status Bar Indicator Feature

The Status Bar Indicator displays the sync status of the active note in the Obsidian Status Bar.

## Files

| File | Role |
|---|---|
| [src/main.ts](file:///Users/agung.pratama/Documents/Programming/Project/github-gitless-sync/src/main.ts) | Wires up UI, registers event listeners, and updates the text of the status bar item. |

## Feature Overview

### Status Bar Item Lifecycle
- The status bar item is added via Obsidian's `Plugin.addStatusBarItem()` API if `this.settings.showStatusBarItem` is enabled.
- On plugin load (`onload`), it calls `showStatusBarItem()`.
- When the setting is disabled, or when the plugin unloads (`onunload`), the status bar item is removed from the DOM using `.remove()`.

### Events Listened
To keep the sync status up-to-date, the status bar registers listeners on:
- `active-leaf-change`: Triggered when the user switches to a different file or pane.
- `create` (vault): Triggered when a new file is created.
- `modify` (vault): Triggered when the current file is modified.

### Display Logic
The status bar text is formatted as `GitHub: {state}`, where `{state}` is calculated from the active file path:
- **Untracked**: The file has no metadata entry in the sync store.
- **Outdated**: The file has a metadata entry and `fileData.dirty` is `true` (meaning the local file has changes not yet pushed/synced).
- **Up to date**: The file has a metadata entry and `fileData.dirty` is `false`.

### Mobile Platform Behavior
- By default, Obsidian Mobile hides the status bar container (`.status-bar`) to save screen space.
- The status bar is created in the DOM but is styled as `display: none` by the Obsidian app stylesheet on mobile.
- To display it on mobile, a custom CSS snippet is required:
  ```css
  .is-mobile .app-container .status-bar { 
      display: flex; 
  }
  ```
