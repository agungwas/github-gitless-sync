import { describe, it, expect, beforeEach, vi } from 'vitest';
import SyncManager from './sync-manager';
import { Vault, Notice } from 'obsidian';
import { GitHubSyncSettings } from './settings/settings';
import Logger from './logger';
import { GetTreeResponseItem } from './github/client';

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
