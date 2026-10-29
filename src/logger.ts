import { Vault, normalizePath } from "obsidian";

export const LOG_FILE_NAME = "github-sync.log" as const;

export interface SerializedError {
  name: string;
  message: string;
  code?: unknown;
  path?: unknown;
  syscall?: unknown;
  cause?: SerializedError | { message: string };
}

export function serializeError(error: unknown, seen = new Set<unknown>()): SerializedError | { message: string } {
  if (!(error instanceof Error)) return { message: String(error) };
  if (seen.has(error)) return { name: error.name, message: "Circular error cause" };
  seen.add(error);

  const details: SerializedError = { name: error.name, message: error.message };
  const pathError = error as Error & { code?: unknown; path?: unknown; syscall?: unknown };
  if (pathError.code !== undefined) details.code = pathError.code;
  if (pathError.path !== undefined) details.path = pathError.path;
  if (pathError.syscall !== undefined) details.syscall = pathError.syscall;
  if ("cause" in error && error.cause !== undefined) {
    details.cause = serializeError(error.cause, seen);
  }
  return details;
}

export function formatError(error: unknown, seen = new Set<unknown>()): string {
  if (!(error instanceof Error)) return String(error);
  if (seen.has(error)) return `${error.name}: Circular error cause`;
  seen.add(error);

  const pathError = error as Error & { code?: unknown; path?: unknown; syscall?: unknown };
  const context = [pathError.code, pathError.path, pathError.syscall]
    .filter((value) => value !== undefined)
    .join(" ");
  const cause = "cause" in error && error.cause !== undefined
    ? `; caused by ${formatError(error.cause, seen)}`
    : "";
  return `${error.name}: ${error.message}${context ? ` (${context})` : ""}${cause}`;
}

export default class Logger {
  private logFile: string;
  private initialized = false;

  constructor(
    private vault: Vault,
    private enabled: boolean,
  ) {
    this.logFile = normalizePath(`${vault.configDir}/${LOG_FILE_NAME}`);
  }

  async init(): Promise<void> {
    if (!this.enabled) return;
    try {
      if (await this.vault.adapter.exists(this.logFile)) {
        this.initialized = true;
        return;
      }
      await this.vault.adapter.write(this.logFile, "");
      this.initialized = true;
    } catch (error) {
      this.reportLogFailure("initialize", error);
    }
  }

  private async write(
    level: string,
    message: string,
    data?: any,
  ): Promise<void> {
    if (!this.enabled) return;
    if (!this.initialized) await this.init();

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      additional_data: data,
    };

    try {
      await this.vault.adapter.append(this.logFile, JSON.stringify(logEntry) + "\n");
    } catch (error) {
      this.reportLogFailure("append", error);
    }
  }

  async read(): Promise<string> {
    try {
      return await this.vault.adapter.read(this.logFile);
    } catch (error) {
      this.reportLogFailure("read", error);
      throw error;
    }
  }

  async clean(): Promise<void> {
    try {
      await this.vault.adapter.write(this.logFile, "");
    } catch (error) {
      this.reportLogFailure("clean", error);
      throw error;
    }
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  async info(message: string, data?: any): Promise<void> {
    await this.write("INFO", message, data);
  }

  async warn(message: string, data?: any): Promise<void> {
    await this.write("WARN", message, data);
  }

  async error(message: string, data?: any): Promise<void> {
    await this.write("ERROR", message, data);
  }

  private reportLogFailure(operation: string, error: unknown): void {
    try {
      console.error("Failed to write GitHub Sync log", {
        operation,
        logFile: this.logFile,
        error: serializeError(error),
      });
    } catch {
      // A broken console sink must not hide the original filesystem failure.
    }
  }
}
