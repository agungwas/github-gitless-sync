import { describe, expect, it, vi } from "vitest";
import { PluginLifecycleReconciler } from "./reconciler";
import { PluginRuntimeBridge } from "./runtime-bridge";
import { FileMetadata } from "../metadata-store";

const MANIFEST_PATH = ".obsidian/plugins/quickadd/manifest.json";
const MAIN_PATH = ".obsidian/plugins/quickadd/main.js";
const STYLES_PATH = ".obsidian/plugins/quickadd/styles.css";
const MANIFEST = { id: "quickadd", name: "QuickAdd", version: "1.2.3", minAppVersion: "1.0.0", isDesktopOnly: false };
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

interface HarnessOptions {
  files?: Record<string, string>;
  enabled?: boolean;
  loaded?: boolean;
  isCustom?: boolean;
  resolve?: () => Promise<unknown>;
  metadataFiles?: Record<string, FileMetadata>;
}

function harness(options: HarnessOptions = {}) {
  const files = new Map<string, ArrayBuffer>(
    Object.entries({ [MANIFEST_PATH]: JSON.stringify(MANIFEST), ...options.files }).map(([path, text]) => [path, bytes(text)]),
  );
  const adapter = {
    list: vi.fn(async () => ({ files: [], folders: [".obsidian/plugins/quickadd"] })),
    read: vi.fn(async (path: string) => path.endsWith("community-plugins.json")
      ? (options.enabled === false ? "[]" : '["quickadd"]')
      : new TextDecoder().decode(files.get(path))),
    readBinary: vi.fn(async (path: string) => files.get(path)!),
    exists: vi.fn(async (path: string) => files.has(path) || path === ".obsidian/plugins/quickadd"),
    writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => { files.set(path, data); }),
    mkdir: vi.fn(async () => undefined),
    remove: vi.fn(async (path: string) => { files.delete(path); }),
    rmdir: vi.fn(async () => undefined),
  };
  const metadataStore = {
    data: { lastSync: 1, files: options.metadataFiles ?? {} },
    save: vi.fn(async () => undefined),
  };
  const manager = {
    plugins: options.loaded ? { quickadd: {} } : {} as Record<string, unknown>,
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
  it("hydrates a plugin whose manifest was downloaded by this sync and enables it (T4)", async () => {
    const { reconciler, source, files, manager } = harness({ files: { [MAIN_PATH]: "old main" } });

    const report = await reconciler.reconcile(true, new Set(["quickadd"]));

    expect(source.resolve).toHaveBeenCalledWith(MANIFEST);
    expect(new TextDecoder().decode(files.get(MAIN_PATH))).toBe("release main");
    expect(new TextDecoder().decode(files.get(STYLES_PATH))).toBe("release css");
    expect(manager.enablePlugin).toHaveBeenCalledWith("quickadd");
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
    const { reconciler, source, report } = await (async () => {
      const h = harness();
      return { ...h, report: await h.reconciler.reconcile(true, new Set()) };
    })();

    expect(source.resolve).toHaveBeenCalledOnce();
    expect(report.installed).toEqual(["quickadd"]);
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
    const { reconciler, source, manager, adapter } = harness({ isCustom: true, files: { [MAIN_PATH]: "custom fork" } });

    const report = await reconciler.reconcile(true, new Set(["quickadd"]));

    expect(source.resolve).not.toHaveBeenCalled();
    expect(manager.enablePlugin).toHaveBeenCalledWith("quickadd");
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
    const { reconciler, manager, adapter } = harness({
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
