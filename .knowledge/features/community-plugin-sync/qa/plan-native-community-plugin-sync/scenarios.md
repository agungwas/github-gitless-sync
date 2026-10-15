# QA runbook: metadata-neutral community plugin sync (redesign 2026-10-15)

Plan: `plan-native-community-plugin-sync.md` (Update 2026-10-15). Runtime: Vitest CLI, then manual acceptance in two disposable vaults. Never run against the real vault.

## Automated

```sh
npx vitest run          # 25 files, 252 tests pass
npx tsc --noEmit -skipLibCheck   # clean
npm run build           # ok
```

Mapped scenarios: T1/T18 metadata-store.test; T2 client.test; T4-T6, T8, T14, T17 reconciler.test; T7 reconciler.test (removal scan); T9/T10 uninstall-sync.test; T11 coordinator.test; T12/T16 sync-manager.test; T13 uninstall-sync.test; T15/T20/T21 sync-manager.test + path-policy.test.

## Manual (two disposable vaults A + B, one mobile)

- [ ] T3 A updates plugin X in Obsidian, press Sync: remote tree has manifest (+data.json), no main.js; metadata JSON has only lastSync/files keys.
- [ ] T7 A uninstalls X, press Sync: manifest + data.json entries are `deleted:true,deletedAt` only.
- [ ] T8/T9 B syncs: X removed; with `ask` and an edited data.json, prompt appears.
- [ ] T11 install/enable/disable on A: nothing syncs until button/interval.
- [ ] T19 mobile rewrites community-plugins.json without a desktop-only id; two syncs: id restored once, second sync uploads nothing.
- [ ] T21 syncConfigDir off: Gitless folder neither uploaded nor downloaded.
- [ ] Upgrade: load a metadata file from an earlier dev build; next sync rewrites it with pre-feature shape.
- [ ] Offline hydrate on B: failure notice, old binary kept, retried by next sync in same session.
