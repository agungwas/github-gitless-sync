import { describe, expect, it, vi } from "vitest";
import GitHubSyncPlugin from "./main";
import SyncManager from "./sync-manager";
import { DEFAULT_SETTINGS } from "./settings/settings";

const modal = vi.hoisted(() => ({
  open: vi.fn(),
  read: null as null | (() => Promise<string>),
  clean: null as null | (() => Promise<void>),
}));
vi.mock("./settings/logs-modal", () => ({
  default: class {
    constructor(_app: unknown, read: () => Promise<string>, clean: () => Promise<void>) {
      modal.read = read;
      modal.clean = clean;
    }
    open() { modal.open(); }
  },
}));

describe("Gitless commands", () => {
  it("opens the existing logs modal from the command palette", async () => {
    const app = {
      vault: { configDir: ".obsidian" },
      workspace: { onLayoutReady: vi.fn() },
      plugins: { plugins: {} },
    };
    const plugin = new GitHubSyncPlugin(app as never, { id: "gitless" } as never);
    plugin.app = app as never;
    plugin.manifest = { id: "gitless" } as never;
    plugin.loadSettings = vi.fn(async () => { plugin.settings = { ...DEFAULT_SETTINGS }; });
    plugin.registerView = vi.fn();
    plugin.addSettingTab = vi.fn();
    plugin.addCommand = vi.fn();
    plugin.registerDomEvent = vi.fn();
    const loadMetadata = vi.spyOn(SyncManager.prototype, "loadMetadata").mockResolvedValue(undefined);
    try {
      await plugin.onload();
      const read = vi.spyOn(plugin.logger, "read").mockResolvedValue("log entry");
      const clean = vi.spyOn(plugin.logger, "clean").mockResolvedValue(undefined);
      const command = vi.mocked(plugin.addCommand).mock.calls
        .map(([entry]) => entry)
        .find((entry) => entry.id === "view-logs");
      expect(command).toMatchObject({ name: "View logs" });
      command!.callback!();
      expect(modal.open).toHaveBeenCalledOnce();
      await expect(modal.read!()).resolves.toBe("log entry");
      await modal.clean!();
      expect(read).toHaveBeenCalledOnce();
      expect(clean).toHaveBeenCalledOnce();
    } finally {
      loadMetadata.mockRestore();
    }
  });
});
