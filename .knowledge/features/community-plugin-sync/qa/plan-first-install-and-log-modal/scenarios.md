# QA runbook — first-install sync and log modal

## Scope and safety

Automated runs use in-memory adapters and a browser harness that bundles the production `LogsModal` and `styles.css`. The harness stubs Obsidian's `Modal`, `Setting`, `Notice`, and clipboard APIs. It does not install the plugin into an Obsidian vault.

Run physical sync scenarios only with two disposable vaults and a dedicated isolated GitHub repository. Do not use a personal vault or the production sync repository.

## Automated scenarios

- `node node_modules/vitest/vitest.mjs run` — first-install recovery, snapshot, path creation, ENOENT retry, permission failures, recursive uninstall, and conflict choices.
- `node .knowledge/features/community-plugin-sync/qa/plan-first-install-and-log-modal/helpers/qa-run.mjs` — production log modal and styles in headed Chromium; pointer, Enter/Space, text selection, falsey data, long JSON, mobile width, copy/clean, async close/reopen.

## Manual device checklist — not run

- [ ] Prepare disposable Mac and Android vaults using the same dedicated sync repository; enable community-plugin sync on both.
- [ ] Install an official community plugin on Android, sync, and confirm its manifest/settings files reach the isolated repository.
- [ ] Remove that plugin folder from the disposable Mac vault while preserving matching sync metadata; sync Mac and confirm parent folders and plugin files are restored.
- [ ] Sync Android again; confirm plugin remains installed and no uninstall conflict or tombstone appears.
- [ ] Resolve a plugin settings conflict with **Keep installed** while its parent folder is absent; confirm destination creation and successful local write.
- [ ] In a separate run, choose **Uninstall** and confirm plugin is unloaded and its entire folder, files, and nested folders are removed.
- [ ] Open Logs in Obsidian at desktop and narrow mobile widths; check sticky headers, scrolling, wrapping, keyboard controls, and Copy/Clean/Close.
- [ ] Throttle the blob response in the isolated repository; confirm sync waits and does not record success before the download completes.
- [ ] If testing injected network or permission failures, use only disposable vaults and restore test permissions afterward.

## Manual results

Leave checkboxes unchecked until someone runs the scenarios against disposable Obsidian vaults. Current automated evidence does not establish Mac/Android application behavior or GitHub network timing.
