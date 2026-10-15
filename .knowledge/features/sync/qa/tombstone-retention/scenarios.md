# QA Runbook — Tombstone Retention

Runtime: CLI/API runbook (non-FE logic; the settings field is Obsidian DOM, checked manually).
Automated: `npx vitest run src/sync-manager.test.ts src/settings/settings.test.ts`.

## Manual checklist (needs a real vault + GitHub repo)
- [ ] M1 (H5) Settings > Sync shows "Deleted file retention (days)" with value 30 on a fresh install and after upgrade.
- [ ] M2 (E1) Type `0`, `-5`, `abc`, empty: stored value is 1, 1, 30, 30. Reload Obsidian, value persists.
- [ ] M3 (H6) Edit `github-sync-metadata.json` in the repo: set a tombstone `deletedAt` to 40 days ago for a path absent from the vault, run Sync. The row is gone from remote metadata and local metadata; log has "Pruned expired tombstones".
- [ ] M4 (E5) Same, but the file exists on disk: row stays.
- [ ] M5 (N3) Make the sync fail (bad token / offline): local metadata keeps the tombstone.
- [ ] M6 (E6) Two devices: device B offline, device A prunes after retention; B syncs. Expect the deleted file to come back (accepted risk, documented).
