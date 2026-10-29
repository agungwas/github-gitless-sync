import { describe, expect, it, vi } from "vitest";
import Logger, { serializeError } from "./logger";

function makeVault() {
  const writes: string[] = [];
  const adapter = {
    exists: vi.fn(async () => false),
    read: vi.fn(async () => ""),
    write: vi.fn(async (_path: string, content: string) => { writes.push(content); }),
    append: vi.fn(async (_path: string, content: string) => { writes.push(content); }),
  };
  return { vault: { configDir: ".obsidian", adapter } as never, adapter, writes };
}

describe("Logger", () => {
  it("awaits log-file creation during initialization", async () => {
    const { vault, adapter } = makeVault();
    let finishWrite!: () => void;
    adapter.write.mockImplementation(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    const logger = new Logger(vault, true);
    let initialized = false;

    const initialization = logger.init().then(() => { initialized = true; });
    await Promise.resolve();

    expect(initialized).toBe(false);
    finishWrite();
    await initialization;
    expect(initialized).toBe(true);
  });

  it("retains nested filesystem causes in error entries", async () => {
    const { vault, adapter, writes } = makeVault();
    const logger = new Logger(vault, true);
    const rootCause = Object.assign(new Error("Permission denied"), { code: "EACCES", path: ".obsidian/plugins/x/data.json" });
    const pathError = new Error("Failed to write plugin settings", { cause: rootCause });

    await logger.error("Sync failed", { error: serializeError(pathError) });

    expect(adapter.append).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writes.at(-1)!)).toMatchObject({
      level: "ERROR",
      additional_data: {
        error: {
          message: "Failed to write plugin settings",
          cause: { message: "Permission denied", code: "EACCES", path: ".obsidian/plugins/x/data.json" },
        },
      },
    });
  });

  it("performs no log-file I/O when logging is disabled", async () => {
    const { vault, adapter, writes } = makeVault();
    const logger = new Logger(vault, false);

    await logger.init();
    await logger.info("Optional detail");
    await logger.warn("Optional warning");
    await logger.error("Path operation failed", { path: ".obsidian/plugins/x/data.json" });

    expect(adapter.exists).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
    expect(adapter.append).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("creates log file on first entry after logging is enabled", async () => {
    const { vault, adapter } = makeVault();
    const logger = new Logger(vault, false);

    logger.enable();
    await logger.error("Path operation failed");

    expect(adapter.write).toHaveBeenCalledWith(".obsidian/github-sync.log", "");
    expect(adapter.append).toHaveBeenCalledOnce();
  });

  it("uses console fallback when the log file append fails", async () => {
    const { vault, adapter } = makeVault();
    adapter.append.mockRejectedValue(new Error("ENOSPC"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = new Logger(vault, true);

    await expect(logger.error("Filesystem write failed", { path: ".obsidian/plugins/x/data.json" })).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to write GitHub Sync log"),
      expect.objectContaining({ logFile: ".obsidian/github-sync.log" }),
    );
    consoleError.mockRestore();
  });

  it("reports log-file read and clean failures to the fallback sink", async () => {
    const { vault, adapter } = makeVault();
    const readError = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    const cleanError = Object.assign(new Error("Device is full"), { code: "ENOSPC" });
    adapter.read = vi.fn().mockRejectedValue(readError);
    adapter.write = vi.fn().mockRejectedValue(cleanError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = new Logger(vault, true);

    await expect(logger.read()).rejects.toBe(readError);
    await expect(logger.clean()).rejects.toBe(cleanError);

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to write GitHub Sync log"),
      expect.objectContaining({ operation: "read", error: serializeError(readError) }),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to write GitHub Sync log"),
      expect.objectContaining({ operation: "clean", error: serializeError(cleanError) }),
    );
    consoleError.mockRestore();
  });
});
