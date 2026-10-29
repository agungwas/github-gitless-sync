import { describe, expect, it, vi } from "vitest";
import { PluginLifecycleReconciler } from "./reconciler";
import { PluginRuntimeBridge } from "./runtime-bridge";
import { FileMetadata } from "../metadata-store";
import { Notice } from "obsidian";

const MANIFEST_PATH = ".obsidian/plugins/quickadd/manifest.json";
const PLUGIN_FOLDER = ".obsidian/plugins/quickadd";
const MAIN_PATH = ".obsidian/plugins/quickadd/main.js";
const STYLES_PATH = ".obsidian/plugins/quickadd/styles.css";
const MANIFEST = { id: "quickadd", name: "QuickAdd", version: "1.2.3", minAppVersion: "1.0.0", isDesktopOnly: false };
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

interface HarnessOptions {
  files?: Record<string, string>;
  enabled?: boolean;
  loaded?: boolean;
  savedEnabled?: boolean;
  isCustom?: boolean;
  resolve?: () => Promise<unknown>;
  metadataFiles?: Record<string, FileMetadata>;
}

function harness(options: HarnessOptions = {}) {
  const files = new Map<string, ArrayBuffer>(
    Object.entries({ [MANIFEST_PATH]: JSON.stringify(MANIFEST), ...options.files }).map(([path, text]) => [path, bytes(text)]),
  );
  const folders = new Set([PLUGIN_FOLDER]);
  const adapter = {
    list: vi.fn(async () => ({ files: [], folders: [...folders] })),
    read: vi.fn(async (path: string) => path.endsWith("community-plugins.json")
      ? (options.enabled === false ? "[]" : '["quickadd"]')
      : new TextDecoder().decode(files.get(path))),
    readBinary: vi.fn(async (path: string) => files.get(path)!),
    exists: vi.fn(async (path: string) => files.has(path) || folders.has(path)),
    writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => { files.set(path, data); }),
    mkdir: vi.fn(async (path: string) => { folders.add(path); }),
    remove: vi.fn(async (path: string) => { files.delete(path); }),
    rmdir: vi.fn(async (path: string, recursive?: boolean) => {
      folders.delete(path);
      if (recursive) {
        for (const filePath of files.keys()) if (filePath.startsWith(`${path}/`)) files.delete(filePath);
        for (const folderPath of folders) if (folderPath.startsWith(`${path}/`)) folders.delete(folderPath);
      }
    }),
  };
  const metadataStore = {
    data: { lastSync: 1, files: options.metadataFiles ?? {} },
    save: vi.fn(async () => undefined),
  };
  const manager = {
    plugins: options.loaded ? { quickadd: {} } : {} as Record<string, unknown>,
    enabledPlugins: new Set((options.savedEnabled ?? (options.enabled !== false)) ? ["quickadd"] : []),
    enablePlugin: vi.fn(async (id: string) => { manager.plugins[id] = {}; }),
    disablePlugin: vi.fn(async (id: string) => { delete manager.plugins[id]; }),
    installPlugin: vi.fn(async (_id: string) => undefined),
  };
  const source = {
    resolve: vi.fn(options.resolve ?? (async () => ({
      manifest: MANIFEST, assets: { mainJs: bytes("release main"), stylesCss: bytes("release css") },
    }))),
  };
  const runtime = new PluginRuntimeBridge(manager, "gitless");
  const reconciler = new PluginLifecycleReconciler(
    { configDir: ".obsidian", adapter } as never,
    metadataStore as never,
    runtime,
    "gitless",
    { error: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
    source as never,
    () => options.isCustom ?? false,
  );
  return { reconciler, adapter, files, manager, source, metadataStore, runtime };
}

describe("PluginLifecycleReconciler", () => {
  it("leaves a running delayed plugin alone when its saved state is unchanged", async () => {
    const { reconciler, manager } = harness({ enabled: false, loaded: true, files: { [MAIN_PATH]: "local main" } });
    const report = await reconciler.reconcile(true, new Set());
    expect(manager.disablePlugin).not.toHaveBeenCalled();
    expect(report.disabled).toEqual([]);
  });

  it("defers a remote disable until restart while updating saved state", async () => {
    const { reconciler, manager } = harness({ enabled: false, savedEnabled: true, loaded: true, files: { [MAIN_PATH]: "local main" } });
    const report = await reconciler.reconcile(true, new Set());
    expect(manager.disablePlugin).not.toHaveBeenCalled();
    expect(manager.enabledPlugins.has("quickadd")).toBe(false);
    expect(report.disabled).toEqual([]);
  });

  it("defers a remote enable until restart while updating saved state", async () => {
    const { reconciler, manager } = harness({ enabled: true, savedEnabled: false, files: { [MAIN_PATH]: "local main" } });
    const report = await reconciler.reconcile(true, new Set());
    expect(manager.enablePlugin).not.toHaveBeenCalled();
    expect(manager.enabledPlugins.has("quickadd")).toBe(true);
    expect(report.enabled).toEqual([]);
  });

  it("notifies once when synced state changes and does not notify again when unchanged", async () => {
    vi.mocked(Notice).mockClear();
    const { reconciler } = harness({ enabled: true, savedEnabled: false, files: { [MAIN_PATH]: "local main" } });
    await reconciler.reconcile(true, new Set());
    await reconciler.reconcile(true, new Set());
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenCalledWith("Restart Obsidian to apply synced community plugin state.");
  });

  it("preserves a newer file change while reconciling saved state", async () => {
    const { reconciler, adapter, manager } = harness({ enabled: true, savedEnabled: false, files: { [MAIN_PATH]: "local main" } });
    let reads = 0;
    adapter.read.mockImplementation(async (path: string) => {
      if (!path.endsWith("community-plugins.json")) return JSON.stringify(MANIFEST);
      return ++reads === 1 ? '["quickadd"]' : "[]";
    });
    await reconciler.reconcile(true, new Set());
    expect(manager.enabledPlugins.has("quickadd")).toBe(false);
    expect(manager.enablePlugin).not.toHaveBeenCalled();
  });

  it("reports the path and underlying error when the state recheck fails", async () => {
    const { reconciler, adapter, manager } = harness({ enabled: true, savedEnabled: false, files: { [MAIN_PATH]: "local main" } });
    let reads = 0;
    adapter.read.mockImplementation(async (path: string) => {
      if (!path.endsWith("community-plugins.json")) return JSON.stringify(MANIFEST);
      if (++reads === 1) return '["quickadd"]';
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    const report = await reconciler.reconcile(true, new Set());
    expect(report.failed.join(" ")).toContain(".obsidian/community-plugins.json");
    expect(report.failed.join(" ")).toContain("EACCES");
    expect(manager.enabledPlugins.has("quickadd")).toBe(false);
  });

  it("restores a running delayed plugin after its package is updated", async () => {
    const { reconciler, manager } = harness({ enabled: false, loaded: true, files: { [MAIN_PATH]: "old main" } });
    const report = await reconciler.reconcile(true, new Set(["quickadd"]));
    expect(manager.disablePlugin).toHaveBeenCalledWith("quickadd");
    expect(manager.enablePlugin).toHaveBeenCalledWith("quickadd");
    expect(manager.enabledPlugins.has("quickadd")).toBe(false);
    expect(report.failed).toEqual([]);
  });

  it("keeps a running plugin active after an update even if disable is pending", async () => {
    const { reconciler, manager } = harness({ enabled: false, savedEnabled: true, loaded: true, files: { [MAIN_PATH]: "old main" } });
    const report = await reconciler.reconcile(true, new Set(["quickadd"]));
    expect(manager.disablePlugin).toHaveBeenCalledTimes(1);
    expect(manager.enablePlugin).toHaveBeenCalledTimes(1);
    expect(manager.enabledPlugins.has("quickadd")).toBe(false);
    expect(report.updated).toEqual(["quickadd"]);
  });

  it("hydrates an inactive plugin without enabling it until restart (T4)", async () => {
    const { reconciler, source, files, manager } = harness({ files: { [MAIN_PATH]: "old main" } });

    const report = await reconciler.reconcile(true, new Set(["quickadd"]));

    expect(source.resolve).toHaveBeenCalledWith(MANIFEST);
    expect(new TextDecoder().decode(files.get(MAIN_PATH))).toBe("release main");
    expect(new TextDecoder().decode(files.get(STYLES_PATH))).toBe("release css");
    expect(manager.enablePlugin).not.toHaveBeenCalled();
    expect(report.updated).toEqual(["quickadd"]);
    expect(report.failed).toEqual([]);
  });

  it("does not download or hash anything when the manifest did not change and main.js exists", async () => {
    const { reconciler, source, adapter, manager } = harness({ files: { [MAIN_PATH]: "local main" }, loaded: true });

    const report = await reconciler.reconcile(true, new Set());

    expect(source.resolve).not.toHaveBeenCalled();
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    expect(adapter.readBinary).not.toHaveBeenCalled();
    expect(manager.enablePlugin).not.toHaveBeenCalled();
    expect(report.installed).toEqual([]);
    expect(report.updated).toEqual([]);
  });

  it("hydrates when main.js is missing although the manifest is unchanged (T6)", async () => {
    const { reconciler, source, manager } = harness();
    const report = await reconciler.reconcile(true, new Set());

    expect(source.resolve).toHaveBeenCalledOnce();
    expect(report.installed).toEqual(["quickadd"]);
    expect(manager.enablePlugin).not.toHaveBeenCalled();
  });

  it("keeps the old binary on a failed hydrate and retries it in the same session (T5)", async () => {
    let online = false;
    const { reconciler, source, files } = harness({
      files: { [MAIN_PATH]: "old main" },
      resolve: async () => {
        if (!online) throw new Error("offline");
        return { manifest: MANIFEST, assets: { mainJs: bytes("release main"), stylesCss: null } };
      },
    });

    const first = await reconciler.reconcile(true, new Set(["quickadd"]));
    expect(first.failed).toEqual(["quickadd: Error: offline"]);
    expect(new TextDecoder().decode(files.get(MAIN_PATH))).toBe("old main");

    online = true;
    const second = await reconciler.reconcile(true, new Set());
    expect(source.resolve).toHaveBeenCalledTimes(2);
    expect(new TextDecoder().decode(files.get(MAIN_PATH))).toBe("release main");
    expect(second.updated).toEqual(["quickadd"]);

    await reconciler.reconcile(true, new Set());
    expect(source.resolve).toHaveBeenCalledTimes(2);
  });

  it("reports an id missing from the official registry as skipped, not failed (T17)", async () => {
    const { reconciler } = harness({
      resolve: async () => { throw new Error("Plugin source is not in the official registry"); },
    });

    const report = await reconciler.reconcile(true, new Set(["quickadd"]));

    expect(report.skipped).toEqual(["quickadd: Error: Plugin source is not in the official registry"]);
    expect(report.failed).toEqual([]);
  });

  it("never resolves a custom directory plugin through the registry (T14)", async () => {
    const { reconciler, source, manager, adapter } = harness({ isCustom: true, savedEnabled: false, files: { [MAIN_PATH]: "custom fork" } });

    const report = await reconciler.reconcile(true, new Set(["quickadd"]));

    expect(source.resolve).not.toHaveBeenCalled();
    expect(manager.enablePlugin).not.toHaveBeenCalled();
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    expect(report.failed).toEqual([]);
  });

  it("defers hydration while Obsidian is mutating the same plugin", async () => {
    const { reconciler, source, manager, runtime, adapter } = harness();
    let finishNativeInstall!: () => void;
    const gate = new Promise<void>((resolve) => { finishNativeInstall = resolve; });
    manager.installPlugin.mockImplementation(async () => { await gate; });
    runtime.observeNativeMutations(() => undefined);

    const nativeInstall = manager.installPlugin("quickadd");
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.isMutating("quickadd")).toBe(true);

    const report = await reconciler.reconcile(true, new Set(["quickadd"]));

    expect(report.skipped).toContain("quickadd: native package mutation in progress");
    expect(source.resolve).not.toHaveBeenCalled();
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    finishNativeInstall();
    await nativeInstall;
  });

  it("rechecks mutation generation before promoting a package resolved during a native install", async () => {
    let finishSource!: () => void;
    let sourceStarted!: () => void;
    const started = new Promise<void>((resolve) => { sourceStarted = resolve; });
    const sourceGate = new Promise<void>((resolve) => { finishSource = resolve; });
    const { reconciler, manager, runtime, adapter, files } = harness({
      files: { [MAIN_PATH]: "old main" },
      resolve: async () => {
        sourceStarted();
        await sourceGate;
        return { manifest: MANIFEST, assets: { mainJs: bytes("release main"), stylesCss: null } };
      },
    });
    runtime.observeNativeMutations(() => undefined);

    const reconciliation = reconciler.reconcile(true, new Set(["quickadd"]));
    await started;
    const nativeInstall = manager.installPlugin("quickadd");
    await nativeInstall;
    finishSource();

    const report = await reconciliation;
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(files.get(MAIN_PATH))).toBe("old main");
    expect(report.skipped).toContain("quickadd: native package changed during reconciliation");
    expect(report.failed).toEqual([]);
  });

  it("unloads and removes the folder of a plugin the remote tombstoned (T8)", async () => {
    const { reconciler, manager, adapter, files } = harness({
      loaded: true,
      files: { [MAIN_PATH]: "main" },
      metadataFiles: {
        [MANIFEST_PATH]: {
          path: MANIFEST_PATH, sha: null, dirty: false, justDownloaded: false, lastModified: 1, deleted: true, deletedAt: 2,
        },
      },
    });

    const report = await reconciler.reconcile(true, new Set());

    expect(manager.disablePlugin).toHaveBeenCalledWith("quickadd");
    expect(adapter.rmdir).toHaveBeenCalledWith(".obsidian/plugins/quickadd", true);
    await expect(adapter.exists(".obsidian/plugins/quickadd")).resolves.toBe(false);
    expect(files.has(MAIN_PATH)).toBe(false);
    expect(report.uninstalled).toEqual(["quickadd"]);
  });

  it("publishes eventless uninstall only after two complete absent scans", async () => {
    const adapter = {
      list: vi.fn(async () => ({ files: [], folders: [] })),
      read: vi.fn(async () => "[]"),
      exists: vi.fn(async () => false),
    };
    const metadataStore = {
      data: {
        lastSync: 1,
        files: { [MANIFEST_PATH]: { path: MANIFEST_PATH, sha: "manifest-blob", dirty: false, justDownloaded: false, lastModified: 1 } },
      },
      save: vi.fn(async () => undefined),
    };
    const manager = { plugins: {}, enablePlugin: vi.fn(), disablePlugin: vi.fn() };
    const reconciler = new PluginLifecycleReconciler(
      { configDir: ".obsidian", adapter } as never,
      metadataStore as never,
      new PluginRuntimeBridge(manager, "gitless"),
      "gitless",
      { error: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
      { resolve: vi.fn() } as never,
    );
    (reconciler as unknown as { knownLocalIds: Set<string> }).knownLocalIds.add("quickadd");

    await reconciler.observeLocalRemovals();
    expect(metadataStore.data.files[MANIFEST_PATH]).not.toHaveProperty("deleted");

    await reconciler.observeLocalRemovals();
    const tombstone = metadataStore.data.files[MANIFEST_PATH] as FileMetadata & Record<string, unknown>;
    expect(tombstone.deleted).toBe(true);
    expect(Object.keys(tombstone).sort()).toEqual(["deleted", "deletedAt", "dirty", "justDownloaded", "lastModified", "path", "sha"]);
  });
});
