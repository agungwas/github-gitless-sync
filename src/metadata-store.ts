import { Vault, normalizePath } from "obsidian";

export const MANIFEST_FILE_NAME = "github-sync-metadata.json" as const;

/**
 * A file metadata.
 * Store info that makes easier to track a file locally and in the remote repo.
 */
export interface FileMetadata {
  // Local path to the file
  path: string;
  // Sanitized local filesystem path. Set when the remote path contains
  // characters illegal on the current platform. Undefined when local path
  // equals remote path.
  localPath?: string;
  // SHA of the file in the remote repository.
  // This is necessary to update the file remotely.
  // If this is null the file has not yet been pushed to the remote repository.
  // This doesn't change when the file is manually edited by the user but only
  // when uploading or downloading this file.
  // In short this is the SHA of the remote file at the time of the last sync,
  // as far as the local environment is aware.
  sha: string | null;
  // Whether the file has been modified locally.
  dirty: boolean;
  // This is mostly used to track if the file has been just downloaded from the remote.
  // This is necessary since even when creating a file programatically after it has been
  // downloaded it will trigger a 'create' or 'modify' event.
  // This is a problem as we can't know whether an event has been triggered by us or the user.
  justDownloaded: boolean;
  // The last time the file was modified
  lastModified: number;
  // Whether the file has been deleted
  deleted?: boolean | null;
  // When the file was deleted
  deletedAt?: number | null;
}

export interface Metadata {
  lastSync: number;
  files: { [key: string]: FileMetadata };
}

const FILE_METADATA_KEYS = [
  "path", "localPath", "sha", "dirty", "justDownloaded", "lastModified", "deleted", "deletedAt",
] as const;

/**
 * Reduces parsed metadata to its stable shape: `lastSync` and `files` with the
 * fields of FileMetadata. Anything else, such as fields written by other
 * versions, is dropped so it is never copied into local state or re-uploaded.
 */
export function normalizeMetadata(value: unknown): Metadata {
  const record = value as { lastSync?: unknown; files?: unknown } | null;
  if (typeof record !== "object" || record === null || typeof record.files !== "object" || record.files === null) {
    throw new Error("Invalid Gitless metadata");
  }
  const files: Record<string, FileMetadata> = {};
  for (const [path, file] of Object.entries(record.files)) {
    if (typeof file !== "object" || file === null) continue;
    const source = file as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const key of FILE_METADATA_KEYS) {
      if (source[key] !== undefined) kept[key] = source[key];
    }
    files[path] = kept as unknown as FileMetadata;
  }
  return { lastSync: typeof record.lastSync === "number" ? record.lastSync : 0, files };
}

/**
 * Stores files metadata between sesssions.
 * Data is saved as JSON in the .obsidian folder in the current Vault.
 */
export default class MetadataStore {
  data: Metadata;
  private metadataFile: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private vault: Vault) {
    this.metadataFile = normalizePath(
      `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
    );
  }

  /**
   * Loads the metadata from disk.
   */
  async load() {
    const fileExists = await this.vault.adapter.exists(this.metadataFile);
    if (fileExists) {
      const content = await this.vault.adapter.read(this.metadataFile);
      this.data = normalizeMetadata(JSON.parse(content));
    } else {
      this.data = { lastSync: 0, files: {} };
    }
  }

  /**
   * Save current metadata to disk.
   */
  async save() {
    const nextWrite = this.writeQueue.catch(() => undefined).then(async () => {
      await this.vault.adapter.write(
        this.metadataFile,
        JSON.stringify(this.data),
      );
    });
    this.writeQueue = nextWrite;
    return nextWrite;
  }

  reset() {
    this.data = { lastSync: 0, files: {} };
  }
}
