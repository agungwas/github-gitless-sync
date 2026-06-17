---
last_updated: "2026-06-12"
updated_by_plan: "none"
decision: "none"
---
# Manual QA and Test Framework

This document outlines the testing systems and procedures available to run manual QA and automated tests without requiring a full Obsidian installation.

## Files and Tools

| File / Directory | Role |
|---|---|
| `vitest.config.ts` & `vitest.setup.ts` | Vitest configuration and global Obsidian API mocks. |
| `mock-obsidian.ts` | Complete mock implementation of Obsidian's `Vault`, `Notice`, and utility globals for Node.js environments. |
| `scratch/qa-sync-simulator.ts` | CLI-based sync simulator allowing interactive manual testing of the git sync engine on the terminal. |
| `scratch/ui-playground.tsx` | React app loading the Conflict Resolution views for browser execution. |
| `scratch/mock-obsidian-ui.ts` | UI-specific mocks for Obsidian APIs (like `Menu` dropdowns) to run inside web browsers. |
| `scratch/ui-playground.html` | HTML container containing CSS mappings for Obsidian's dark theme. |
| `scratch/bundle-ui-playground.js` | Bundler script using esbuild to compile the UI playground. |

## 1. Automated Testing (Vitest)

Unit and integration tests are run in a JSDOM environment where Obsidian APIs are fully mocked out.

- **Run all tests**:
  ```bash
  npm run test -- --run
  ```
- **Run test with coverage**:
  ```bash
  npm run test -- --coverage
  ```

## 2. CLI Sync Engine Simulator (Manual QA)

The CLI simulator is an interactive harness that runs the core `SyncManager` against a real GitHub repository using a mock local vault directory (created under temporary system storage).

### Setup and Execution

1. Export your GitHub credentials as environment variables:
   ```bash
   export GITHUB_TOKEN="your_github_personal_access_token"
   export REPO_OWNER="your_github_username_or_org"
   export REPO_NAME="your_github_repo_name"
   export REPO_BRANCH="main" # optional, defaults to main
   ```
2. Run commands via `npx tsx`:
   - **Help menu**:
     ```bash
     npx tsx scratch/qa-sync-simulator.ts
     ```
   - **First Sync (First Sync from Local)**:
     ```bash
     npx tsx scratch/qa-sync-simulator.ts init
     ```
   - **Incremental Sync**:
     ```bash
     npx tsx scratch/qa-sync-simulator.ts sync
     ```
   - **Modify a Local File**:
     ```bash
     npx tsx scratch/qa-sync-simulator.ts edit note1.md "New content added by QA"
     ```
   - **Delete a Local File**:
     ```bash
     npx tsx scratch/qa-sync-simulator.ts delete note2.md
     ```
   - **View Status (Local Disk vs Metadata Store)**:
     ```bash
     npx tsx scratch/qa-sync-simulator.ts status
     ```

## 3. Browser-Based Conflict Resolution UI Playground (Manual QA)

The browser playground bundles the plugin's React components (`SplitView` and `UnifiedView`) and runs them in a standard web browser. It mocks Obsidian UI components (like dropdown menus) and maps Obsidian dark theme variables.

### Build and Test Instructions

1. Compile the React and CodeMirror components:
   ```bash
   node scratch/bundle-ui-playground.js
   ```
2. Open the HTML file `scratch/ui-playground.html` directly in any web browser:
   - On macOS:
     ```bash
     open scratch/ui-playground.html
     ```
   - On other platforms: Double-click `ui-playground.html` or open it from your browser's file menu.
3. Interactive features to test:
   - **Switch to Unified/Split View**: Renders desktop side-by-side split panels or mobile unified editor.
   - **Simulate Mobile Layout**: Re-layouts the page to a narrow 480px width to check for responsiveness (prevents button/text wrapping issues).
   - **Conflict Resolution Gutters & Bars**: Click the arrows or hover bars (Accept above, Accept below) to resolve differences.
   - **Submit Resolution**: Click the "Resolve conflict" buttons and observe the raw resolution payload output in the "Event Logs" console.
