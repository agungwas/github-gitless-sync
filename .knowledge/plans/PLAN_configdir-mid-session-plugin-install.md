# Plan: Config Dir Mid-Session Plugin Install Sync
Status: done
Updated by: iris-6-sync-docs 2026-06-02

## Goal

When user installs Obsidian plugin mid-session (after startup, before sync), clicking
sync with `syncConfigDir=true` must pick up new plugin files and upload them.

## Impact Analysis

Reference: [./IMPACT_configdir-mid-session-plugin-install.md](./IMPACT_configdir-mid-session-plugin-install.md)

Affected feature docs to update after implementation: `sync` (`features/sync.md`)

## Design Rationale

No brainstorm was run. Design follows directly from the existing pattern:
`loadMetadata()` already has configDir reconciliation logic at startup. The fix
extracts that logic into a reusable method and calls it at sync time too. No new
architectural concept is introduced.

Additionally: the extracted method fixes a pre-existing gap — when a file has
`deleted=true` in metadata but the file re-appeared on disk (reinstalled plugin),
the old inline code skipped it (checked `!metadata[filePath]`, not `metadata[filePath].deleted`).
Fixing this in the same extracted method is the minimal correct scope.

## Implementation Steps

Files changed: `src/sync-manager.ts`, `src/settings/tab.ts`, `src/settings/settings.ts`.

---

### Step 1 — Extract `reconcileConfigDirFiles()` private method

Add a new private async method to `SyncManager` class in `src/sync-manager.ts`.
Place it after `removeVolatileArtifactsFromLocalMetadata()` (~line 651).

**Signature:**
```typescript
private async reconcileConfigDirFiles(): Promise<void>
```

**Full logic:**
1. Guard: if `!this.settings.syncConfigDir`, return immediately (no-op).
2. Walk `vault.configDir` recursively using the same folder-stack pattern used elsewhere:
   ```
   let configFiles: string[] = [];
   let folders = [this.vault.configDir];
   while (folders.length > 0) {
     const folder = folders.pop();
     if (!folder) continue;
     const res = await this.vault.adapter.list(folder);
     configFiles.push(...res.files);
     folders.push(...res.folders);
   }
   ```
3. Iterate `configFiles`. For each `filePath`, apply ALL of these filters in order — skip if ANY matches:
   - `this.isVolatileSyncArtifact(filePath)` — skips log, workspace.json, workspace-mobile.json
   - `filePath.split("/").last()?.startsWith(".")` — skips hidden files (e.g., `.DS_Store`); same filter used in `firstSyncFromRemote()` at line ~245
4. For each non-skipped file, two cases:
   - **Case A — file not in metadata:** `!this.metadataStore.data.files[filePath]`
     → add entry: `{ path: filePath, sha: null, dirty: false, justDownloaded: false, lastModified: Date.now() }`
   - **Case B — file in metadata with `deleted=true`:** `this.metadataStore.data.files[filePath]?.deleted === true`
     → Get `stat = await this.vault.adapter.stat(filePath)` (returns `null` if file not accessible)
     → Guard: if `stat === null`, skip (defensive; file disappeared between list and stat)
     → Guard: if `stat.mtime <= (this.metadataStore.data.files[filePath].deletedAt as number)`, skip
       (file predates deletion timestamp — unexpected state, leave metadata as-is)
     → Otherwise `stat.mtime > deletedAt`: file appeared/was modified AFTER deletion → reinstalled
     → Reset in-place: `deleted: false, deletedAt: null, sha: null, lastModified: stat.mtime`
     (use actual mtime, not Date.now(), so the sync's SHA comparison reflects real file age)
5. Track `changed: boolean`. If any case A or B matched, `changed = true`.
6. If `changed`: `await this.metadataStore.save()` and log:
   `this.logger.info("Reconciled config dir files into metadata")`

---

### Step 2 — Replace inline reconciliation in `loadMetadata()` with call to new method

In `src/sync-manager.ts`, in `loadMetadata()` at line ~1230:

**Remove** the `else if (this.settings.syncConfigDir)` block (lines 1230–1272, the inline
walk + `configFiles.forEach` + conditional save).

**Replace** with:
```typescript
} else if (this.settings.syncConfigDir) {
  await this.reconcileConfigDirFiles();
}
```

The new method handles everything the inline block did, plus the hidden file filter and
the `deleted=true` case.

Note: the outer `if (Object.keys(this.metadataStore.data.files).length === 0)` block
(the "first ever load" path) walks the full vault including configDir and is NOT replaced
— it stays as-is. Only the `else if` branch is replaced.

---

### Step 3 — Call `reconcileConfigDirFiles()` at start of `syncImpl()`

In `src/sync-manager.ts`, in `syncImpl()` at line ~419, add ONE line immediately after
the `"Starting sync"` log and BEFORE `getRepoContent()`:

```typescript
private async syncImpl() {
  await this.logger.info("Starting sync");
  await this.reconcileConfigDirFiles();                      // ← add this
  const { files, sha: treeSha } = await this.client.getRepoContent({
    retry: true,
  });
  ...
```

This ensures metadata is updated with any mid-session plugin installations before the
conflict detection and action determination read `metadataStore.data.files`.

---

---

### Step 4 — Add device name localStorage constant + commit template to settings

**4a. localStorage key constant**

In `src/sync-manager.ts`, add a module-level constant near the top of the file
(after existing imports, before the class declaration):

```typescript
export const DEVICE_NAME_STORAGE_KEY = "github-gitless-sync-device-name" as const;
```

Exported so settings tab can import it. Single source of truth.

**4b. Commit message template in `GitHubSyncSettings`**

In `src/settings/settings.ts`:

Add field to `GitHubSyncSettings` interface:
```typescript
commitMessageTemplate: string;
```

Add default to `DEFAULT_SETTINGS`:
```typescript
commitMessageTemplate: "Sync from {deviceName} at {YYYY-MM-DD HH:mm}",
```

Template token rules (applied in `commitSync()`, Step 6):
- `{deviceName}` → device name from localStorage (empty string if not set)
- `{ANY_OTHER_TOKEN}` → `moment().format(token)` using Obsidian's bundled moment.js
- Unrecognized tokens that moment rejects → kept as-is (defensive)

---

### Step 5 — Add device name + commit template settings in settings tab

In `src/settings/tab.ts`:

**Imports to add at top:**
```typescript
import { moment } from "obsidian";
import { DEVICE_NAME_STORAGE_KEY } from "src/sync-manager";
```

(`moment` import needed only for the live-preview in the description — optional; if
skipped, omit live preview. `DEVICE_NAME_STORAGE_KEY` import is required.)

In `display()`, add both settings inside the existing `"Sync"` section, after the
`"Sync configs"` toggle block and before the `"Conflict handling"` dropdown (~line 170):

**Setting 1 — Device name (localStorage, never synced):**
```typescript
new Setting(containerEl)
  .setName("Device name")
  .setDesc(
    "Name of this device used in commit messages. Stored locally only — never synced to GitHub.",
  )
  .addText((text) =>
    text
      .setPlaceholder("e.g. MacBook, iPad, Work PC")
      .setValue(window.localStorage.getItem(DEVICE_NAME_STORAGE_KEY) ?? "")
      .onChange((value) => {
        window.localStorage.setItem(DEVICE_NAME_STORAGE_KEY, value.trim());
      }),
  );
```

**Setting 2 — Commit message template (stored in settings, synced):**
```typescript
new Setting(containerEl)
  .setName("Commit message template")
  .setDesc(
    "Template for GitHub commit messages. " +
    "Use {deviceName} for this device's name. " +
    "Use any moment.js format token in braces for date/time, e.g. {YYYY-MM-DD HH:mm}.",
  )
  .addText((text) =>
    text
      .setPlaceholder("Sync from {deviceName} at {YYYY-MM-DD HH:mm}")
      .setValue(this.plugin.settings.commitMessageTemplate)
      .onChange(async (value) => {
        this.plugin.settings.commitMessageTemplate = value || "Sync from {deviceName} at {YYYY-MM-DD HH:mm}";
        await this.plugin.saveSettings();
      }),
  );
```

Notes:
- Device name: `onChange` is synchronous localStorage write, no `saveSettings()` call
- Template: `onChange` calls `saveSettings()` as with other settings fields
- Fallback in onChange: if user clears template, revert to default (prevents blank commit messages)

---

### Step 6 — Update `commitSync()` to parse template

In `src/sync-manager.ts`:

**Add import at top of file:**
```typescript
import { moment } from "obsidian";
```

**Add private static helper method** to `SyncManager` class, place after `calculateSHA()`:

```typescript
private static buildCommitMessage(template: string, deviceName: string): string {
  return template.replace(/\{([^}]+)\}/g, (match, token: string) => {
    if (token === "deviceName") return deviceName;
    const formatted = moment().format(token);
    // moment returns the token itself when format string is invalid;
    // keep original match (with braces) to signal misconfiguration
    return formatted === token ? match : formatted;
  });
}
```

**In `commitSync()`, replace the `createCommit()` call (~line 1118):**

Replace:
```typescript
const commitSha = await this.client.createCommit({
  // TODO: Make this configurable or find a nicer commit message
  message: "Sync",
  treeSha: newTreeSha,
  parent: branchHeadSha,
});
```

With:
```typescript
const deviceName = window.localStorage.getItem(DEVICE_NAME_STORAGE_KEY)?.trim() ?? "";
const message = SyncManager.buildCommitMessage(
  this.settings.commitMessageTemplate,
  deviceName,
);

const commitSha = await this.client.createCommit({
  message,
  treeSha: newTreeSha,
  parent: branchHeadSha,
});
```

**Result examples:**
- Template `Sync from {deviceName} at {YYYY-MM-DD HH:mm}`, device = `MacBook` → `Sync from MacBook at 2026-06-02 14:30`
- Template `Sync from {deviceName} at {YYYY-MM-DD HH:mm}`, device = `` (empty) → `Sync from  at 2026-06-02 14:30`
- Template `{MMMM Do YYYY} — {deviceName}`, device = `iPad` → `June 2nd 2026 — iPad`

---

## Open Questions

**Q1** — Mid-session + before first sync: rare, excluded from this plan. Files installed
BEFORE startup already handled by `loadMetadata()` calling `reconcileConfigDirFiles()` (Step 2).
→ **Resolved. No change needed.**

**Q2** — Always-scan approach confirmed. No optimization in this plan.
→ **Resolved. No change needed.**

**Q3** — Case B uses `stat.mtime > deletedAt` as the reinstall guard (see updated Step 1.4 above).
Files where mtime predates deletedAt are skipped — unexpected state, left untouched.
→ **Resolved. Plan updated.**

## Deviations

Baseline: no test suite exists (no test script, no test files). iris-4 was skipped. Verification via TypeScript compiler only.
Command: `tsc --noEmit --skipLibCheck`
Final run: clean — no errors.

| What changed | Why | Update feature doc? |
|---|---|---|
| iris-4 skipped — no failing tests to drive implementation | User went directly to iris-5 | no |
| `reconcileConfigDirFiles()` uses `for...of` loop instead of `forEach` | `await` inside `forEach` doesn't work correctly; `for...of` needed for async Case B (`vault.adapter.stat()`) | no |
| `moment` import added to `sync-manager.ts` imports block | Required by `buildCommitMessage()`; plan listed it as a separate step but combined with Step 4 implementation for clarity | no |

## Affected Feature Docs

- `features/sync.md` — update Config Dir Sync section, Events Listener section (hidden
  file filter now consistent), Known Gaps (remove "startup-only reconciliation" gap),
  Commit Process section (new message format), new "Device Name" entry
