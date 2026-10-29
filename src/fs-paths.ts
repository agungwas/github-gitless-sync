import type { DataAdapter } from "obsidian";

function normalizeVaultPath(path: string): string {
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes("\\") ||
    segments.some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error(`Invalid vault-relative path: ${path}`);
  }

  const normalized = segments.filter(Boolean).join("/");
  if (!normalized) throw new Error(`Invalid vault-relative path: ${path}`);
  return normalized;
}

async function pathExists(adapter: DataAdapter, path: string): Promise<boolean> {
  try {
    return await adapter.exists(path);
  } catch (cause) {
    throw new Error(`Failed to check path ${path}: ${errorMessage(cause)}`, { cause });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function requireDirectory(adapter: DataAdapter, path: string, cause?: unknown): Promise<void> {
  let stat;
  try {
    stat = await adapter.stat(path);
  } catch (statError) {
    const message = `Failed to inspect directory ${path}: ${errorMessage(statError)}`;
    throw new Error(message, { cause: cause ?? statError });
  }

  if (!stat || stat.type !== "folder") {
    const message = `Path component ${path} is not a directory`;
    throw new Error(message, cause === undefined ? undefined : { cause });
  }
}

export async function isPathMissing(adapter: DataAdapter, path: string): Promise<boolean> {
  const normalizedPath = normalizeVaultPath(path);
  return !(await pathExists(adapter, normalizedPath));
}

export async function ensureParentDirectory(adapter: DataAdapter, filePath: string): Promise<void> {
  const normalizedPath = normalizeVaultPath(filePath);
  const parentSegments = normalizedPath.split("/").slice(0, -1);
  let parentPath = "";

  for (const segment of parentSegments) {
    parentPath = parentPath ? `${parentPath}/${segment}` : segment;
    if (await pathExists(adapter, parentPath)) {
      await requireDirectory(adapter, parentPath);
      continue;
    }

    try {
      await adapter.mkdir(parentPath);
    } catch (cause) {
      let directoryExists: boolean;
      try {
        directoryExists = await pathExists(adapter, parentPath);
      } catch (recheckError) {
        throw new Error(
          `Failed to create directory ${parentPath}: ${errorMessage(cause)}; existence recheck failed: ${errorMessage(recheckError)}`,
          { cause },
        );
      }

      if (directoryExists) {
        await requireDirectory(adapter, parentPath, cause);
        continue;
      }
      throw new Error(`Failed to create directory ${parentPath}: ${errorMessage(cause)}`, { cause });
    }
  }
}

export async function withParentDirectoryRetry<T>(
  adapter: DataAdapter,
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    await ensureParentDirectory(adapter, filePath);
    return operation();
  }
}
