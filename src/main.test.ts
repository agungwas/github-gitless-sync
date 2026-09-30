import { describe, it, expect, vi, beforeEach } from 'vitest';
import GitHubSyncPlugin from './main';
import { App, PluginManifest } from 'obsidian';
import { CONFLICTS_RESOLUTION_VIEW_TYPE } from './views/conflicts-resolution/view';
import { ConflictFile, ConflictResolution } from './sync-manager';

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

  it('opens in a new tab even if the current tab is an empty new tab page', async () => {
    const mockNewLeaf = { setViewState: vi.fn() };
    mockApp.workspace.getLeaf.mockReturnValue(mockNewLeaf);

    await plugin.activateView();

    expect(mockApp.workspace.getLeaf).toHaveBeenCalledTimes(1);
    expect(mockApp.workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(mockNewLeaf.setViewState).toHaveBeenCalledWith({
      type: CONFLICTS_RESOLUTION_VIEW_TYPE,
      active: true,
    });
    expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockNewLeaf);
  });

  it('opens in a new tab if current tab is NOT empty', async () => {
    const mockNewLeaf = { setViewState: vi.fn() };
    mockApp.workspace.getLeaf.mockImplementation((type: string | boolean) =>
      type === 'tab' ? mockNewLeaf : null,
    );

    await plugin.activateView();

    expect(mockApp.workspace.getLeaf).not.toHaveBeenCalledWith(false);
    expect(mockApp.workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(mockNewLeaf.setViewState).toHaveBeenCalledWith({
      type: CONFLICTS_RESOLUTION_VIEW_TYPE,
      active: true,
    });
    expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(mockNewLeaf);
  });
});

describe('GitHubSyncPlugin - conflicts state', () => {
  let plugin: GitHubSyncPlugin;
  let conflicts: ConflictFile[];
  let resolved: Promise<ConflictResolution[]>;

  beforeEach(async () => {
    const mockApp: any = {
      workspace: {
        getLeavesOfType: vi.fn().mockReturnValue([]),
        getLeaf: vi.fn().mockReturnValue({ setViewState: vi.fn() }),
        revealLeaf: vi.fn(),
      },
    };
    const manifest = { id: 'github-gitless-sync', name: 'GitHub Sync', version: '1.0.0', minAppVersion: '0.15.0', description: 'Test', author: 'Test' };
    plugin = new GitHubSyncPlugin(mockApp, manifest as any);
    plugin.app = mockApp;
    conflicts = [
      { filePath: 'a.md', remoteContent: 'remote a', localContent: 'local a' },
      { filePath: 'b.md', remoteContent: 'remote b', localContent: 'local b' },
    ];
    resolved = plugin.onConflicts(conflicts);
    // onConflicts opens the view asynchronously before returning
    await Promise.resolve();
  });

  it('is pending until finalized, then hands over every resolution once', async () => {
    expect(plugin.hasPendingConflicts()).toBe(true);
    plugin.recordResolvedConflict({ filePath: 'a.md', content: 'A' });
    expect(plugin.allConflictsResolved()).toBe(false);
    plugin.recordResolvedConflict({ filePath: 'b.md', content: 'B' });
    expect(plugin.allConflictsResolved()).toBe(true);

    expect(plugin.finalizeConflicts()).toBe(true);
    await expect(resolved).resolves.toEqual([
      { filePath: 'a.md', content: 'A' },
      { filePath: 'b.md', content: 'B' },
    ]);
    expect(plugin.hasPendingConflicts()).toBe(false);
    expect(plugin.getConflicts()).toEqual([]);
    expect(plugin.resolvedConflicts.size).toBe(0);
    // Nothing is waiting anymore
    expect(plugin.finalizeConflicts()).toBe(false);
  });

  it('reset restores the original conflicts and keeps the sync waiting', () => {
    plugin.recordResolvedConflict({ filePath: 'a.md', content: 'A' });
    // Views edit the conflict files in place
    plugin.getConflicts()[0].localContent = 'edited';

    plugin.resetConflicts();

    expect(plugin.resolvedConflicts.size).toBe(0);
    expect(plugin.getConflicts()).toEqual([
      { filePath: 'a.md', remoteContent: 'remote a', localContent: 'local a' },
      { filePath: 'b.md', remoteContent: 'remote b', localContent: 'local b' },
    ]);
    expect(plugin.hasPendingConflicts()).toBe(true);
    // Resetting twice still restores pristine content
    plugin.getConflicts()[1].localContent = 'edited again';
    plugin.resetConflicts();
    expect(plugin.getConflicts()[1].localContent).toBe('local b');
  });

  it('shows a notice with Resume and Reset actions', async () => {
    const hide = vi.fn();
    const { Notice } = await import('obsidian');
    (Notice as any).mockClear();
    (Notice as any).mockImplementation(function () {
      return { hide };
    });
    plugin.openConflictsView = vi.fn().mockResolvedValue(undefined);

    plugin.showPendingConflictsNotice();

    expect(Notice).toHaveBeenCalledTimes(1);
    const [fragment, duration] = (Notice as any).mock.calls[0];
    expect(duration).toBe(0);
    const buttons = Array.from(
      (fragment as DocumentFragment).querySelectorAll('button'),
    );
    expect(buttons.map((b) => b.textContent)).toEqual(['Resume', 'Reset']);

    plugin.recordResolvedConflict({ filePath: 'a.md', content: 'A' });
    buttons[1].click();
    expect(plugin.resolvedConflicts.size).toBe(0);
    expect(plugin.hasPendingConflicts()).toBe(true);
    expect(hide).toHaveBeenCalled();

    plugin.showPendingConflictsNotice();
    const [fragment2] = (Notice as any).mock.calls[1];
    (fragment2 as DocumentFragment).querySelectorAll('button')[0].click();
    expect(plugin.openConflictsView).toHaveBeenCalled();
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
