import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginSyncCoordinator } from "./coordinator";

describe("PluginSyncCoordinator", () => {
  afterEach(() => vi.useRealTimers());

  it("does not start a sync when a native plugin change is observed", async () => {
    vi.useFakeTimers();
    const pluginManager = {
      plugins: {},
      uninstallPlugin: vi.fn(async (_id: string) => undefined),
    };
    const coordinator = new PluginSyncCoordinator({
      vault: { configDir: ".obsidian", adapter: { exists: vi.fn(async () => false), list: vi.fn(async () => null) } } as never,
      metadataStore: { data: { files: {} }, save: vi.fn() } as never,
      settings: { syncCommunityPlugins: true, syncStrategy: "interval" } as never,
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
      selfPluginId: "gitless",
      pluginManager: pluginManager as never,
      isCustomPlugin: () => false,
    });
    coordinator.configure();
    await pluginManager.uninstallPlugin("x");
    await vi.advanceTimersByTimeAsync(2000);
    // Only the removal-scan interval may be pending; no debounce timer for a sync.
    expect(vi.getTimerCount()).toBe(1);
    expect("requestAutomaticSync" in coordinator).toBe(false);
    expect("onSyncFinished" in coordinator).toBe(false);
    coordinator.stop();
  });
});
