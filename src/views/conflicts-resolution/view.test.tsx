import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictsResolutionView } from "./view";

const makePlugin = () => ({
  isUnloading: false,
  settings: { conflictsAutoCloseDelay: 3, conflictViewMode: "unified" },
  resolvedConflicts: new Map(),
  recordResolvedConflict: vi.fn(),
  finalizeConflicts: vi.fn().mockReturnValue(true),
  resetConflicts: vi.fn(),
  getConflicts: vi.fn().mockReturnValue([]),
  allConflictsResolved: vi.fn().mockReturnValue(false),
  hasPendingConflicts: vi.fn().mockReturnValue(false),
  showPendingConflictsNotice: vi.fn(),
});

describe("ConflictsResolutionView", () => {
  let plugin: ReturnType<typeof makePlugin>;
  let view: any;
  let leaf: { detach: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    plugin = makePlugin();
    leaf = { detach: vi.fn() };
    view = new ConflictsResolutionView({} as any, plugin as any, []);
    view.leaf = leaf;
  });

  describe("onConfirm", () => {
    it("hands over the resolutions and closes the tab", () => {
      view.onConfirm();
      expect(plugin.finalizeConflicts).toHaveBeenCalledTimes(1);
      // Closing is deferred out of the React event handler
      expect(leaf.detach).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(leaf.detach).toHaveBeenCalledTimes(1);
    });

    it("keeps the tab open if nothing was waiting for the resolutions", () => {
      plugin.finalizeConflicts.mockReturnValue(false);
      view.onConfirm();
      vi.runAllTimers();
      expect(leaf.detach).not.toHaveBeenCalled();
    });
  });

  describe("onClose", () => {
    it("confirms if everything was resolved but not yet confirmed", async () => {
      plugin.allConflictsResolved.mockReturnValue(true);
      plugin.hasPendingConflicts.mockReturnValue(true);
      await view.onClose();
      expect(plugin.finalizeConflicts).toHaveBeenCalledTimes(1);
      expect(plugin.showPendingConflictsNotice).not.toHaveBeenCalled();
    });

    it("shows the notice if conflicts are still pending", async () => {
      plugin.hasPendingConflicts.mockReturnValue(true);
      await view.onClose();
      expect(plugin.showPendingConflictsNotice).toHaveBeenCalledTimes(1);
      expect(plugin.finalizeConflicts).not.toHaveBeenCalled();
    });

    it("does nothing if there are no pending conflicts", async () => {
      await view.onClose();
      expect(plugin.showPendingConflictsNotice).not.toHaveBeenCalled();
      expect(plugin.finalizeConflicts).not.toHaveBeenCalled();
    });

    it("does nothing while the plugin is unloading", async () => {
      plugin.isUnloading = true;
      plugin.allConflictsResolved.mockReturnValue(true);
      plugin.hasPendingConflicts.mockReturnValue(true);
      await view.onClose();
      expect(plugin.showPendingConflictsNotice).not.toHaveBeenCalled();
      expect(plugin.finalizeConflicts).not.toHaveBeenCalled();
    });
  });

  it("onReset restores the conflicts and rebuilds the view", () => {
    const setConflictFiles = vi.spyOn(view, "setConflictFiles").mockImplementation(() => {});
    const restored = [{ filePath: "a.md", remoteContent: "r", localContent: "l" }];
    plugin.getConflicts.mockReturnValue(restored);
    view.onReset();
    expect(plugin.resetConflicts).toHaveBeenCalledTimes(1);
    expect(setConflictFiles).toHaveBeenCalledWith(restored);
  });
});
