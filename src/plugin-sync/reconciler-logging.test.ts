import { describe, expect, it, vi } from "vitest";
import Logger from "../logger";
import MetadataStore from "../metadata-store";
import { OfficialPackageSource } from "./package-source";
import { PluginLifecycleReconciler } from "./reconciler";
import { PluginRuntimeBridge } from "./runtime-bridge";

function setup(enabled = true) {
  const manifest = {
    id: "quickadd", name: "QuickAdd", version: "2.32.1", author: "Author",
    description: "test", minAppVersion: "1.0.0", isDesktopOnly: false,
  };
  let contents = "";
  const adapter = {
    list: vi.fn(async () => ({ files: [], folders: [".obsidian/plugins/quickadd"] })),
    read: vi.fn(async (path: string) => path.endsWith("community-plugins.json") ? '["quickadd"]' : JSON.stringify(manifest)),
    exists: vi.fn(async (path: string) => !path.endsWith("styles.css")),
    readBinary: vi.fn(async () => new TextEncoder().encode("official code").buffer),
    append: vi.fn(async (_path: string, text: string) => { contents += text; }),
  };
  const vault = { configDir: ".obsidian", adapter } as never;
  const metadata = new MetadataStore(vault);
  metadata.data = { lastSync: 1, files: {} };
  vi.spyOn(metadata, "save").mockResolvedValue(undefined);
  const logger = new Logger(vault, enabled);
  const manager = { plugins: { quickadd: {} }, enablePlugin: vi.fn(), disablePlugin: vi.fn() };
  const source = new OfficialPackageSource();
  const resolve = vi.spyOn(source, "resolve").mockRejectedValue(new Error("Exact plugin release unavailable (HTTP 403)"));
  const reconciler = new PluginLifecycleReconciler(
    vault, metadata, new PluginRuntimeBridge(manager, "gitless"), "gitless", logger, source,
  );
  const entries = (): unknown[] => contents.split("\n").filter(Boolean).map((line) => {
    const entry: unknown = JSON.parse(line);
    return entry;
  });
  return { reconciler, adapter, manifest, manager, resolve, entries };
}

describe("Community plugin file logging", () => {
  it("records a failed hydrate with the plugin id and underlying reason", async () => {
    const { reconciler, adapter, entries } = setup();

    await reconciler.reconcile(true, new Set(["quickadd"]));

    expect(adapter.append).toHaveBeenCalledWith(".obsidian/github-sync.log", expect.any(String));
    expect(entries()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: "INFO", message: "Resolving community plugin package",
        additional_data: { id: "quickadd", version: "2.32.1" },
      }),
      expect.objectContaining({
        level: "ERROR", message: "Community plugin operation failed",
        additional_data: { phase: "reconciliation", id: "quickadd", reason: "Error: Exact plugin release unavailable (HTTP 403)" },
      }),
    ]));
  });

  it("writes separate entries for each failed plugin instead of combining plugin reasons", async () => {
    const { reconciler, adapter, manifest, entries } = setup();
    adapter.list.mockResolvedValue({ files: [], folders: [".obsidian/plugins/quickadd", ".obsidian/plugins/dataview"] });
    adapter.read.mockImplementation(async (path: string) => path.endsWith("community-plugins.json")
      ? '["quickadd"]'
      : JSON.stringify({ ...manifest, id: path.includes("/dataview/") ? "dataview" : "quickadd" }));

    await reconciler.reconcile(true, new Set(["quickadd", "dataview"]));

    const failures = entries().filter((entry) => typeof entry === "object" && entry !== null &&
      "message" in entry && entry.message === "Community plugin operation failed");
    expect(failures).toEqual([
      expect.objectContaining({ additional_data: expect.objectContaining({ phase: "reconciliation", id: "quickadd" }) }),
      expect.objectContaining({ additional_data: expect.objectContaining({ phase: "reconciliation", id: "dataview" }) }),
    ]);
    expect(entries()).toEqual(expect.arrayContaining([expect.objectContaining({
      message: "Community plugin processing completed",
      additional_data: { phase: "reconciliation", counts: {
        installed: 0, updated: 0, uninstalled: 0, enabled: 0, disabled: 0,
        runtimeFailures: 0, skipped: 0, failed: 2,
      } },
    })]));
  });

  it("records successful activation with the plugin ID in its own entry", async () => {
    const { reconciler, manager, entries } = setup();
    Reflect.deleteProperty(manager.plugins, "quickadd");

    await reconciler.reconcile(true, new Set());

    expect(entries()).toEqual(expect.arrayContaining([expect.objectContaining({
      level: "INFO", message: "Community plugin enabled",
      additional_data: { phase: "reconciliation", id: "quickadd" },
    })]));
  });

  it("records skipped incomplete snapshots before returning", async () => {
    const { reconciler, entries } = setup();

    await reconciler.reconcile(false, new Set());

    expect(entries()).toEqual(expect.arrayContaining([expect.objectContaining({
      level: "WARN", message: "Community plugin skipped",
      additional_data: { phase: "reconciliation", reason: "incomplete remote snapshot" },
    })]));
  });

  it("records lifecycle failure and restart recommendation", async () => {
    const { reconciler, manager, entries } = setup();
    Reflect.deleteProperty(manager.plugins, "quickadd");
    manager.enablePlugin.mockRejectedValue(new Error("Plugin onload failed"));

    await reconciler.reconcile(true, new Set());

    expect(entries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "ERROR", message: "Community plugin operation failed",
        additional_data: { phase: "reconciliation", id: "quickadd", reason: "Error: Plugin onload failed" },
      }),
      expect.objectContaining({
        level: "ERROR", message: "Community plugin reload failed; restart recommended",
        additional_data: { phase: "reconciliation", id: "quickadd", reason: "enable failed" },
      }),
    ]));
  });

  it("does not write plugin diagnostics when logging is disabled", async () => {
    const { reconciler, adapter, entries } = setup(false);

    await reconciler.reconcile(true, new Set());

    expect(adapter.append).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
  });
});
