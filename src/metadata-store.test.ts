import { describe, expect, it, vi } from "vitest";
import MetadataStore, { normalizeMetadata } from "./metadata-store";

const FILE = {
  path: ".obsidian/plugins/quickadd/manifest.json", sha: "blob", dirty: false, justDownloaded: false, lastModified: 1,
};

function storeWith(content: string | null) {
  const adapter = {
    exists: vi.fn(async () => content !== null),
    read: vi.fn(async () => content ?? ""),
    write: vi.fn(async (_path: string, _text: string) => undefined),
  };
  return { store: new MetadataStore({ configDir: ".obsidian", adapter } as never), adapter };
}

describe("MetadataStore", () => {
  it("recovers its serialized write queue after an adapter write fails", async () => {
    const adapter = {
      exists: vi.fn(),
      read: vi.fn(),
      write: vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined),
    };
    const store = new MetadataStore({ configDir: ".obsidian", adapter } as never);
    store.data = { lastSync: 1, files: {} };

    await expect(store.save()).rejects.toThrow("disk full");
    await expect(store.save()).resolves.toBeUndefined();
    expect(adapter.write).toHaveBeenCalledTimes(2);
  });

  it("loads a pre-feature file unchanged (T1)", async () => {
    const original = { lastSync: 5, files: { [FILE.path]: { ...FILE, deleted: true, deletedAt: 9 } } };
    const { store } = storeWith(JSON.stringify(original));

    await store.load();

    expect(store.data).toEqual(original);
  });

  it("drops fields written by development builds on load (T18)", async () => {
    const { store, adapter } = storeWith(JSON.stringify({
      lastSync: 5,
      pluginSyncProtocol: 1,
      localPlugins: { version: 1, receipts: {} },
      files: { [FILE.path]: { ...FILE, pluginSource: { kind: "official-release" }, pluginDeletion: { kind: "explicit-uninstall" } } },
    }));

    await store.load();
    await store.save();

    expect(store.data).toEqual({ lastSync: 5, files: { [FILE.path]: FILE } });
    expect(JSON.parse(adapter.write.mock.calls[0]![1])).toEqual({ lastSync: 5, files: { [FILE.path]: FILE } });
  });
});

describe("normalizeMetadata", () => {
  it("keeps only lastSync and the pre-feature file fields", () => {
    expect(normalizeMetadata({
      lastSync: 2,
      pluginSyncProtocol: 1,
      files: { a: { ...FILE, path: "a", localPath: "b", pluginSource: {}, pluginDeletion: {}, unknown: true } },
    })).toEqual({ lastSync: 2, files: { a: { ...FILE, path: "a", localPath: "b" } } });
  });

  it("does not throw on unknown fields but rejects a missing files object", () => {
    expect(normalizeMetadata({ lastSync: 1, files: {}, future: "field" })).toEqual({ lastSync: 1, files: {} });
    expect(() => normalizeMetadata({ lastSync: 1 })).toThrow("Invalid Gitless metadata");
    expect(() => normalizeMetadata(null)).toThrow("Invalid Gitless metadata");
  });
});
