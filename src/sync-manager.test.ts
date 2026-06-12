import { describe, it, expect, beforeEach, vi } from 'vitest';
import SyncManager from './sync-manager';
import { Vault, Notice } from 'obsidian';
import { GitHubSyncSettings } from './settings/settings';
import Logger from './logger';

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
