---
last_updated: "2026-06-12"
updated_by_plan: ""
decision: none
---
# Testing

## Overview

The repository utilizes automated testing instead of providing a standalone web UI or manual sandbox environment outside of Obsidian. Since the plugin's components are tightly coupled to the Obsidian DOM and API (`Plugin`, `ItemView`, `Modal`), the primary testing path is unit testing using mocks.

## Technologies
- **Framework**: `vitest` for running tests.
- **Environment**: `jsdom` to simulate a browser environment for React components.
- **UI Testing**: `@testing-library/react` and `@testing-library/dom` for component assertions.
- **Mocks**: 
  - `sinon` is installed as a dev dependency.
  - `mock-obsidian.ts`: Simulates the Obsidian application environment (e.g. `Vault`, `Notice`, `requestUrl`, and filesystem read/write operations).
  - `vitest.setup.ts`: Sets up the global mocks (stubbing classes like `Plugin`, `ItemView`, global `localStorage`) so that tests run correctly outside of the real Obsidian app.
- **Coverage**: `@vitest/coverage-v8` for test coverage.

## Running Tests

All testing happens via the CLI:
- Run all unit tests: `npm run test`
- Generate test coverage: `npm run test -- --coverage`

## Manual QA Testing
There is no standalone application to run the plugin outside of Obsidian for manual QA. If manual interactions (e.g., clicking the sync button, resolving conflicts in the split view) need to be tested visually:
1. The developer must use a real installation of Obsidian.
2. A separate, empty "sandbox" vault should be created.
3. The built plugin (`main.js`, `manifest.json`, `styles.css`) is deployed into `<sandbox-vault>/.obsidian/plugins/github-gitless-sync/`.
4. Testing is then conducted manually within the Obsidian application.
