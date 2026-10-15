import { describe, expect, it, vi } from "vitest";
import { PluginRuntimeBridge } from "./runtime-bridge";

describe("PluginRuntimeBridge", () => {
  it("serializes awaited disable and enable calls and protects Gitless", async () => {
    const calls: string[] = [];
    const manager = {
      plugins: { quickadd: {} },
      disablePlugin: vi.fn(async (id: string) => { calls.push(`disable:${id}`); }),
      enablePlugin: vi.fn(async (id: string) => { calls.push(`enable:${id}`); }),
    };
    const bridge = new PluginRuntimeBridge(manager, "gitless");

    await bridge.reload("quickadd");
    await expect(bridge.unload("gitless")).rejects.toThrow("Protected plugin");

    expect(calls).toEqual(["disable:quickadd", "enable:quickadd"]);
    expect(bridge.isLoaded("quickadd")).toBe(true);
  });

  it("does not enable a plugin unless caller requests it", async () => {
    const manager = { plugins: {}, disablePlugin: vi.fn(), enablePlugin: vi.fn() };
    const bridge = new PluginRuntimeBridge(manager, "gitless");
    expect(bridge.isLoaded("quickadd")).toBe(false);
    expect(manager.enablePlugin).not.toHaveBeenCalled();
  });

  it("observes completed native install and uninstall while preserving results", async () => {
    const events: string[] = [];
    const manager = {
      plugins: {},
      enablePlugin: vi.fn(),
      disablePlugin: vi.fn(),
      installPlugin: vi.fn(async (id: string) => `installed:${id}`),
      uninstallPlugin: vi.fn(async (id: string) => `removed:${id}`),
    };
    const originalInstall = manager.installPlugin;
    const bridge = new PluginRuntimeBridge(manager, "gitless");
    const dispose = bridge.observeNativeMutations((event) => events.push(`${event.kind}:${event.id}`));

    await expect(manager.installPlugin("quickadd")).resolves.toBe("installed:quickadd");
    await expect(manager.uninstallPlugin("quickadd")).resolves.toBe("removed:quickadd");
    dispose();

    expect(events).toEqual(["install:quickadd", "uninstall:quickadd"]);
    expect(manager.installPlugin).toBe(originalInstall);
  });

  it("allows native install to call wrapped lifecycle methods without deadlocking", async () => {
    const enablePlugin = vi.fn(async (_id: string) => undefined);
    const manager = {
      plugins: {},
      enablePlugin,
      disablePlugin: vi.fn(async () => undefined),
      installPlugin: vi.fn(async (id: string) => {
        await manager.enablePlugin(id);
        return `installed:${id}`;
      }),
    };
    const bridge = new PluginRuntimeBridge(manager, "gitless");
    bridge.observeNativeMutations(() => undefined);

    await expect(manager.installPlugin("quickadd")).resolves.toBe("installed:quickadd");

    expect(enablePlugin).toHaveBeenCalledWith("quickadd");
    expect(bridge.isMutating("quickadd")).toBe(false);
  });

  it("observes native enable and disable, but ignores lifecycle calls it initiates", async () => {
    const events: string[] = [];
    const manager = {
      plugins: { quickadd: {} },
      enablePlugin: vi.fn(async (_id: string) => undefined),
      disablePlugin: vi.fn(async (_id: string) => undefined),
    };
    const bridge = new PluginRuntimeBridge(manager, "gitless");
    const dispose = bridge.observeNativeMutations((event) => events.push(`${event.kind}:${event.id}`));

    await manager.disablePlugin("quickadd");
    await bridge.enable("quickadd");
    await bridge.reload("quickadd");
    dispose();

    expect(events).toEqual(["disable:quickadd"]);
  });
});
