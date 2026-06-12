import { describe, it, expect, vi, beforeEach } from 'vitest';
import GitHubSyncPlugin from './main';
import { App, PluginManifest } from 'obsidian';
import { CONFLICTS_RESOLUTION_VIEW_TYPE } from './views/conflicts-resolution/view';

describe('GitHubSyncPlugin - activateView', () => {
  let plugin: GitHubSyncPlugin;
  let mockApp: any;

  beforeEach(() => {
    mockApp = {
      workspace: {
        getLeavesOfType: vi.fn().mockReturnValue([]),
        getLeaf: vi.fn(),
        revealLeaf: vi.fn(),
      },
      vault: {
        on: vi.fn(),
      }
    };

    const manifest: PluginManifest = {
      id: 'github-gitless-sync',
      name: 'GitHub Sync',
      version: '1.0.0',
      minAppVersion: '0.15.0',
      description: 'Test',
      author: 'Test',
    };

    plugin = new GitHubSyncPlugin(mockApp as any, manifest);
    plugin.app = mockApp;
  });

  it('reuses existing conflict view if open', async () => {
    const mockLeaf = { setViewState: vi.fn() };
    mockApp.workspace.getLeavesOfType.mockReturnValue([mockLeaf]);

    await plugin.activateView();

    expect(mockApp.workspace.getLeavesOfType).toHaveBeenCalledWith(CONFLICTS_RESOLUTION_VIEW_TYPE);
    expect(mockApp.workspace.getLeaf).not.toHaveBeenCalled();
    expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockLeaf);
  });

  it('replaces current tab if active tab is an empty new tab page', async () => {
    mockApp.workspace.getLeavesOfType.mockReturnValue([]);
    const mockEmptyLeaf = {
      view: { getViewType: () => 'empty' },
      setViewState: vi.fn(),
    };
    mockApp.workspace.getLeaf.mockImplementation((type: string | boolean) => {
      if (type === false) return mockEmptyLeaf;
      return mockEmptyLeaf;
    });

    await plugin.activateView();

    expect(mockApp.workspace.getLeaf).toHaveBeenCalledWith(false);
    expect(mockEmptyLeaf.setViewState).toHaveBeenCalledWith({
      type: CONFLICTS_RESOLUTION_VIEW_TYPE,
      active: true,
    });
    expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockEmptyLeaf);
  });

  it('opens in a new tab if current tab is NOT empty', async () => {
    mockApp.workspace.getLeavesOfType.mockReturnValue([]);
    const mockActiveLeaf = {
      view: { getViewType: () => 'markdown' },
      setViewState: vi.fn(),
    };
    const mockNewLeaf = {
      setViewState: vi.fn(),
    };
    mockApp.workspace.getLeaf.mockImplementation((type: string | boolean) => {
      if (type === false) return mockActiveLeaf;
      if (type === 'tab') return mockNewLeaf;
      return null;
    });

    await plugin.activateView();

    expect(mockApp.workspace.getLeaf).toHaveBeenCalledWith(false);
    expect(mockApp.workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(mockNewLeaf.setViewState).toHaveBeenCalledWith({
      type: CONFLICTS_RESOLUTION_VIEW_TYPE,
      active: true,
    });
    expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockNewLeaf);
  });
});

describe('GitHubSyncPlugin - sync', () => {
  let plugin: GitHubSyncPlugin;
  let mockApp: any;
  let mockSyncManager: any;

  beforeEach(async () => {
    mockApp = {
      workspace: {
        iterateAllLeaves: vi.fn(),
      },
      vault: {
        on: vi.fn(),
      }
    };

    const manifest = { id: 'github-gitless-sync', name: 'GitHub Sync', version: '1.0.0', minAppVersion: '0.15.0', description: 'Test', author: 'Test' };
    plugin = new GitHubSyncPlugin(mockApp as any, manifest as any);
    plugin.app = mockApp;
    
    const { DEFAULT_SETTINGS } = await import('./settings/settings');
    plugin.settings = { ...DEFAULT_SETTINGS, githubToken: 'token', githubOwner: 'owner', githubRepo: 'repo', githubBranch: 'main', firstSync: false };
    plugin.updateStatusBarItem = vi.fn();
    plugin.saveSettings = vi.fn();

    mockSyncManager = {
      firstSync: vi.fn(),
      sync: vi.fn()
    };
    plugin.syncManager = mockSyncManager as any;
  });

  it('force saves all open TextFileView instances before syncing', async () => {
    const mockSave1 = vi.fn().mockResolvedValue(undefined);
    const mockSave2 = vi.fn().mockResolvedValue(undefined);
    
    const { TextFileView } = await import('obsidian');

    const leaf1 = { view: new (TextFileView as any)() };
    (leaf1.view as any).save = mockSave1;
    
    const leaf2 = { view: {} };
    
    const leaf3 = { view: new (TextFileView as any)() };
    (leaf3.view as any).save = mockSave2;

    mockApp.workspace.iterateAllLeaves.mockImplementation((callback: Function) => {
      callback(leaf1);
      callback(leaf2);
      callback(leaf3);
    });

    // Make sure Notice is mocked appropriately
    const { Notice } = await import('obsidian');
    (Notice as any).mockImplementation(function() {
      return { hide: vi.fn() };
    });

    await plugin.sync();

    expect(mockApp.workspace.iterateAllLeaves).toHaveBeenCalled();
    expect(mockSave1).toHaveBeenCalled();
    expect(mockSave2).toHaveBeenCalled();
    expect(mockSyncManager.sync).toHaveBeenCalled();
  });
});
