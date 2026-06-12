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
