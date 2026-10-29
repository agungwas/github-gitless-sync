import { afterEach, describe, expect, it, vi } from "vitest";
import { Vault } from "obsidian";
import GithubClient, { GetTreeResponseItem, NewTreeRequestItem } from "../github/client";
import Logger from "../logger";
import MetadataStore, { FileMetadata, Metadata } from "../metadata-store";
import { DEFAULT_SETTINGS } from "../settings/settings";
import SyncManager, { ConflictFile, ConflictResolution } from "../sync-manager";
import { PluginSyncCoordinator } from "./coordinator";

const PLUGIN_ID = "make-md";
const PLUGIN_FOLDER = `.obsidian/plugins/${PLUGIN_ID}`;
const MANIFEST_PATH = `${PLUGIN_FOLDER}/manifest.json`;
const SETTINGS_PATH = `${PLUGIN_FOLDER}/data.json`;
const METADATA_PATH = ".obsidian/github-sync-metadata.json";
const ENABLED_PATH = ".obsidian/community-plugins.json";
const MANIFEST_TEXT = JSON.stringify({ id: PLUGIN_ID, version: "1.0.0" });
const SETTINGS_TEXT = '{"theme":"original"}';

if (!Array.prototype.last) {
  Object.defineProperty(Array.prototype, "last", { configurable: true, value: function<T>(this: T[]) {
    return this[this.length - 1];
  } });
}
if (!Array.prototype.contains) {
  Object.defineProperty(Array.prototype, "contains", { configurable: true, value: Array.prototype.includes });
}

interface SyncInternals {
  metadataStore: MetadataStore;
  client: GithubClient;
  pluginSyncCoordinator: PluginSyncCoordinator;
  syncImpl(): Promise<number>;
}

async function blobSha(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix);
  input.set(bytes, prefix.length);
  const hash = await crypto.subtle.digest("SHA-1", input);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createAndroidFixture(localModifiedAt: number, nativeSyncEnabled = true) {
  const localFiles = new Map<string, string>([
    [MANIFEST_PATH, MANIFEST_TEXT],
    [SETTINGS_PATH, SETTINGS_TEXT],
    [`${PLUGIN_FOLDER}/main.js`, "local plugin executable"],
    [ENABLED_PATH, "[]"],
  ]);
  const localDirectories = new Set<string>();
  for (const path of localFiles.keys()) {
    const segments = path.split("/").slice(0, -1);
    let directory = "";
    for (const segment of segments) {
      directory = directory ? `${directory}/${segment}` : segment;
      localDirectories.add(directory);
    }
  }
  const trackedFiles: Record<string, FileMetadata> = {};
  for (const path of [MANIFEST_PATH, SETTINGS_PATH, ENABLED_PATH]) {
    trackedFiles[path] = {
      path, sha: await blobSha(localFiles.get(path)!), dirty: false,
      justDownloaded: false, lastModified: localModifiedAt,
    };
  }
  const remoteMetadata: Metadata = {
    lastSync: 1_000,
    files: structuredClone(trackedFiles),
  };
  for (const path of [MANIFEST_PATH, SETTINGS_PATH]) {
    remoteMetadata.files[path].deleted = true;
    remoteMetadata.files[path].deletedAt = 1_000;
  }
  const remoteFiles = new Map<string, string>([
    [ENABLED_PATH, "[]"], [METADATA_PATH, JSON.stringify(remoteMetadata)],
  ]);
  let pendingRemoteFiles = new Map(remoteFiles);
  const conflicts = vi.fn<(files: ConflictFile[]) => Promise<ConflictResolution[]>>(async () => {
    throw new Error("Unexpected plugin conflict");
  });
  const unload = vi.fn(async (id: string) => { delete pluginManager.plugins[id]; });
  const enable = vi.fn(async () => undefined);
  const pluginManager = {
    plugins: { [PLUGIN_ID]: {} } as Record<string, unknown>,
    enabledPlugins: new Set<string>(),
    disablePlugin: unload,
    enablePlugin: enable,
  };
  const adapter = {
    exists: vi.fn(async (path: string) => localFiles.has(path) || localDirectories.has(path)),
    list: vi.fn(async (folder: string) => {
      const files: string[] = [];
      const folders = new Set<string>();
      for (const path of localFiles.keys()) {
        if (!path.startsWith(`${folder}/`)) continue;
        const relative = path.slice(folder.length + 1);
        if (relative.includes("/")) folders.add(`${folder}/${relative.split("/")[0]}`);
        else files.push(path);
      }
      for (const path of localDirectories) {
        if (!path.startsWith(`${folder}/`)) continue;
        folders.add(`${folder}/${path.slice(folder.length + 1).split("/")[0]}`);
      }
      return { files, folders: [...folders] };
    }),
    read: vi.fn(async (path: string) => {
      const text = localFiles.get(path);
      if (text === undefined) throw new Error(`Missing fixture file: ${path}`);
      return text;
    }),
    readBinary: vi.fn(async (path: string) => new TextEncoder().encode(localFiles.get(path)!).buffer),
    write: vi.fn(async (path: string, text: string) => {
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent && !localDirectories.has(parent)) throw Object.assign(new Error(`Missing parent: ${parent}`), { code: "ENOENT" });
      localFiles.set(path, text);
    }),
    writeBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => {
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent && !localDirectories.has(parent)) throw Object.assign(new Error(`Missing parent: ${parent}`), { code: "ENOENT" });
      localFiles.set(path, new TextDecoder().decode(bytes));
    }),
    remove: vi.fn(async (path: string) => { localFiles.delete(path); }),
    rmdir: vi.fn(async (folder: string) => {
      for (const path of localFiles.keys()) if (path.startsWith(`${folder}/`)) localFiles.delete(path);
      for (const path of localDirectories) if (path === folder || path.startsWith(`${folder}/`)) localDirectories.delete(path);
    }),
    mkdir: vi.fn(async (path: string) => { localDirectories.add(path); }),
    stat: vi.fn(async (path: string) => ({
      mtime: localModifiedAt,
      ctime: localModifiedAt,
      size: 1,
      type: localFiles.has(path) ? "file" : localDirectories.has(path) ? "folder" : null,
    })),
  };
  const manager = new SyncManager(
    { configDir: ".obsidian", adapter } as unknown as Vault,
    {
      ...DEFAULT_SETTINGS, syncCommunityPlugins: nativeSyncEnabled, syncConfigDir: true,
      tombstoneRetentionDays: 36_500, // fixture timestamps are synthetic; retention is not under test here
      excludePatterns: [".obsidian/plugins/"],
      includePatterns: [".obsidian/plugins/**/manifest.json", ".obsidian/plugins/**/data.json"],
    },
    conflicts,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    undefined,
    "gitless",
    pluginManager,
  );
  const internals = manager as unknown as SyncInternals;
  internals.metadataStore.data = { lastSync: 500, files: trackedFiles };
  const readSnapshot = async () => {
      const files: Record<string, GetTreeResponseItem> = {};
      for (const [path, text] of remoteFiles) {
        files[path] = { path, sha: await blobSha(text), mode: "100644", type: "blob", size: text.length, url: "" };
      }
      return {
        commitSha: "snapshot-commit", treeSha: "snapshot-tree", complete: true,
        files, metadata: JSON.parse(remoteFiles.get(METADATA_PATH)!) as Metadata,
      };
  };
  internals.client = {
    getSnapshot: vi.fn(readSnapshot),
    getRepoContent: vi.fn(async () => {
      const snapshot = await readSnapshot();
      return { files: snapshot.files, sha: snapshot.treeSha };
    }),
    getBranchHeadSha: vi.fn(async () => "snapshot-commit"),
    getBlob: vi.fn(async ({ sha }: { sha: string }) => {
      for (const text of remoteFiles.values()) if (await blobSha(text) === sha) return { content: btoa(text) };
      throw new Error(`Unknown fixture blob: ${sha}`);
    }),
    createTree: vi.fn(async ({ tree }: { tree: { tree: NewTreeRequestItem[] } }) => {
      pendingRemoteFiles = new Map(remoteFiles);
      for (const item of tree.tree) {
        if (item.sha === null) pendingRemoteFiles.delete(item.path);
        else if (item.content !== undefined) pendingRemoteFiles.set(item.path, item.content);
      }
      return "updated-tree";
    }),
    createCommit: vi.fn(async () => "updated-commit"),
    updateBranchHead: vi.fn(async () => {
      remoteFiles.clear();
      for (const entry of pendingRemoteFiles) remoteFiles.set(...entry);
    }),
  } as unknown as GithubClient;
  return {
    manager, internals, localFiles, localDirectories, remoteFiles, trackedFiles, conflicts, unload, enable, adapter, pluginManager,
    sync: () => internals.syncImpl(),
    remoteMetadata: () => JSON.parse(remoteFiles.get(METADATA_PATH)!) as Metadata,
  };
}

function prepareLiveRemotePlugin(fixture: Awaited<ReturnType<typeof createAndroidFixture>>): Metadata {
  const remote = fixture.remoteMetadata();
  for (const path of [MANIFEST_PATH, SETTINGS_PATH]) {
    delete remote.files[path].deleted;
    delete remote.files[path].deletedAt;
    fixture.remoteFiles.set(path, fixture.localFiles.get(path)!);
  }
  return remote;
}

describe("Community plugin sync across devices", () => {
  const managers: SyncManager[] = [];
  afterEach(() => {
    for (const manager of managers.splice(0)) manager.stopPluginSync();
    vi.restoreAllMocks();
  });

  it("does not unload a running delayed plugin when syncing an unrelated change", async () => {
    const fixture = await createAndroidFixture(5_000);
    managers.push(fixture.manager);
    const remote = prepareLiveRemotePlugin(fixture);
    fixture.remoteFiles.set(METADATA_PATH, JSON.stringify(remote));
    fixture.localFiles.set(SETTINGS_PATH, '{"theme":"changed"}');
    fixture.trackedFiles[SETTINGS_PATH].dirty = true;

    await fixture.sync();

    expect(fixture.unload).not.toHaveBeenCalled();
    expect(fixture.localFiles.has(`${PLUGIN_FOLDER}/main.js`)).toBe(true);
  });

  it("downloads a changed enabled list without changing runtime state", async () => {
    const fixture = await createAndroidFixture(5_000);
    managers.push(fixture.manager);
    const remote = prepareLiveRemotePlugin(fixture);
    const enabled = JSON.stringify([PLUGIN_ID]);
    remote.files[ENABLED_PATH].sha = await blobSha(enabled);
    remote.files[ENABLED_PATH].lastModified = 6_000;
    fixture.remoteFiles.set(ENABLED_PATH, enabled);
    fixture.remoteFiles.set(METADATA_PATH, JSON.stringify(remote));

    await fixture.sync();

    expect(fixture.localFiles.get(ENABLED_PATH)).toBe(enabled);
    expect(fixture.pluginManager.enabledPlugins.has(PLUGIN_ID)).toBe(true);
    expect(fixture.unload).not.toHaveBeenCalled();
    expect(fixture.enable).not.toHaveBeenCalled();
  });

  it("defers a downloaded disable while preserving the running plugin", async () => {
    const fixture = await createAndroidFixture(5_000);
    managers.push(fixture.manager);
    const remote = prepareLiveRemotePlugin(fixture);
    const localEnabled = JSON.stringify([PLUGIN_ID]);
    fixture.localFiles.set(ENABLED_PATH, localEnabled);
    fixture.trackedFiles[ENABLED_PATH].sha = await blobSha(localEnabled);
    fixture.pluginManager.enabledPlugins.add(PLUGIN_ID);
    remote.files[ENABLED_PATH].lastModified = 6_000;
    fixture.remoteFiles.set(METADATA_PATH, JSON.stringify(remote));

    await fixture.sync();

    expect(fixture.localFiles.get(ENABLED_PATH)).toBe("[]");
    expect(fixture.pluginManager.enabledPlugins.has(PLUGIN_ID)).toBe(false);
    expect(fixture.unload).not.toHaveBeenCalled();
    expect(fixture.pluginManager.plugins[PLUGIN_ID]).toBeDefined();
  });

  it("does not republish an unchanged manifest when Android's timestamp is newer", async () => {
    const fixture = await createAndroidFixture(5_000);
    managers.push(fixture.manager);

    await fixture.sync();

    expect(fixture.remoteFiles.has(MANIFEST_PATH)).toBe(false);
    expect(fixture.remoteMetadata().files[MANIFEST_PATH]).toMatchObject({ deleted: true });
    expect(fixture.localFiles.has(`${PLUGIN_FOLDER}/main.js`)).toBe(false);
    expect(fixture.unload).toHaveBeenCalledWith(PLUGIN_ID);
    expect(fixture.conflicts).not.toHaveBeenCalled();

    await fixture.sync();
    expect(fixture.remoteFiles.has(MANIFEST_PATH)).toBe(false);
  });

  it("keeps uninstall tombstones in the metadata committed by Android", async () => {
    const fixture = await createAndroidFixture(500);
    managers.push(fixture.manager);

    await fixture.sync();

    for (const path of [MANIFEST_PATH, SETTINGS_PATH]) {
      expect(fixture.remoteMetadata().files[path]).toMatchObject({ deleted: true, deletedAt: 1_000 });
    }
    expect(fixture.remoteFiles.has(MANIFEST_PATH)).toBe(false);
  });

  it("downloads live plugin files when matching metadata remains but local folder is missing", async () => {
    const fixture = await createAndroidFixture(5_000);
    managers.push(fixture.manager);

    const remote = fixture.remoteMetadata();
    for (const path of [MANIFEST_PATH, SETTINGS_PATH]) {
      const remoteFile = remote.files[path];
      delete remoteFile.deleted;
      delete remoteFile.deletedAt;
      remoteFile.lastModified = 5_000;
      fixture.remoteFiles.set(path, path === MANIFEST_PATH ? MANIFEST_TEXT : SETTINGS_TEXT);

      const localFile = fixture.trackedFiles[path];
      localFile.deleted = true;
      localFile.deletedAt = 1_000;
    }
    const enabledPlugins = JSON.stringify([PLUGIN_ID]);
    fixture.remoteFiles.set(ENABLED_PATH, enabledPlugins);
    fixture.localFiles.set(ENABLED_PATH, enabledPlugins);
    fixture.remoteFiles.set(METADATA_PATH, JSON.stringify(remote));
    for (const path of [...fixture.localFiles.keys()]) {
      if (path.startsWith(`${PLUGIN_FOLDER}/`)) fixture.localFiles.delete(path);
    }
    for (const path of [...fixture.localDirectories]) {
      if (path === PLUGIN_FOLDER || path.startsWith(`${PLUGIN_FOLDER}/`)) fixture.localDirectories.delete(path);
    }

    await fixture.sync();

    expect(fixture.adapter.writeBinary).toHaveBeenCalledWith(MANIFEST_PATH, expect.anything());
    expect(fixture.localFiles.has(MANIFEST_PATH)).toBe(true);
    expect(fixture.localDirectories.has(PLUGIN_FOLDER)).toBe(true);
    for (const [path, text] of [[MANIFEST_PATH, MANIFEST_TEXT], [SETTINGS_PATH, SETTINGS_TEXT]] as const) {
      expect(fixture.remoteMetadata().files[path]).toMatchObject({
        sha: await blobSha(text), lastModified: 5_000,
      });
      expect(fixture.remoteMetadata().files[path]).not.toHaveProperty("deleted", true);
    }

    await fixture.sync();
    expect(fixture.conflicts).not.toHaveBeenCalled();
    expect(fixture.remoteMetadata().files[MANIFEST_PATH]).not.toHaveProperty("deleted", true);
    expect(fixture.localFiles.has(MANIFEST_PATH)).toBe(true);
  });

  it("asks before deleting a locally edited settings file", async () => {
    const fixture = await createAndroidFixture(5_000);
    managers.push(fixture.manager);
    fixture.localFiles.set(SETTINGS_PATH, '{"theme":"changed-on-android"}');
    fixture.conflicts.mockImplementation(async (conflicts) => conflicts.map((conflict) => ({
      filePath: conflict.filePath, content: conflict.localContent, pluginUninstallChoice: "keep-local",
    })));

    await fixture.sync();

    expect(fixture.conflicts).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ pluginUninstall: expect.objectContaining({ pluginId: PLUGIN_ID }) }),
    ]));
    expect(fixture.localFiles.get(SETTINGS_PATH)).toBe('{"theme":"changed-on-android"}');
    expect(fixture.remoteFiles.has(MANIFEST_PATH)).toBe(true);
    expect(fixture.localFiles.has(`${PLUGIN_FOLDER}/main.js`)).toBe(true);
  });

  it("preserves legacy manifest deletion while uploading Android settings, matching commit e6a1673", async () => {
    const fixture = await createAndroidFixture(500, false);
    managers.push(fixture.manager);
    const remote = fixture.remoteMetadata();
    delete remote.files[SETTINGS_PATH].deleted;
    delete remote.files[SETTINGS_PATH].deletedAt;
    fixture.remoteFiles.set(SETTINGS_PATH, SETTINGS_TEXT);
    fixture.remoteFiles.set(METADATA_PATH, JSON.stringify(remote));
    fixture.localFiles.set(SETTINGS_PATH, '{"theme":"changed-on-android"}');

    await fixture.sync();

    expect(fixture.remoteFiles.get(SETTINGS_PATH)).toBe('{"theme":"changed-on-android"}');
    expect(fixture.remoteFiles.has(MANIFEST_PATH)).toBe(false);
    expect(fixture.remoteMetadata().files[MANIFEST_PATH]).toMatchObject({ deleted: true, deletedAt: 1_000 });
    expect(fixture.localFiles.has(`${PLUGIN_FOLDER}/main.js`)).toBe(true);
    expect(fixture.unload).not.toHaveBeenCalled();
  });

  it("removes an acknowledged, unedited plugin without asking even when its version differs from the remote one", async () => {
    const fixture = await createAndroidFixture(500);
    managers.push(fixture.manager);
    const updatedManifest = JSON.stringify({ id: PLUGIN_ID, version: "2.0.0" });
    fixture.localFiles.set(MANIFEST_PATH, updatedManifest);
    fixture.trackedFiles[MANIFEST_PATH].sha = await blobSha(updatedManifest);

    await fixture.sync();

    expect(fixture.conflicts).not.toHaveBeenCalled();
    expect(fixture.localFiles.has(`${PLUGIN_FOLDER}/main.js`)).toBe(false);
  });

  it("resolves uninstall conflicts without asking: overwriteLocal removes, overwriteRemote keeps (T10)", async () => {
    for (const [conflictHandling, removed] of [["overwriteLocal", true], ["overwriteRemote", false]] as const) {
      const fixture = await createAndroidFixture(5_000);
      managers.push(fixture.manager);
      (fixture.manager as unknown as { settings: { conflictHandling: string } }).settings.conflictHandling = conflictHandling;
      fixture.localFiles.set(SETTINGS_PATH, '{"theme":"changed-on-android"}');

      await fixture.sync();

      expect(fixture.conflicts).not.toHaveBeenCalled();
      expect(fixture.localFiles.has(`${PLUGIN_FOLDER}/main.js`)).toBe(!removed);
      expect(fixture.remoteFiles.has(MANIFEST_PATH)).toBe(!removed);
    }
  });

  it("writes Gitless's own manifest after its other files without staging (T13)", async () => {
    const fixture = await createAndroidFixture(500);
    managers.push(fixture.manager);
    const selfFolder = ".obsidian/plugins/gitless";
    const remote = fixture.remoteMetadata();
    for (const name of ["manifest.json", "main.js", "styles.css"]) {
      const path = `${selfFolder}/${name}`;
      const text = `remote ${name}`;
      fixture.remoteFiles.set(path, text);
      remote.files[path] = { path, sha: await blobSha(text), dirty: false, justDownloaded: false, lastModified: 1_000 };
    }
    fixture.remoteFiles.set(METADATA_PATH, JSON.stringify(remote));

    await fixture.sync();

    const written = fixture.adapter.writeBinary.mock.calls.map(([path]) => path).filter((path) => path.startsWith(selfFolder));
    expect(written).toHaveLength(3);
    expect(written.at(-1)).toBe(`${selfFolder}/manifest.json`);
    expect([...fixture.localFiles.keys()].some((path) => path.includes(".gitless-plugin-staging"))).toBe(false);
  });
});
