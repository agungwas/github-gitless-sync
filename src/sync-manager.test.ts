import { describe, it, expect, beforeEach, vi } from 'vitest';
import SyncManager from './sync-manager';
import { Vault, Notice } from 'obsidian';
import { GitHubSyncSettings } from './settings/settings';
import Logger from './logger';
import { GetTreeResponseItem } from './github/client';

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
      (mockVault.adapter.remove as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('FILE_NOTFOUND'),
      );

      await expect(syncManager.deleteLocalFile(filePath)).rejects.toThrow(filePath);
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
        (syncManager as any).commitSync(treeFiles, 'treeSha'),
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
        (syncManager as any).commitSync(treeFiles, 'treeSha'),
      ).rejects.toThrow('Failed to upload binary blob');
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
