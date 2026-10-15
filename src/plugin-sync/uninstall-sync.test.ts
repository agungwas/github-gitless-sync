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
  const pluginManager = {
    plugins: { [PLUGIN_ID]: {} } as Record<string, unknown>,
    disablePlugin: unload,
    enablePlugin: vi.fn(async () => undefined),
  };
  const adapter = {
    exists: vi.fn(async (path: string) => localFiles.has(path) || [...localFiles.keys()].some((key) => key.startsWith(`${path}/`))),
    list: vi.fn(async (folder: string) => {
      const files: string[] = [];
      const folders = new Set<string>();
      for (const path of localFiles.keys()) {
        if (!path.startsWith(`${folder}/`)) continue;
        const relative = path.slice(folder.length + 1);
        if (relative.includes("/")) folders.add(`${folder}/${relative.split("/")[0]}`);
        else files.push(path);
      }
      return { files, folders: [...folders] };
    }),
    read: vi.fn(async (path: string) => {
      const text = localFiles.get(path);
      if (text === undefined) throw new Error(`Missing fixture file: ${path}`);
      return text;
    }),
    readBinary: vi.fn(async (path: string) => new TextEncoder().encode(localFiles.get(path)!).buffer),
    write: vi.fn(async (path: string, text: string) => { localFiles.set(path, text); }),
    writeBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => { localFiles.set(path, new TextDecoder().decode(bytes)); }),
    remove: vi.fn(async (path: string) => { localFiles.delete(path); }),
    rmdir: vi.fn(async (folder: string) => {
      for (const path of localFiles.keys()) if (path.startsWith(`${folder}/`)) localFiles.delete(path);
    }),
    mkdir: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ mtime: localModifiedAt, ctime: localModifiedAt, size: 1, type: "file" })),
  };
  const manager = new SyncManager(
    { configDir: ".obsidian", adapter } as unknown as Vault,
    {
      ...DEFAULT_SETTINGS, syncCommunityPlugins: nativeSyncEnabled, syncConfigDir: true,
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
    manager, internals, localFiles, remoteFiles, trackedFiles, conflicts, unload, adapter,
    sync: () => internals.syncImpl(),
    remoteMetadata: () => JSON.parse(remoteFiles.get(METADATA_PATH)!) as Metadata,
  };
}

describe("macOS uninstall received by Android", () => {
  const managers: SyncManager[] = [];
  afterEach(() => {
    for (const manager of managers.splice(0)) manager.stopPluginSync();
    vi.restoreAllMocks();
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
