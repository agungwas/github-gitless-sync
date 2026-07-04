import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import GitHubSyncSettingsTab from "./tab";

function makePlugin() {
  return {
    saveSettings: vi.fn().mockResolvedValue(undefined),
    syncManager: {
      removeExcludedFromMetadata: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("GitHubSyncSettingsTab", () => {
  let tab: GitHubSyncSettingsTab;
  let mockPlugin: ReturnType<typeof makePlugin>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockPlugin = makePlugin();
    tab = new GitHubSyncSettingsTab({} as any, mockPlugin as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("scheduleMetadataCleanup (plan-fix-exclude-patterns-qa-findings)", () => {
    it("debounces multiple rapid calls into a single removeExcludedFromMetadata invocation", async () => {
      const scheduleMetadataCleanup = (tab as any).scheduleMetadataCleanup.bind(tab);
      scheduleMetadataCleanup();
      vi.advanceTimersByTime(100);
      scheduleMetadataCleanup();
      vi.advanceTimersByTime(100);
      scheduleMetadataCleanup();

      expect(mockPlugin.syncManager.removeExcludedFromMetadata).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(400);

      expect(mockPlugin.syncManager.removeExcludedFromMetadata).toHaveBeenCalledTimes(1);
    });

    it("fires exactly once, 400ms after the last call", async () => {
      const scheduleMetadataCleanup = (tab as any).scheduleMetadataCleanup.bind(tab);
      scheduleMetadataCleanup();

      await vi.advanceTimersByTimeAsync(399);
      expect(mockPlugin.syncManager.removeExcludedFromMetadata).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mockPlugin.syncManager.removeExcludedFromMetadata).toHaveBeenCalledTimes(1);
    });
  });
});
