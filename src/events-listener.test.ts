import { describe, it, expect, vi, beforeEach } from "vitest";
import EventsListener from "./events-listener";
import { TFile, TFolder } from "obsidian";

function makeMetadataStore(files: Record<string, any> = {}) {
  const data = { files, lastSync: 0 };
  return {
    data,
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeVault(configDir = ".obsidian") {
  return { configDir };
}

function makeSettings(syncConfigDir = false) {
  return { syncConfigDir };
}

function makeFile(path: string): TFile {
  return Object.assign(new TFile(), { path });
}

function makeFolder(path: string): TFolder {
  return Object.assign(new TFolder(), { path, children: [] });
}

describe("EventsListener — edge cases (plan-fix-events-listener-edge-cases)", () => {
  let metadataStore: ReturnType<typeof makeMetadataStore>;
  let listener: EventsListener;

  beforeEach(() => {
    metadataStore = makeMetadataStore();
    listener = new EventsListener(
      makeVault() as any,
      metadataStore as any,
      makeSettings() as any,
      makeLogger() as any,
    );
  });

  describe("F1 — onModify guard for missing metadata entry", () => {
    it("F1-T1: onModify for untracked file returns without crash", async () => {
      // File not in metadata at all
      const onModify = listener["onModify"].bind(listener);
      await expect(onModify(makeFile("untracked.md"))).resolves.not.toThrow();
      expect(Object.keys(metadataStore.data.files)).toHaveLength(0);
    });

    it("F1-T2: onModify for tracked file still updates dirty/lastModified (regression guard)", async () => {
      metadataStore.data.files["foo.md"] = {
        path: "foo.md",
        sha: "abc",
        dirty: false,
        justDownloaded: false,
        lastModified: 100,
      };
      const onModify = listener["onModify"].bind(listener);
      await onModify(makeFile("foo.md"));
      expect(metadataStore.data.files["foo.md"].dirty).toBe(true);
      expect(metadataStore.data.files["foo.md"].lastModified).toBeGreaterThan(100);
    });
  });

  describe("F2 — folder delete checks localPath for sanitized folder names", () => {
    it("F2-T3: deleting sanitized folder marks children whose localPath matches folderPrefix as deleted", async () => {
      // Remote folder "folder >/" downloaded as "folder ＞/" on disk
      // Child file metadata key = "folder >/foo.md", localPath = "folder ＞/foo.md"
      metadataStore.data.files["folder >/foo.md"] = {
        path: "folder >/foo.md",
        sha: "abc",
        dirty: false,
        justDownloaded: false,
        lastModified: 100,
        deleted: false,
        localPath: "folder ＞/foo.md",
      };

      const onDelete = listener["onDelete"].bind(listener);
      // Obsidian fires delete for disk path "folder ＞" (sanitized folder name)
      await onDelete(makeFolder("folder ＞"));

      expect(metadataStore.data.files["folder >/foo.md"].deleted).toBe(true);
      expect(metadataStore.data.files["folder >/foo.md"].deletedAt).toBeDefined();
    });

    it("F2-T4: deleting normal folder still marks children deleted (regression guard)", async () => {
      metadataStore.data.files["notes/foo.md"] = {
        path: "notes/foo.md",
        sha: "abc",
        dirty: false,
        justDownloaded: false,
        lastModified: 100,
        deleted: false,
      };

      const onDelete = listener["onDelete"].bind(listener);
      await onDelete(makeFolder("notes"));

      expect(metadataStore.data.files["notes/foo.md"].deleted).toBe(true);
    });
  });

  describe("T9 — echo suppression post-migration", () => {
    it("onCreate for justDownloaded file flips to false without ghost", async () => {
      metadataStore.data.files["x ＞.md"] = {
        path: "x ＞.md",
        sha: null,
        dirty: true,
        justDownloaded: true,
      };
      const onCreate = listener["onCreate"].bind(listener);
      await onCreate(makeFile("x ＞.md"));
      expect(metadataStore.data.files["x ＞.md"].justDownloaded).toBe(false);
      expect(Object.keys(metadataStore.data.files)).toHaveLength(1);
    });

    it("onDelete for tombstoned old file stays deleted", async () => {
      metadataStore.data.files["x >.md"] = {
        path: "x >.md",
        deleted: true,
        deletedAt: 100,
        lastModified: 50,
      };
      const onDelete = listener["onDelete"].bind(listener);
      await onDelete(makeFile("x >.md"));
      
      expect(metadataStore.data.files["x >.md"].deleted).toBe(true);
    });
  });
});
