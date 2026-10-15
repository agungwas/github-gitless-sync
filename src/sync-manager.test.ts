import { describe, it, expect, beforeEach, vi } from 'vitest';
import SyncManager from './sync-manager';
import { Vault, Notice } from 'obsidian';
import { GitHubSyncSettings } from './settings/settings';
import Logger from './logger';
import { GetTreeResponseItem } from './github/client';
import { FileMetadata } from './metadata-store';

let mockZipEntries: Array<{ filename: string; directory: boolean; getData?: (writer: any) => Promise<void> }> = [];
vi.mock('@zip.js/zip.js', () => ({
  BlobReader: function BlobReader() {},
  ZipReader: function ZipReader() {
    (this as any).getEntries = () => Promise.resolve(mockZipEntries);
  },
  Uint8ArrayWriter: function Uint8ArrayWriter() {
    (this as any).getData = () => Promise.resolve(new Uint8Array());
  },
}));

if (!(Array.prototype as any).last) {
  (Array.prototype as any).last = function () {
    return this[this.length - 1];
  };
}
if (!(Array.prototype as any).contains) {
  (Array.prototype as any).contains = Array.prototype.includes;
}
if (!(Notice.prototype as any).hide) {
  (Notice.prototype as any).hide = vi.fn();
}

describe('SyncManager - Sync in Progress Notice', () => {
  let syncManager: SyncManager;
  let mockVault: Vault;
  let mockSettings: GitHubSyncSettings;
  let mockLogger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();

    mockVault = {
      adapter: {
        list: vi.fn(),
      },
      getRoot: vi.fn().mockReturnValue({ path: '/' }),
      configDir: '.obsidian'
    } as unknown as Vault;

    mockSettings = {
      githubToken: 'fake-token',
      githubRepo: 'owner/repo',
      githubBranch: 'main',
      syncConfigDir: false,
    } as GitHubSyncSettings;

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;

    syncManager = new SyncManager(
      mockVault,
      mockSettings,
      vi.fn(),
      mockLogger
    );
  });

  it('firstSync shows a Notice when already syncing', async () => {
    // Force syncing to true
    (syncManager as any).syncing = true;

    await syncManager.firstSync();

    // The method should exit early and Notice should be called
    expect(Notice).toHaveBeenCalledWith("First sync already in progress");
  });

  it('sync shows a Notice when already syncing', async () => {
    // Force syncing to true
    (syncManager as any).syncing = true;

    await syncManager.sync();

    // The method should exit early and Notice should be called
    expect(Notice).toHaveBeenCalledWith("Sync already in progress");
  });
});

describe("SyncManager community plugin path policy", () => {
  it("shares managed plugin intent and self package with config sync on, but keeps ordinary binaries local", () => {
    const syncManager = new SyncManager(
      { configDir: ".obsidian" } as unknown as Vault,
      {
        githubToken: "token",
        githubOwner: "owner",
        githubRepo: "vault",
        githubBranch: "main",
        syncConfigDir: true,
        syncCommunityPlugins: true,
        excludePatterns: [".obsidian/plugins/"],
        includePatterns: [".obsidian/plugins/gitless/"],
      } as GitHubSyncSettings,
      vi.fn(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      undefined,
      "gitless",
    );
    const isPathSyncable = (syncManager as unknown as { isPathSyncable(path: string): boolean }).isPathSyncable.bind(syncManager);

    expect(isPathSyncable(".obsidian/community-plugins.json")).toBe(true);
    expect(isPathSyncable(".obsidian/plugins/quickadd/manifest.json")).toBe(true);
    expect(isPathSyncable(".obsidian/plugins/quickadd/data.json")).toBe(true);
    expect(isPathSyncable(".obsidian/plugins/quickadd/main.js")).toBe(false);
    expect(isPathSyncable(".obsidian/plugins/gitless/main.js")).toBe(true);
  });

  it("accepts plugin deletion only for a deleted manifest tombstone and never for Gitless", () => {
    const manager = new SyncManager(
      { configDir: ".obsidian" } as unknown as Vault,
      { syncCommunityPlugins: true, syncConfigDir: false, excludePatterns: [], includePatterns: [] } as unknown as GitHubSyncSettings,
      vi.fn(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      undefined,
      "gitless",
    );
    const internals = manager as unknown as {
      isManagedPluginPath(path: string): boolean;
      hasAcceptedPluginUninstall(path: string, files: Record<string, FileMetadata>): boolean;
    };
    const manifestPath = ".obsidian/plugins/quickadd/manifest.json";

    expect(internals.isManagedPluginPath(manifestPath)).toBe(true);
    expect(internals.hasAcceptedPluginUninstall(manifestPath, {})).toBe(false);
    expect(internals.hasAcceptedPluginUninstall(manifestPath, {
      [manifestPath]: {
        path: manifestPath,
        sha: "old-sha",
        dirty: false,
        justDownloaded: false,
        lastModified: 1,
        deleted: true,
      },
    })).toBe(true);
    expect(internals.isManagedPluginPath(".obsidian/plugins/gitless/manifest.json")).toBe(true);
    expect(internals.hasAcceptedPluginUninstall(".obsidian/plugins/gitless/manifest.json", {
      ".obsidian/plugins/gitless/manifest.json": {
        path: ".obsidian/plugins/gitless/manifest.json",
        sha: "old-sha",
        dirty: false,
        justDownloaded: false,
        lastModified: 1,
        deleted: true,
      },
    })).toBe(false);
  });

  it("removes remote binaries of managed plugins but never the desired-state files or Gitless", () => {
    const manager = new SyncManager(
      { configDir: ".obsidian" } as unknown as Vault,
      { syncCommunityPlugins: true, syncConfigDir: true, includePatterns: [], excludePatterns: [] } as unknown as GitHubSyncSettings,
      vi.fn(), { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    );
    const mainPath = ".obsidian/plugins/quickadd/main.js";
    const stylesPath = ".obsidian/plugins/quickadd/styles.css";
    const selfPath = ".obsidian/plugins/gitless/main.js";
    const manifestPath = ".obsidian/plugins/quickadd/manifest.json";
    const tree = Object.fromEntries([mainPath, stylesPath, selfPath, manifestPath].map((path) => [path, { path } as GetTreeResponseItem]));
    const cleanup = (manager as unknown as {
      computeExcludedRemoteOrphans(tree: Record<string, GetTreeResponseItem>): unknown[];
    }).computeExcludedRemoteOrphans.bind(manager);

    expect(cleanup(tree)).toEqual([
      { type: "delete_remote", filePath: mainPath },
      { type: "delete_remote", filePath: stylesPath },
    ]);
  });

  it("keeps plugin desired-state files on the remote when plugin sync is off (T15)", () => {
    const manager = new SyncManager(
      { configDir: ".obsidian" } as unknown as Vault,
      {
        syncCommunityPlugins: false,
        syncConfigDir: false,
        excludePatterns: [],
        includePatterns: [],
      } as unknown as GitHubSyncSettings,
      vi.fn(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    );
    const cleanup = (manager as unknown as {
      computeExcludedRemoteOrphans(files: Record<string, GetTreeResponseItem>): Array<{ filePath: string }>;
    }).computeExcludedRemoteOrphans.bind(manager);
    const tree = Object.fromEntries([
      ".obsidian/plugins/quickadd/manifest.json",
      ".obsidian/plugins/quickadd/data.json",
      ".obsidian/community-plugins.json",
      ".obsidian/plugins/quickadd/main.js",
    ].map((path) => [path, { path } as GetTreeResponseItem]));

    expect(cleanup(tree)).toEqual([{ type: "delete_remote", filePath: ".obsidian/plugins/quickadd/main.js" }]);
  });

  it("removes the remote data.json the user opted out exactly, but keeps its manifest (T20)", () => {
    const dataPath = ".obsidian/plugins/quickadd/data.json";
    const manifestPath = ".obsidian/plugins/quickadd/manifest.json";
    const manager = new SyncManager(
      { configDir: ".obsidian" } as unknown as Vault,
      {
        syncCommunityPlugins: true,
        syncConfigDir: true,
        excludePatterns: [dataPath],
        includePatterns: [],
      } as unknown as GitHubSyncSettings,
      vi.fn(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    );
    const cleanup = (manager as unknown as {
      computeExcludedRemoteOrphans(files: Record<string, GetTreeResponseItem>): Array<{ filePath: string }>;
    }).computeExcludedRemoteOrphans.bind(manager);
    const tree = Object.fromEntries([dataPath, manifestPath].map((path) => [path, { path } as GetTreeResponseItem]));

    expect(cleanup(tree)).toEqual([{ type: "delete_remote", filePath: dataPath }]);
  });

  it("adopts cloned vault metadata as plain lastSync and files", async () => {
    const store = {
      data: { lastSync: 1, files: {} as Record<string, FileMetadata> },
      save: vi.fn(async () => undefined),
    };
    const manager = new SyncManager(
      { configDir: ".obsidian" } as unknown as Vault,
      { githubOwner: "owner", githubRepo: "vault", githubBranch: "main" } as unknown as GitHubSyncSettings,
      vi.fn(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    );
    (manager as unknown as { metadataStore: unknown }).metadataStore = store;
    const adopt = (manager as unknown as { adoptSharedSnapshot(snapshot: unknown): Promise<boolean> }).adoptSharedSnapshot.bind(manager);

    await expect(adopt({ complete: true, commitSha: "pinned-commit", metadata: { lastSync: 2, files: {} } }))
      .resolves.toBe(true);

    expect(Object.keys(store.data).sort()).toEqual(["files", "lastSync"]);
    expect(store.data.lastSync).toBe(2);
  });

  it("collects hydrate ids from downloaded manifests and settled manifest conflicts, not accepted uninstalls (T16)", () => {
    const manager = new SyncManager(
      { configDir: ".obsidian" } as unknown as Vault,
      { syncCommunityPlugins: true, syncConfigDir: true, excludePatterns: [], includePatterns: [".obsidian/plugins/custom/"] } as unknown as GitHubSyncSettings,
      vi.fn(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      undefined,
      "gitless",
    );
    const collect = (manager as unknown as {
      collectHydrateIds(actions: Array<{ type: string; filePath: string }>, resolutions: Array<{ filePath: string; content: string; pluginUninstallChoice?: string }>): Set<string>;
    }).collectHydrateIds.bind(manager);

    const ids = collect(
      [
        { type: "download", filePath: ".obsidian/plugins/a/manifest.json" },
        { type: "download", filePath: ".obsidian/plugins/a/data.json" },
        { type: "upload", filePath: ".obsidian/plugins/b/manifest.json" },
        { type: "download", filePath: ".obsidian/plugins/custom/manifest.json" },
        { type: "download", filePath: ".obsidian/plugins/gitless/manifest.json" },
      ],
      [
        { filePath: ".obsidian/plugins/c/manifest.json", content: "{}" },
        { filePath: ".obsidian/plugins/d/manifest.json", content: "{}", pluginUninstallChoice: "keep-local" },
        { filePath: ".obsidian/plugins/e/manifest.json", content: "{}", pluginUninstallChoice: "accept-uninstall" },
      ],
    );

    expect([...ids].sort()).toEqual(["a", "c", "d"]);
  });

  it("restores desktop-only ids a mobile rewrite dropped, and nothing else (T12)", async () => {
    const adapter = {
      read: vi.fn(async (path: string) => JSON.stringify({ isDesktopOnly: path.includes("/desktop/") })),
    };
    const manager = new SyncManager(
      { configDir: ".obsidian", adapter } as unknown as Vault,
      { syncCommunityPlugins: true } as unknown as GitHubSyncSettings,
      vi.fn(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    );
    const preserve = (manager as unknown as {
      preserveDesktopOnlyIds(local: string, remote: string): Promise<string | null>;
    }).preserveDesktopOnlyIds.bind(manager);

    const result = await preserve('["a"]', '["a","desktop","other"]');

    expect(JSON.parse(result!)).toEqual(["a", "desktop"]);
    expect(await preserve('["a","desktop"]', '["a","desktop"]')).toBeNull();
    expect(await preserve("not json", '["desktop"]')).toBeNull();
  });

  it("shares Gitless settings only when config sync is on", () => {
    const build = (syncConfigDir: boolean) => new SyncManager(
      { configDir: ".obsidian" } as unknown as Vault,
      { syncCommunityPlugins: true, syncConfigDir, excludePatterns: [], includePatterns: [] } as unknown as GitHubSyncSettings,
      vi.fn(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      undefined,
      "gitless",
    );
    expect(build(true).shouldSkipFile(".obsidian/plugins/gitless/data.json")).toBe(false);
    expect(build(false).shouldSkipFile(".obsidian/plugins/gitless/data.json")).toBe(true);
  });

  it("surfaces local plugin edits against an explicit uninstall as a typed UI conflict", async () => {
    const manifestPath = ".obsidian/plugins/quickadd/manifest.json";
    const settingsPath = ".obsidian/plugins/quickadd/data.json";
    const manifestText = '{"id":"quickadd","version":"1.0.0"}';
    const settingsText = '{"changed":true}';
    const bytes = new Map([
      [manifestPath, new TextEncoder().encode(manifestText).buffer as ArrayBuffer],
      [settingsPath, new TextEncoder().encode(settingsText).buffer as ArrayBuffer],
    ]);
    const manager = new SyncManager(
      { configDir: ".obsidian", adapter: {
        exists: vi.fn(async (path: string) => bytes.has(path)),
        readBinary: vi.fn(async (path: string) => bytes.get(path)!),
        read: vi.fn(async (path: string) => path === manifestPath ? manifestText : settingsText),
      } } as unknown as Vault,
      { syncCommunityPlugins: true, syncConfigDir: false, excludePatterns: [], includePatterns: [] } as unknown as GitHubSyncSettings,
      vi.fn(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      undefined,
      "gitless",
    );
    const base = { dirty: false, justDownloaded: false, lastModified: 1, sha: "base-sha" };
    const localFiles = {
      [manifestPath]: { ...base, path: manifestPath },
      [settingsPath]: { ...base, path: settingsPath },
    };
    (manager as unknown as { metadataStore: { data: { files: typeof localFiles } } }).metadataStore.data = { files: localFiles };
    const remoteFiles = {
      [manifestPath]: {
        ...base, path: manifestPath, deleted: true, deletedAt: 2,
      },
    };
    const findConflicts = (manager as unknown as {
      findPluginUninstallConflicts(remote: typeof remoteFiles, local: typeof localFiles): Promise<unknown[]>;
    }).findPluginUninstallConflicts.bind(manager);

    await expect(findConflicts(remoteFiles, localFiles)).resolves.toMatchObject([{
      filePath: manifestPath,
      pluginUninstall: { pluginId: "quickadd", localPaths: [manifestPath, settingsPath] },
    }]);
  });

  it("does not write accepted uninstall conflict content back after local deletion", () => {
    const manager = new SyncManager(
      { configDir: ".obsidian" } as unknown as Vault,
      { syncCommunityPlugins: true, syncConfigDir: false } as unknown as GitHubSyncSettings,
      vi.fn(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    );
    const shouldApply = (manager as unknown as {
      shouldApplyConflictContent(resolution: { filePath: string; content: string; pluginUninstallChoice?: string }): boolean;
    }).shouldApplyConflictContent.bind(manager);

    expect(shouldApply({ filePath: ".obsidian/plugins/quickadd/manifest.json", content: "{}", pluginUninstallChoice: "accept-uninstall" })).toBe(false);
    expect(shouldApply({ filePath: ".obsidian/plugins/quickadd/manifest.json", content: "{}", pluginUninstallChoice: "keep-local" })).toBe(true);
    expect(shouldApply({ filePath: "notes.md", content: "resolved" })).toBe(true);
  });
});

async function testGitBlobSha(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const input = new Uint8Array(header.length + bytes.length);
  input.set(header);
  input.set(bytes, header.length);
  const hash = await crypto.subtle.digest("SHA-1", input);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe('SyncManager - Filename Context in Filesystem Error Messages', () => {
  let syncManager: SyncManager;
  let mockVault: Vault;
  let mockSettings: GitHubSyncSettings;
  let mockLogger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();

    mockVault = {
      adapter: {
        list: vi.fn(),
        exists: vi.fn(),
        mkdir: vi.fn(),
        writeBinary: vi.fn(),
        remove: vi.fn(),
        read: vi.fn(),
        write: vi.fn(),
        readBinary: vi.fn(),
      },
      getRoot: vi.fn().mockReturnValue({ path: '/' }),
      configDir: '.obsidian',
    } as unknown as Vault;

    mockSettings = {
      githubToken: 'fake-token',
      githubRepo: 'fake-repo',
      githubOwner: 'fake-owner',
      githubBranch: 'main',
      syncConfigDir: false,
    } as GitHubSyncSettings;

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger;

    syncManager = new SyncManager(
      mockVault,
      mockSettings,
      vi.fn(),
      mockLogger,
    );
  });

  describe('downloadFile', () => {
    const mockFile: GetTreeResponseItem = {
      path: 'Books/test.md',
      mode: '100644',
      type: 'blob',
      sha: 'abc123',
      size: 100,
      url: '',
    };

    beforeEach(() => {
      (syncManager as any).metadataStore = {
        data: { files: {} },
        save: vi.fn().mockResolvedValue(undefined),
      };
      (syncManager as any).client = {
        getBlob: vi.fn().mockResolvedValue({ content: 'dGVzdA==' }),
      };
    });

    it('writes Gitless own package files like any ordinary file', async () => {
      (mockVault.adapter.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (mockVault.adapter.writeBinary as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      const selfFile = { ...mockFile, path: '.obsidian/plugins/gitless/main.js' };
      await syncManager.downloadFile(selfFile, 1);
      expect(mockVault.adapter.writeBinary).toHaveBeenCalledWith(
        '.obsidian/plugins/gitless/main.js',
        expect.anything(),
      );
    });

    it('includes folder path in error when mkdir fails', async () => {
      (mockVault.adapter.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (mockVault.adapter.mkdir as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('FOLDER_NOTCREATED'),
      );

      await expect(syncManager.downloadFile(mockFile, Date.now())).rejects.toThrow('Books');
    });

    it('includes file path in error when writeBinary fails', async () => {
      (mockVault.adapter.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (mockVault.adapter.writeBinary as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('FILE_NOTCREATED'),
      );

      await expect(syncManager.downloadFile(mockFile, Date.now())).rejects.toThrow('Books/test.md');
    });
  });

  describe('deleteLocalFile', () => {
    it('includes file path in error when remove fails', async () => {
      const filePath = 'Books/test.md';
      (syncManager as any).metadataStore = {
        data: {
          files: {
            [filePath]: { path: filePath, sha: 'abc', dirty: false, justDownloaded: false, lastModified: 0 },
          },
        },
        save: vi.fn(),
      };
      (mockVault.adapter.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (mockVault.adapter.remove as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('FILE_NOTFOUND'),
      );

      await expect(syncManager.deleteLocalFile(filePath)).rejects.toThrow(filePath);
    });

    it('skips removal and marks deleted when file is already absent on disk', async () => {
      const filePath = 'Books/test.md';
      const metadataEntry = { path: filePath, sha: 'abc', dirty: false, justDownloaded: false, lastModified: 0, deleted: false };
      (syncManager as any).metadataStore = {
        data: {
          files: {
            [filePath]: metadataEntry,
          },
        },
        save: vi.fn(),
      };
      (mockVault.adapter.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await syncManager.deleteLocalFile(filePath);

      expect(mockVault.adapter.remove).not.toHaveBeenCalled();
      expect(metadataEntry.deleted).toBe(true);
    });
  });

  describe('firstSyncFromLocal', () => {
    it('includes file path in error when read fails', async () => {
      const filePath = 'Books/test.md';
      (syncManager as any).metadataStore = {
        data: {
          files: {
            [filePath]: {
              path: filePath,
              sha: null,
              dirty: false,
              justDownloaded: false,
              lastModified: 0,
              deleted: false,
            },
          },
          lastSync: 0,
        },
        save: vi.fn(),
      };
      (mockVault.adapter.read as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('FILE_NOTFOUND'),
      );

      await expect(
        (syncManager as any).firstSyncFromLocal({}, 'treeSha'),
      ).rejects.toThrow(filePath);
    });
  });

  describe('commitSync binary blob', () => {
    const binaryFilePath = 'images/photo.png';
    const treeFiles = {
      [binaryFilePath]: {
        path: binaryFilePath,
        mode: '100644',
        type: 'blob',
        content: 'binaryfile',
      },
    };

    beforeEach(() => {
      (syncManager as any).metadataStore = {
        data: { files: {}, lastSync: 0 },
        save: vi.fn(),
      };
    });

    it('says "Failed to read binary file" when readBinary throws', async () => {
      (syncManager as any).client = {
        createBlob: vi.fn(),
      };
      (mockVault.adapter.readBinary as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('FILE_NOTCREATED'),
      );

      await expect(
        (syncManager as any).commitSync(treeFiles, 'treeSha', {}),
      ).rejects.toThrow('Failed to read binary file');
    });

    it('says "Failed to upload binary blob" when createBlob throws', async () => {
      (mockVault.adapter.readBinary as ReturnType<typeof vi.fn>).mockResolvedValue(
        new ArrayBuffer(4),
      );
      (syncManager as any).client = {
        createBlob: vi.fn().mockRejectedValue(new Error('502 Bad Gateway')),
      };

      await expect(
        (syncManager as any).commitSync(treeFiles, 'treeSha', {}),
      ).rejects.toThrow('Failed to upload binary blob');
    });
  });

  describe('commitSync manifest snapshot (plan-fix-manifest-tree-drift-and-cleanup)', () => {
    const manifestPath = '.obsidian/github-sync-metadata.json';

    beforeEach(() => {
      (syncManager as any).client = {
        createTree: vi.fn().mockResolvedValue('new-tree-sha'),
        getBranchHeadSha: vi.fn().mockResolvedValue('branch-head-sha'),
        createCommit: vi.fn().mockResolvedValue('commit-sha'),
        updateBranchHead: vi.fn().mockResolvedValue(undefined),
      };
    });

    it('builds the manifest content strictly from the passed-in snapshot, never from a live-only key', async () => {
      (syncManager as any).metadataStore = {
        data: {
          lastSync: 0,
          files: {
            'live-only.md': { path: 'live-only.md', sha: null, dirty: true, justDownloaded: false, lastModified: 0 },
          },
        },
        save: vi.fn(),
      };
      const snapshot = {
        'notes/todo.md': { path: 'notes/todo.md', sha: 'old-sha', dirty: false, justDownloaded: false, lastModified: 0 },
      };
      const treeFiles = {
        [manifestPath]: { path: manifestPath, mode: '100644', type: 'blob', sha: 'old-manifest-sha' },
      } as any;

      await (syncManager as any).commitSync(treeFiles, 'treeSha', snapshot);

      const manifestContent = JSON.parse(treeFiles[manifestPath].content);
      expect(manifestContent.files).toEqual(snapshot);
      expect(manifestContent.files['live-only.md']).toBeUndefined();
    });

    it('preserves a live-only key (added after the snapshot was taken) after a successful commit', async () => {
      (syncManager as any).metadataStore = {
        data: {
          lastSync: 0,
          files: {
            'live-only.md': { path: 'live-only.md', sha: null, dirty: true, justDownloaded: false, lastModified: 0 },
          },
        },
        save: vi.fn(),
      };
      const snapshot = {
        'notes/todo.md': { path: 'notes/todo.md', sha: 'old-sha', dirty: false, justDownloaded: false, lastModified: 0 },
      };
      const treeFiles = {
        [manifestPath]: { path: manifestPath, mode: '100644', type: 'blob', sha: 'old-manifest-sha' },
      } as any;

      await (syncManager as any).commitSync(treeFiles, 'treeSha', snapshot);

      expect((syncManager as any).metadataStore.data.files['live-only.md']).toEqual({
        path: 'live-only.md', sha: null, dirty: true, justDownloaded: false, lastModified: 0,
      });
    });

    it('preserves a concurrent edit to an existing tracked key after commit', async () => {
      const file = { path: 'notes/todo.md', sha: 'old-sha', dirty: false, justDownloaded: false, lastModified: 1 };
      const store = {
        data: { lastSync: 0, files: { 'notes/todo.md': { ...file } } },
        save: vi.fn(),
      };
      (syncManager as any).metadataStore = store;
      (syncManager as any).client = {
        createTree: vi.fn().mockImplementation(async () => {
          store.data.files['notes/todo.md'].dirty = true;
          store.data.files['notes/todo.md'].lastModified = 99;
          return 'new-tree-sha';
        }),
        getBranchHeadSha: vi.fn().mockResolvedValue('branch-head-sha'),
        createCommit: vi.fn().mockResolvedValue('commit-sha'),
        updateBranchHead: vi.fn().mockResolvedValue(undefined),
      };
      const snapshot = { 'notes/todo.md': { ...file } };
      const treeFiles = {
        [manifestPath]: { path: manifestPath, mode: '100644', type: 'blob', sha: 'old-manifest-sha' },
      } as any;

      await (syncManager as any).commitSync(treeFiles, 'treeSha', snapshot);

      expect(store.data.files['notes/todo.md']).toMatchObject({ dirty: true, lastModified: 99, sha: 'old-sha' });
    });

    it('uses pinned snapshot commit as parent instead of fetching a moving branch head', async () => {
      const client = {
        createTree: vi.fn().mockResolvedValue('new-tree-sha'),
        getBranchHeadSha: vi.fn().mockResolvedValue('moving-head'),
        createCommit: vi.fn().mockResolvedValue('commit-sha'),
        updateBranchHead: vi.fn().mockResolvedValue(undefined),
      };
      (syncManager as any).client = client;
      (syncManager as any).metadataStore = { data: { lastSync: 0, files: {} }, save: vi.fn() };
      await (syncManager as any).commitSync(
        { [manifestPath]: { path: manifestPath, mode: '100644', type: 'blob', sha: 'old' } },
        'snapshot-tree',
        {},
        [],
        'snapshot-commit',
      );

      expect(client.getBranchHeadSha).not.toHaveBeenCalled();
      expect(client.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parent: 'snapshot-commit' }));
    });
  });

  describe('Mobile Filename Sanitization', () => {
    const illegalFile: GetTreeResponseItem = {
      path: 'Books/Multibagger >100%.md',
      mode: '100644',
      type: 'blob',
      sha: 'abc123',
      size: 100,
      url: '',
    };
    const cleanFile: GetTreeResponseItem = {
      path: 'Books/clean.md',
      mode: '100644',
      type: 'blob',
      sha: 'def456',
      size: 50,
      url: '',
    };

    beforeEach(() => {
      (syncManager as any).metadataStore = {
        data: { files: {} },
        save: vi.fn().mockResolvedValue(undefined),
      };
      (syncManager as any).client = {
        getBlob: vi.fn().mockResolvedValue({ content: 'dGVzdA==' }),
      };
      (mockVault.adapter.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (mockVault.adapter.writeBinary as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    });

    describe('downloadFile', () => {
      it('T9: writes to sanitized local path when filename contains >', async () => {
        await syncManager.downloadFile(illegalFile, Date.now());

        expect(mockVault.adapter.writeBinary).toHaveBeenCalledWith(
          'Books/Multibagger ＞100%.md',
          expect.anything(),
        );
      });

      it('T10: stores remote path as metadata key and sanitized path as localPath', async () => {
        await syncManager.downloadFile(illegalFile, Date.now());

        const metadata = (syncManager as any).metadataStore.data.files['Books/Multibagger >100%.md'];
        expect(metadata).toBeDefined();
        expect(metadata.localPath).toBe('Books/Multibagger ＞100%.md');
      });

      it('T11: does not set localPath for clean filenames (regression guard)', async () => {
        await syncManager.downloadFile(cleanFile, Date.now());

        const metadata = (syncManager as any).metadataStore.data.files['Books/clean.md'];
        expect(metadata).toBeDefined();
        expect(metadata.localPath).toBeUndefined();
      });
    });

    describe('calculateSHA', () => {
      it('T12: reads from localPath when set in metadata', async () => {
        (syncManager as any).metadataStore = {
          data: {
            files: {
              'Books/Multibagger >100%.md': {
                path: 'Books/Multibagger >100%.md',
                sha: 'abc',
                localPath: 'Books/Multibagger ＞100%.md',
                dirty: false,
                justDownloaded: false,
                lastModified: 0,
              },
            },
          },
          save: vi.fn(),
        };
        (mockVault.adapter.readBinary as ReturnType<typeof vi.fn>).mockResolvedValue(new ArrayBuffer(4));

        await syncManager.calculateSHA('Books/Multibagger >100%.md');

        expect(mockVault.adapter.readBinary).toHaveBeenCalledWith('Books/Multibagger ＞100%.md');
        expect(mockVault.adapter.readBinary).not.toHaveBeenCalledWith('Books/Multibagger >100%.md');
      });

      it('T13: reads from normalizedPath when no localPath (regression guard)', async () => {
        (syncManager as any).metadataStore = {
          data: {
            files: {
              'Books/clean.md': {
                path: 'Books/clean.md',
                sha: 'abc',
                dirty: false,
                justDownloaded: false,
                lastModified: 0,
              },
            },
          },
          save: vi.fn(),
        };
        (mockVault.adapter.readBinary as ReturnType<typeof vi.fn>).mockResolvedValue(new ArrayBuffer(4));

        await syncManager.calculateSHA('Books/clean.md');

        expect(mockVault.adapter.readBinary).toHaveBeenCalledWith('Books/clean.md');
      });
    });

    describe('deleteLocalFile', () => {
      it('T14: removes file at localPath when set in metadata', async () => {
        (syncManager as any).metadataStore = {
          data: {
            files: {
              'Books/Multibagger >100%.md': {
                path: 'Books/Multibagger >100%.md',
                sha: 'abc',
                localPath: 'Books/Multibagger ＞100%.md',
                dirty: false,
                justDownloaded: false,
                lastModified: 0,
              },
            },
          },
          save: vi.fn(),
        };
        (mockVault.adapter.remove as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

        await syncManager.deleteLocalFile('Books/Multibagger >100%.md');

        expect(mockVault.adapter.remove).toHaveBeenCalledWith('Books/Multibagger ＞100%.md');
        expect(mockVault.adapter.remove).not.toHaveBeenCalledWith('Books/Multibagger >100%.md');
      });
    });
  });

  describe('shouldSkipFile (plan-exclude-patterns)', () => {
    it('returns true for a volatile artifact regardless of patterns', () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: [], includePatterns: [] };
      const shouldSkipFile = (syncManager as any).shouldSkipFile.bind(syncManager);
      expect(shouldSkipFile('.obsidian/workspace.json')).toBe(true);
    });

    it('returns true for a path matching an exclude pattern', () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      const shouldSkipFile = (syncManager as any).shouldSkipFile.bind(syncManager);
      expect(shouldSkipFile('.obsidian/plugins/foo/main.js')).toBe(true);
    });

    it('returns false when an include pattern overrides the exclude', () => {
      (syncManager as any).settings = {
        ...mockSettings,
        excludePatterns: ['**/main.js'],
        includePatterns: ['gitless/**/main.js'],
      };
      const shouldSkipFile = (syncManager as any).shouldSkipFile.bind(syncManager);
      expect(shouldSkipFile('gitless/plugins/foo/main.js')).toBe(false);
    });

    it('returns false for an ordinary note with no matching pattern', () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      const shouldSkipFile = (syncManager as any).shouldSkipFile.bind(syncManager);
      expect(shouldSkipFile('notes/todo.md')).toBe(false);
    });
  });

  describe('isPathSyncable (plan-fix-preview-accuracy-and-delete-visibility)', () => {
    it('returns true for the manifest regardless of syncConfigDir', () => {
      (syncManager as any).settings = { ...mockSettings, syncConfigDir: false, excludePatterns: [], includePatterns: [] };
      const isPathSyncable = (syncManager as any).isPathSyncable.bind(syncManager);
      expect(isPathSyncable('.obsidian/github-sync-metadata.json')).toBe(true);
    });

    it('returns false for a configDir file when syncConfigDir is false', () => {
      (syncManager as any).settings = { ...mockSettings, syncConfigDir: false, excludePatterns: [], includePatterns: [] };
      const isPathSyncable = (syncManager as any).isPathSyncable.bind(syncManager);
      expect(isPathSyncable('.obsidian/plugins/foo/main.js')).toBe(false);
    });

    it('returns true for a non-dot-prefixed configDir file when syncConfigDir is true', () => {
      (syncManager as any).settings = { ...mockSettings, syncConfigDir: true, excludePatterns: [], includePatterns: [] };
      const isPathSyncable = (syncManager as any).isPathSyncable.bind(syncManager);
      expect(isPathSyncable('.obsidian/plugins/foo/main.js')).toBe(true);
    });

    it('returns false for a dot-prefixed configDir file even when syncConfigDir is true', () => {
      (syncManager as any).settings = { ...mockSettings, syncConfigDir: true, excludePatterns: [], includePatterns: [] };
      const isPathSyncable = (syncManager as any).isPathSyncable.bind(syncManager);
      expect(isPathSyncable('.obsidian/plugins/foo/.hidden')).toBe(false);
    });

    it('is unaffected by syncConfigDir for a non-configDir file', () => {
      (syncManager as any).settings = { ...mockSettings, syncConfigDir: false, excludePatterns: [], includePatterns: [] };
      const isPathSyncable = (syncManager as any).isPathSyncable.bind(syncManager);
      expect(isPathSyncable('notes/todo.md')).toBe(true);
    });

    it('returns false for a path already excluded via patterns, regardless of syncConfigDir', () => {
      (syncManager as any).settings = { ...mockSettings, syncConfigDir: true, excludePatterns: ['**/main.js'], includePatterns: [] };
      const isPathSyncable = (syncManager as any).isPathSyncable.bind(syncManager);
      expect(isPathSyncable('notes/main.js')).toBe(false);
    });
  });

  describe('filterRemoteMetadataFiles with exclude patterns (plan-exclude-patterns)', () => {
    it('strips a path matching an exclude pattern from remote metadata', () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      const filterRemoteMetadataFiles = (syncManager as any).filterRemoteMetadataFiles.bind(syncManager);
      const result = filterRemoteMetadataFiles({
        'notes/todo.md': { path: 'notes/todo.md' },
        '.obsidian/plugins/foo/main.js': { path: '.obsidian/plugins/foo/main.js' },
      });
      expect(Object.keys(result)).toEqual(['notes/todo.md']);
    });
  });

  describe('reconcileConfigDirFiles with exclude patterns (plan-exclude-patterns)', () => {
    it('does not track a configDir file matching an exclude pattern', async () => {
      (syncManager as any).settings = {
        ...mockSettings,
        syncConfigDir: true,
        excludePatterns: ['**/main.js'],
        includePatterns: [],
      };
      (syncManager as any).metadataStore = {
        data: { files: {} },
        save: vi.fn().mockResolvedValue(undefined),
      };
      (mockVault.adapter.list as ReturnType<typeof vi.fn>).mockImplementation((folder: string) => {
        if (folder === '.obsidian') {
          return Promise.resolve({ files: ['.obsidian/plugins/foo/main.js'], folders: [] });
        }
        return Promise.resolve({ files: [], folders: [] });
      });

      const reconcileConfigDirFiles = (syncManager as any).reconcileConfigDirFiles.bind(syncManager);
      await reconcileConfigDirFiles();

      expect((syncManager as any).metadataStore.data.files['.obsidian/plugins/foo/main.js']).toBeUndefined();
    });
  });

  describe('determineSyncActions with exclude patterns (plan-exclude-patterns)', () => {
    it('drops an upload/download action for a file matching an exclude pattern, even when already tracked both sides', async () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      (syncManager as any).calculateSHA = vi.fn().mockResolvedValue('actual-sha-on-disk');

      const remoteFiles = {
        'vendor/foo/main.js': { path: 'vendor/foo/main.js', sha: 'remote-sha' },
      };
      const localFiles = {
        'vendor/foo/main.js': { path: 'vendor/foo/main.js', sha: 'old-local-sha' },
      };

      const actions = await syncManager.determineSyncActions(remoteFiles as any, localFiles as any, []);

      expect(actions).toEqual([]);
    });

    it('still produces an upload action for a non-excluded file with the same shape', async () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      (syncManager as any).calculateSHA = vi.fn().mockResolvedValue('actual-sha-on-disk');

      const remoteFiles = {
        'notes/todo.md': { path: 'notes/todo.md', sha: 'remote-sha' },
      };
      const localFiles = {
        'notes/todo.md': { path: 'notes/todo.md', sha: 'old-local-sha' },
      };

      const actions = await syncManager.determineSyncActions(remoteFiles as any, localFiles as any, []);

      expect(actions).toEqual([{ type: 'upload', filePath: 'notes/todo.md' }]);
    });
  });

  describe('computeExcludedRemoteOrphans (plan-pattern-settings-ux-and-remote-cleanup)', () => {
    it('emits a delete_remote action for an excluded path still present in the raw remote tree', () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      const computeExcludedRemoteOrphans = (syncManager as any).computeExcludedRemoteOrphans.bind(syncManager);

      const files = {
        '.obsidian/plugins/foo/main.js': { path: '.obsidian/plugins/foo/main.js', sha: 'remote-sha' },
        'notes/todo.md': { path: 'notes/todo.md', sha: 'other-sha' },
      };

      expect(computeExcludedRemoteOrphans(files)).toEqual([
        { type: 'delete_remote', filePath: '.obsidian/plugins/foo/main.js' },
      ]);
    });

    it('emits nothing for a pattern that matches no path currently in the remote tree', () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      const computeExcludedRemoteOrphans = (syncManager as any).computeExcludedRemoteOrphans.bind(syncManager);

      const files = {
        'notes/todo.md': { path: 'notes/todo.md', sha: 'other-sha' },
      };

      expect(computeExcludedRemoteOrphans(files)).toEqual([]);
    });

    it('does not orphan a path matched by both exclude and include patterns (include wins), with syncConfigDir on to isolate pattern precedence from the syncConfigDir gate', () => {
      (syncManager as any).settings = {
        ...mockSettings,
        syncConfigDir: true,
        excludePatterns: ['**/main.js'],
        includePatterns: ['.obsidian/plugins/gitless/**/main.js'],
      };
      const computeExcludedRemoteOrphans = (syncManager as any).computeExcludedRemoteOrphans.bind(syncManager);

      const files = {
        '.obsidian/plugins/gitless/main.js': { path: '.obsidian/plugins/gitless/main.js', sha: 'remote-sha' },
      };

      expect(computeExcludedRemoteOrphans(files)).toEqual([]);
    });

    it('never orphans the manifest, even under a broad exclude pattern', () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/*.json'], includePatterns: [] };
      const computeExcludedRemoteOrphans = (syncManager as any).computeExcludedRemoteOrphans.bind(syncManager);

      const files = {
        '.obsidian/github-sync-metadata.json': { path: '.obsidian/github-sync-metadata.json', sha: 'manifest-sha' },
      };

      expect(computeExcludedRemoteOrphans(files)).toEqual([]);
    });

    it('orphans a configDir file with no matching pattern once syncConfigDir is off (plan-fix-syncconfigdir-remote-orphans)', () => {
      (syncManager as any).settings = { ...mockSettings, syncConfigDir: false, excludePatterns: [], includePatterns: [] };
      const computeExcludedRemoteOrphans = (syncManager as any).computeExcludedRemoteOrphans.bind(syncManager);

      const files = {
        '.obsidian/plugins/foo/main.js': { path: '.obsidian/plugins/foo/main.js', sha: 'remote-sha' },
      };

      expect(computeExcludedRemoteOrphans(files)).toEqual([
        { type: 'delete_remote', filePath: '.obsidian/plugins/foo/main.js' },
      ]);
    });

    it('does not orphan a non-dot configDir file when syncConfigDir is on and no pattern matches', () => {
      (syncManager as any).settings = { ...mockSettings, syncConfigDir: true, excludePatterns: [], includePatterns: [] };
      const computeExcludedRemoteOrphans = (syncManager as any).computeExcludedRemoteOrphans.bind(syncManager);

      const files = {
        '.obsidian/plugins/foo/main.js': { path: '.obsidian/plugins/foo/main.js', sha: 'remote-sha' },
      };

      expect(computeExcludedRemoteOrphans(files)).toEqual([]);
    });

    it('preserves plugin desired-state files but orphans binaries when this device has plugin sync off', () => {
      (syncManager as any).settings = { ...mockSettings, syncConfigDir: false, syncCommunityPlugins: false, excludePatterns: [], includePatterns: [] };
      const computeExcludedRemoteOrphans = (syncManager as any).computeExcludedRemoteOrphans.bind(syncManager);
      const files = {
        '.obsidian/plugins/foo/manifest.json': { path: '.obsidian/plugins/foo/manifest.json', sha: 'manifest-sha' },
        '.obsidian/plugins/foo/main.js': { path: '.obsidian/plugins/foo/main.js', sha: 'binary-sha' },
      };

      expect(computeExcludedRemoteOrphans(files)).toEqual([
        { type: 'delete_remote', filePath: '.obsidian/plugins/foo/main.js' },
      ]);
    });

    it('orphans a dot-prefixed configDir file even when syncConfigDir is on', () => {
      (syncManager as any).settings = { ...mockSettings, syncConfigDir: true, excludePatterns: [], includePatterns: [] };
      const computeExcludedRemoteOrphans = (syncManager as any).computeExcludedRemoteOrphans.bind(syncManager);

      const files = {
        '.obsidian/plugins/foo/.hidden': { path: '.obsidian/plugins/foo/.hidden', sha: 'remote-sha' },
      };

      expect(computeExcludedRemoteOrphans(files)).toEqual([
        { type: 'delete_remote', filePath: '.obsidian/plugins/foo/.hidden' },
      ]);
    });
  });

  describe('isPhantomManifestEntry (plan-fix-manifest-tree-drift-and-cleanup)', () => {
    it('returns true when the path has no entry in the raw remote tree', () => {
      const isPhantomManifestEntry = (syncManager as any).isPhantomManifestEntry.bind(syncManager);

      const files = {
        'notes/todo.md': { path: 'notes/todo.md', sha: 'other-sha' },
      };

      expect(isPhantomManifestEntry(files, 'Operasi.md')).toBe(true);
    });

    it('returns false when the path resolves to a valid tree item', () => {
      const isPhantomManifestEntry = (syncManager as any).isPhantomManifestEntry.bind(syncManager);

      const files = {
        'notes/todo.md': { path: 'notes/todo.md', sha: 'other-sha' },
      };

      expect(isPhantomManifestEntry(files, 'notes/todo.md')).toBe(false);
    });
  });

  describe('firstSyncFromRemote with exclude patterns (plan-exclude-patterns)', () => {
    it('never writes an excluded file to disk during ZIP extraction', async () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      (syncManager as any).metadataStore = {
        data: { files: {} },
        save: vi.fn().mockResolvedValue(undefined),
      };
      (syncManager as any).client = {
        downloadRepositoryArchive: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      };
      (syncManager as any).commitSync = vi.fn().mockResolvedValue(undefined);
      (mockVault.adapter.mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (mockVault.adapter.writeBinary as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      mockZipEntries = [
        {
          filename: 'repo-root/vendor/foo/main.js',
          directory: false,
          getData: vi.fn().mockResolvedValue(undefined),
        },
        {
          filename: 'repo-root/notes/todo.md',
          directory: false,
          getData: vi.fn().mockResolvedValue(undefined),
        },
      ];

      await (syncManager as any).firstSyncFromRemote(
        {
          'vendor/foo/main.js': { path: 'vendor/foo/main.js', sha: 'sha-main' },
          'notes/todo.md': { path: 'notes/todo.md', sha: 'sha-todo' },
        },
        'tree-sha',
      );

      expect(mockVault.adapter.writeBinary).not.toHaveBeenCalledWith(
        expect.stringContaining('main.js'),
        expect.anything(),
      );
      expect(mockVault.adapter.writeBinary).toHaveBeenCalledWith(
        'notes/todo.md',
        expect.anything(),
      );
    });
  });

  describe('removeExcludedFromMetadata (plan-exclude-patterns)', () => {
    it('deletes tracked entries matching the current exclude patterns, leaves others', async () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      (syncManager as any).metadataStore = {
        data: {
          files: {
            'vendor/foo/main.js': { path: 'vendor/foo/main.js', sha: 'abc' },
            'notes/todo.md': { path: 'notes/todo.md', sha: 'def' },
          },
        },
        save: vi.fn().mockResolvedValue(undefined),
      };

      await syncManager.removeExcludedFromMetadata();

      expect((syncManager as any).metadataStore.data.files['vendor/foo/main.js']).toBeUndefined();
      expect((syncManager as any).metadataStore.data.files['notes/todo.md']).toBeDefined();
      expect((syncManager as any).metadataStore.save).toHaveBeenCalled();
    });

    it('matches against localPath when the entry has a sanitized local filesystem path', async () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      (syncManager as any).metadataStore = {
        data: {
          files: {
            'vendor/foo>bar/main.js': { path: 'vendor/foo>bar/main.js', localPath: 'vendor/foo＞bar/main.js', sha: 'abc' },
          },
        },
        save: vi.fn().mockResolvedValue(undefined),
      };

      await syncManager.removeExcludedFromMetadata();

      expect((syncManager as any).metadataStore.data.files['vendor/foo>bar/main.js']).toBeUndefined();
    });

    it('never touches any vault adapter API (non-destructive to physical files)', async () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      (syncManager as any).metadataStore = {
        data: { files: { 'vendor/foo/main.js': { path: 'vendor/foo/main.js', sha: 'abc' } } },
        save: vi.fn().mockResolvedValue(undefined),
      };

      await syncManager.removeExcludedFromMetadata();

      expect(mockVault.adapter.remove).not.toHaveBeenCalled();
      expect(mockVault.adapter.writeBinary).not.toHaveBeenCalled();
    });

    it('does not save metadata when nothing changed', async () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      (syncManager as any).metadataStore = {
        data: { files: { 'notes/todo.md': { path: 'notes/todo.md', sha: 'def' } } },
        save: vi.fn().mockResolvedValue(undefined),
      };

      await syncManager.removeExcludedFromMetadata();

      expect((syncManager as any).metadataStore.save).not.toHaveBeenCalled();
    });

    it('never deletes the manifest entry, even when a pattern matches its path (plan-fix-exclude-patterns-qa-findings)', async () => {
      const manifestPath = `${mockVault.configDir}/github-sync-metadata.json`;
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/*.json'], includePatterns: [] };
      (syncManager as any).metadataStore = {
        data: {
          files: {
            [manifestPath]: { path: manifestPath, sha: 'manifest-sha' },
          },
        },
        save: vi.fn().mockResolvedValue(undefined),
      };

      await syncManager.removeExcludedFromMetadata();

      expect((syncManager as any).metadataStore.data.files[manifestPath]).toBeDefined();
    });

    it('is a no-op while a sync is in progress (plan-fix-exclude-patterns-qa-findings)', async () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      (syncManager as any).metadataStore = {
        data: { files: { 'vendor/foo/main.js': { path: 'vendor/foo/main.js', sha: 'abc' } } },
        save: vi.fn().mockResolvedValue(undefined),
      };
      (syncManager as any).syncing = true;

      await syncManager.removeExcludedFromMetadata();

      expect((syncManager as any).metadataStore.data.files['vendor/foo/main.js']).toBeDefined();
      expect((syncManager as any).metadataStore.save).not.toHaveBeenCalled();
    });
  });

  describe('sync race guard (plan-harden-exclude-patterns)', () => {
    function makeDeferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => { resolve = res; });
      return { promise, resolve };
    }

    it('sync() awaits an in-flight removeExcludedFromMetadata() cleanup before proceeding', async () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      const deferredSave = makeDeferred<void>();
      (syncManager as any).metadataStore = {
        data: { files: { 'vendor/foo/main.js': { path: 'vendor/foo/main.js', sha: 'abc' } } },
        save: vi.fn().mockImplementation(() => deferredSave.promise),
      };
      (syncManager as any).syncImpl = vi.fn().mockResolvedValue(undefined);

      const cleanupPromise = syncManager.removeExcludedFromMetadata();
      await Promise.resolve();
      await Promise.resolve();

      const syncPromise = syncManager.sync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect((syncManager as any).syncImpl).not.toHaveBeenCalled();

      deferredSave.resolve();
      await cleanupPromise;
      await syncPromise;

      expect((syncManager as any).syncImpl).toHaveBeenCalledTimes(1);
    });

    it('firstSync() awaits an in-flight removeExcludedFromMetadata() cleanup before proceeding', async () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      const deferredSave = makeDeferred<void>();
      (syncManager as any).metadataStore = {
        data: { files: { 'vendor/foo/main.js': { path: 'vendor/foo/main.js', sha: 'abc' } } },
        save: vi.fn().mockImplementation(() => deferredSave.promise),
      };
      (syncManager as any).firstSyncImpl = vi.fn().mockResolvedValue(undefined);

      const cleanupPromise = syncManager.removeExcludedFromMetadata();
      await Promise.resolve();
      await Promise.resolve();

      const firstSyncPromise = syncManager.firstSync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect((syncManager as any).firstSyncImpl).not.toHaveBeenCalled();

      deferredSave.resolve();
      await cleanupPromise;
      await firstSyncPromise;

      expect((syncManager as any).firstSyncImpl).toHaveBeenCalledTimes(1);
    });

    it('sync() proceeds immediately when no cleanup is pending', async () => {
      (syncManager as any).syncImpl = vi.fn().mockResolvedValue(undefined);

      await syncManager.sync();

      expect((syncManager as any).syncImpl).toHaveBeenCalledTimes(1);
    });

    it('clears pendingMetadataCleanup after the cleanup resolves', async () => {
      (syncManager as any).settings = { ...mockSettings, excludePatterns: ['**/main.js'], includePatterns: [] };
      (syncManager as any).metadataStore = {
        data: { files: { 'vendor/foo/main.js': { path: 'vendor/foo/main.js', sha: 'abc' } } },
        save: vi.fn().mockResolvedValue(undefined),
      };

      await syncManager.removeExcludedFromMetadata();

      expect((syncManager as any).pendingMetadataCleanup).toBeNull();
    });
  });

  describe('sync() success Notice with remote-delete count (plan-fix-preview-accuracy-and-delete-visibility)', () => {
    it('shows the plain "Sync successful" Notice when syncImpl() reports 0 removed', async () => {
      (syncManager as any).syncImpl = vi.fn().mockResolvedValue(0);

      await syncManager.sync();

      expect(Notice).toHaveBeenCalledWith('Sync successful', 5000);
    });

    it('appends the removed-from-remote count when syncImpl() reports a positive count', async () => {
      (syncManager as any).syncImpl = vi.fn().mockResolvedValue(3);

      await syncManager.sync();

      expect(Notice).toHaveBeenCalledWith(
        'Sync successful (3 removed from remote due to exclude patterns)',
        5000,
      );
    });
  });

  describe('getRemoteFileContentWithFallback', () => {
    const filePath = 'Books/test.md';
    const metadataFile = {
      path: filePath,
      sha: 'abc123',
      dirty: false,
      justDownloaded: false,
      lastModified: 0,
    };

    it('includes file path in error when blob fetch fails with non-404 status', async () => {
      const apiError = Object.assign(new Error('Internal Server Error'), { status: 500 });
      (syncManager as any).client = {
        getBlob: vi.fn().mockRejectedValue(apiError),
      };

      await expect(
        (syncManager as any).getRemoteFileContentWithFallback(filePath, metadataFile, {}),
      ).rejects.toThrow(filePath);
    });

    it('swallows 404 blob fetch error without throwing (regression guard)', async () => {
      const notFoundError = Object.assign(new Error('Not Found'), { status: 404 });
      (syncManager as any).client = {
        getBlob: vi.fn().mockRejectedValue(notFoundError),
      };

      await expect(
        (syncManager as any).getRemoteFileContentWithFallback(filePath, metadataFile, {}),
      ).resolves.toBeNull();
    });
  });
});
