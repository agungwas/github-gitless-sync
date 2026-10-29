import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { ensureParentDirectory, isPathMissing } from "./fs-paths";

function createAdapter(existingPaths: string[] = []) {
  const directories = new Set(existingPaths);
  const adapter = {
    exists: vi.fn(async (path: string) => directories.has(path)),
    stat: vi.fn(async (path: string) => directories.has(path)
      ? { type: "folder", ctime: 0, mtime: 0, size: 0 }
      : null),
    mkdir: vi.fn(async (path: string) => { directories.add(path); }),
  } as unknown as DataAdapter;
  return { adapter, directories };
}

describe("filesystem path helpers", () => {
  it("reports absence from adapter.exists and preserves check errors", async () => {
    const { adapter } = createAdapter(["notes"]);

    await expect(isPathMissing(adapter, "notes/missing.md")).resolves.toBe(true);
    await expect(isPathMissing(adapter, "notes")).resolves.toBe(false);

    const failure = new Error("disk unavailable");
    vi.mocked(adapter.exists).mockRejectedValueOnce(failure);
    await expect(isPathMissing(adapter, "notes/file.md")).rejects.toMatchObject({ cause: failure });
  });

  it("creates missing ancestors in order and leaves root-level files alone", async () => {
    const { adapter, directories } = createAdapter();

    await ensureParentDirectory(adapter, ".obsidian/plugins/example/data.json");
    await ensureParentDirectory(adapter, "root.md");

    expect(adapter.mkdir).toHaveBeenNthCalledWith(1, ".obsidian");
    expect(adapter.mkdir).toHaveBeenNthCalledWith(2, ".obsidian/plugins");
    expect(adapter.mkdir).toHaveBeenNthCalledWith(3, ".obsidian/plugins/example");
    expect(directories.has("root.md")).toBe(false);
    expect(adapter.mkdir).toHaveBeenCalledTimes(3);
  });

  it("does not treat an occupied file as a directory", async () => {
    const { adapter } = createAdapter(["notes"]);
    vi.mocked(adapter.stat).mockResolvedValueOnce({
      type: "file", ctime: 0, mtime: 0, size: 0,
    });

    await expect(ensureParentDirectory(adapter, "notes/file.md"))
      .rejects.toThrow("Path component notes is not a directory");
    expect(adapter.mkdir).not.toHaveBeenCalled();
  });

  it("accepts a concurrent mkdir only when the directory now exists", async () => {
    const { adapter, directories } = createAdapter();
    vi.mocked(adapter.mkdir).mockImplementationOnce(async (path) => {
      directories.add(path);
      throw new Error("already created");
    });

    await expect(ensureParentDirectory(adapter, "notes/file.md")).resolves.toBeUndefined();
    expect(adapter.mkdir).toHaveBeenCalledTimes(1);
  });

  it("preserves mkdir failure when the existence recheck also fails", async () => {
    const { adapter } = createAdapter();
    const mkdirFailure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const recheckFailure = Object.assign(new Error("disk unavailable"), { code: "EIO" });
    vi.mocked(adapter.exists)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(recheckFailure);
    vi.mocked(adapter.mkdir).mockRejectedValueOnce(mkdirFailure);

    await expect(ensureParentDirectory(adapter, "notes/file.md")).rejects.toMatchObject({
      message: expect.stringMatching(/notes.*permission denied.*recheck.*disk unavailable/i),
      cause: mkdirFailure,
    });
  });

  it("rejects paths outside the vault and retains mkdir failure as cause", async () => {
    const { adapter } = createAdapter();
    await expect(ensureParentDirectory(adapter, "../outside/file.md"))
      .rejects.toThrow("Invalid vault-relative path");
    expect(adapter.exists).not.toHaveBeenCalled();

    const failure = new Error("permission denied");
    vi.mocked(adapter.mkdir).mockRejectedValueOnce(failure);
    await expect(ensureParentDirectory(adapter, "notes/file.md"))
      .rejects.toMatchObject({ message: expect.stringContaining("notes"), cause: failure });
  });
});
