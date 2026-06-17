/**
 * Ephemeral QA verification for plan-fix-events-localpath-lookup.
 * Tests resolveMetadataKey behavior in EventsListener.
 * Not a permanent test suite — kept in .knowledge/ for QA purposes only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import EventsListener from "src/events-listener";
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
  return { path } as TFile;
}

describe("EventsListener — resolveMetadataKey (localPath reverse-lookup)", () => {
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

  it("H2 — sanitized file create event clears justDownloaded on real key, no ghost entry", async () => {
    metadataStore.data.files["foo >.md"] = {
      path: "foo >.md",
      sha: "abc",
      dirty: false,
      justDownloaded: true,
      lastModified: 100,
      localPath: "foo ＞.md",
    };

    // Simulate Obsidian firing create for disk path (sanitized)
    const createEvent = listener["onCreate"].bind(listener);
    await createEvent(makeFile("foo ＞.md"));

    // Real entry's justDownloaded cleared
    expect(metadataStore.data.files["foo >.md"].justDownloaded).toBe(false);
    // No ghost entry created
    expect(metadataStore.data.files["foo ＞.md"]).toBeUndefined();
  });

  it("H4 — modify event on sanitized file updates real metadata key", async () => {
    metadataStore.data.files["foo >.md"] = {
      path: "foo >.md",
      sha: "abc",
      dirty: false,
      justDownloaded: false,
      lastModified: 100,
      localPath: "foo ＞.md",
    };

    const modifyEvent = listener["onModify"].bind(listener);
    await modifyEvent(makeFile("foo ＞.md"));

    expect(metadataStore.data.files["foo >.md"].dirty).toBe(true);
    expect(metadataStore.data.files["foo >.md"].lastModified).toBeGreaterThan(100);
    // No ghost entry
    expect(metadataStore.data.files["foo ＞.md"]).toBeUndefined();
  });

  it("H6 — delete event on sanitized file marks real metadata key as deleted", async () => {
    metadataStore.data.files["foo >.md"] = {
      path: "foo >.md",
      sha: "abc",
      dirty: false,
      justDownloaded: false,
      lastModified: 100,
      deleted: false,
      localPath: "foo ＞.md",
    };

    const deleteEvent = listener["onDelete"].bind(listener);
    await deleteEvent("foo ＞.md");

    expect(metadataStore.data.files["foo >.md"].deleted).toBe(true);
    expect(metadataStore.data.files["foo >.md"].deletedAt).toBeDefined();
  });

  it("H7 — rename of sanitized file marks real key deleted, creates new entry", async () => {
    metadataStore.data.files["foo >.md"] = {
      path: "foo >.md",
      sha: "abc",
      dirty: false,
      justDownloaded: false,
      lastModified: 100,
      deleted: false,
      localPath: "foo ＞.md",
    };

    const renameEvent = listener["onRename"].bind(listener);
    await renameEvent(makeFile("bar.md"), "foo ＞.md");

    // Real entry marked deleted
    expect(metadataStore.data.files["foo >.md"].deleted).toBe(true);
    // New entry created at new path
    expect(metadataStore.data.files["bar.md"]).toBeDefined();
    expect(metadataStore.data.files["bar.md"].sha).toBeNull();
    expect(metadataStore.data.files["bar.md"].dirty).toBe(true);
  });

  it("E1 — empty metadata: create event creates new entry without crash", async () => {
    const createEvent = listener["onCreate"].bind(listener);
    await createEvent(makeFile("foo.md"));

    expect(metadataStore.data.files["foo.md"]).toBeDefined();
    expect(metadataStore.data.files["foo.md"].sha).toBeNull();
  });

  it("N2 — delete event for untracked file: early return, no crash", async () => {
    const deleteEvent = listener["onDelete"].bind(listener);
    await expect(deleteEvent("untracked.md")).resolves.not.toThrow();
    expect(Object.keys(metadataStore.data.files)).toHaveLength(0);
  });
});
