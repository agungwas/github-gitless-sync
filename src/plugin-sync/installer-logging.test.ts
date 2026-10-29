import { describe, expect, it, vi } from "vitest";
import Logger from "../logger";
import { PluginPackageInstaller } from "./installer";

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const packageFiles = {
  manifest: {
    id: "quickadd", name: "QuickAdd", version: "1.2.3", author: "Author",
    description: "test package", minAppVersion: "1.0.0", isDesktopOnly: false,
  },
  assets: { mainJs: bytes("new main"), stylesCss: bytes("new styles") },
};

function setup() {
  const directories = new Set<string>();
  const files = new Map<string, ArrayBuffer>();
  const adapter = {
    exists: vi.fn(async (path: string) => directories.has(path) || files.has(path)),
    mkdir: vi.fn(async (path: string) => { directories.add(path); }),
    rmdir: vi.fn(async (path: string) => { directories.delete(path); }),
    readBinary: vi.fn(async (path: string) => files.get(path)!),
    writeBinary: vi.fn(async (path: string, content: ArrayBuffer) => { files.set(path, content); }),
    read: vi.fn(async (path: string) => new TextDecoder().decode(files.get(path))),
    remove: vi.fn(async (path: string) => { files.delete(path); }),
    append: vi.fn(async () => undefined),
  };
  const logger = { error: vi.fn(async () => undefined), warn: vi.fn(async () => undefined) };
  const runtime = { isLoaded: vi.fn(() => false), unload: vi.fn(), enable: vi.fn() };
  const vault = { adapter } as never;
  const installer = new PluginPackageInstaller(vault, runtime as never, ".obsidian/.staging", logger as never);
  return { installer, adapter, directories, files, logger };
}

describe("PluginPackageInstaller filesystem diagnostics", () => {
  it("propagates staging directory creation errors with path and original cause", async () => {
    const { installer, adapter } = setup();
    const cause = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    adapter.mkdir.mockRejectedValueOnce(cause);

    await expect(installer.install(
      "quickadd", ".obsidian/plugins/quickadd", JSON.stringify(packageFiles.manifest), packageFiles,
      ".obsidian/plugins/quickadd/main.js", ".obsidian/plugins/quickadd/styles.css", { runtimeFailures: [] } as never,
    )).rejects.toMatchObject({
      message: expect.stringContaining(".obsidian/.staging"),
      cause,
    });
  });

  it("logs staging cleanup failures with their path and cause", async () => {
    const { installer, adapter, logger, directories } = setup();
    directories.add(".obsidian/.staging");
    const cause = Object.assign(new Error("Device is full"), { code: "ENOSPC" });
    adapter.rmdir.mockRejectedValueOnce(cause);

    await installer.cleanupStaging();

    expect(logger.error).toHaveBeenCalledWith("Community plugin staging cleanup failed", {
      path: ".obsidian/.staging",
      error: expect.objectContaining({ message: "Device is full", code: "ENOSPC" }),
    });
  });

  it("logs rollback failures with affected package path and cause", async () => {
    const { installer, adapter, files, logger } = setup();
    const target = ".obsidian/plugins/quickadd/main.js";
    files.set(target, bytes("old main"));
    let targetWrites = 0;
    adapter.writeBinary.mockImplementation(async (path: string, content: ArrayBuffer) => {
      if (path === target && ++targetWrites > 0) throw Object.assign(new Error("Read-only filesystem"), { code: "EROFS" });
      files.set(path, content);
    });

    await expect(installer.install(
      "quickadd", ".obsidian/plugins/quickadd", JSON.stringify(packageFiles.manifest), packageFiles,
      target, ".obsidian/plugins/quickadd/styles.css", { runtimeFailures: [] } as never,
    )).rejects.toThrow("rollback remains pending");

    expect(logger.error).toHaveBeenCalledWith("Community plugin install rollback failed", {
      id: "quickadd",
      path: target,
      error: expect.objectContaining({ message: "Read-only filesystem", code: "EROFS" }),
    });
  });
});
