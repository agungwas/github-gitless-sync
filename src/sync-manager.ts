import {
  Vault,
  Notice,
  normalizePath,
  base64ToArrayBuffer,
  arrayBufferToBase64,
  moment,
} from "obsidian";
import GithubClient, {
  GetTreeResponseItem,
  NewTreeRequestItem,
  RepoContent,
} from "./github/client";
import MetadataStore, {
  FileMetadata,
  Metadata,
  MANIFEST_FILE_NAME,
} from "./metadata-store";
import EventsListener from "./events-listener";
import { GitHubSyncSettings, getCommitMessageTemplate } from "./settings/settings";
import Logger, { LOG_FILE_NAME } from "./logger";
import { decodeBase64String, hasTextExtension, sanitizePathForLocalFilesystem, pathHasMobileIllegalChars } from "./utils";
import { isExcludedPath } from "./sync-filters";
import GitHubSyncPlugin from "./main";
import { BlobReader, Entry, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";

interface SyncAction {
  type: "upload" | "download" | "delete_local" | "delete_remote";
  filePath: string;
}

export interface ConflictFile {
  filePath: string;
  remoteContent: string;
  localContent: string;
}

export interface ConflictResolution {
  filePath: string;
  content: string;
}

type OnConflictsCallback = (
  conflicts: ConflictFile[],
) => Promise<ConflictResolution[]>;


export default class SyncManager {
  private metadataStore: MetadataStore;
  private client: GithubClient;
  private eventsListener: EventsListener;
  private syncIntervalId: number | null = null;

  // Use to track if syncing is in progress, this ideally
  // prevents multiple syncs at the same time and creation
  // of messy conflicts.
  private syncing: boolean = false;
  // Tracks an in-flight removeExcludedFromMetadata() call so sync()/firstSync()
  // can wait for it to finish before touching metadataStore.data.files themselves.
  private pendingMetadataCleanup: Promise<void> | null = null;

  constructor(
    private vault: Vault,
    private settings: GitHubSyncSettings,
    private onConflicts: OnConflictsCallback,
    private logger: Logger,
  ) {
    this.metadataStore = new MetadataStore(this.vault);
    this.client = new GithubClient(this.settings, this.logger);
    this.eventsListener = new EventsListener(
      this.vault,
      this.metadataStore,
      this.settings,
      this.logger,
    );
  }

  /**
   * Returns true if the local vault root is empty.
   */
  private async vaultIsEmpty(): Promise<boolean> {
    const { files, folders } = await this.vault.adapter.list(
      this.vault.getRoot().path,
    );
    // There are files or folders in the vault dir
    return (
      files.length === 0 ||
      // We filter out the config dir since is always present so it's fine if we find it.
      folders.filter((f) => f !== this.vault.configDir).length === 0
    );
  }

  /**
   * Handles first sync with remote and local.
   * This fails if neither remote nor local folders are empty.
   */
  async firstSync() {
    if (this.syncing) {
      this.logger.info("First sync already in progress");
      new Notice("First sync already in progress");
      // We're already syncing, nothing to do
      return;
    }

    this.syncing = true;
    if (this.pendingMetadataCleanup) {
      await this.pendingMetadataCleanup;
    }
    try {
      await this.firstSyncImpl();
    } catch (err) {
      this.syncing = false;
      throw err;
    }
    this.syncing = false;
  }

  private async firstSyncImpl() {
    await this.logger.info("Starting first sync");
    let repositoryIsEmpty = false;
    let res: RepoContent;
    let files: {
      [key: string]: GetTreeResponseItem;
    } = {};
    let treeSha: string = "";
    try {
      res = await this.client.getRepoContent();
      files = res.files;
      treeSha = res.sha;
    } catch (err) {
      // 409 is returned in case the remote repo has been just created
      // and contains no files.
      // 404 instead is returned in case there are no files.
      // Either way we can handle both by commiting a new empty manifest.
      if ((err as any).status !== 409 && (err as any).status !== 404) {
        this.syncing = false;
        throw err;
      }
      // The repository is bare, meaning it has no tree, no commits and no branches
      repositoryIsEmpty = true;
    }

    if (repositoryIsEmpty) {
      await this.logger.info("Remote repository is empty");
      // Since the repository is completely empty we need to create a first commit.
      // We can't create that by going throught the normal sync process since the
      // API doesn't let us create a new tree when the repo is empty.
      // So we create a the manifest file as the first commit, since we're going
      // to create that in any case right after this.
      const buffer = await this.vault.adapter.readBinary(
        normalizePath(`${this.vault.configDir}/${MANIFEST_FILE_NAME}`),
      );
      await this.client.createFile({
        path: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
        content: arrayBufferToBase64(buffer),
        message: "First sync",
        retry: true,
      });
      // Now get the repo content again cause we know for sure it will return a
      // valid sha that we can use to create the first sync commit.
      res = await this.client.getRepoContent({ retry: true });
      files = res.files;
      treeSha = res.sha;
    }

    const vaultIsEmpty = await this.vaultIsEmpty();

    if (!repositoryIsEmpty && !vaultIsEmpty) {
      // Both have files, we can't sync, show error
      await this.logger.error("Both remote and local have files, can't sync");
      throw new Error("Both remote and local have files, can't sync");
    } else if (repositoryIsEmpty) {
      // Remote has no files and no manifest, let's just upload whatever we have locally.
      // This is fine even if the vault is empty.
      // The most important thing at this point is that the remote manifest is created.
      await this.firstSyncFromLocal(files, treeSha);
    } else {
      // Local has no files and there's no manifest in the remote repo.
      // Let's download whatever we have in the remote repo.
      // This is fine even if the remote repo is empty.
      // In this case too the important step is that the remote manifest is created.
      await this.firstSyncFromRemote(files, treeSha);
    }
  }

  /**
   * Handles first sync with the remote repository.
   * This must be called in case there are no files in the local content dir while
   * remote has files in the repo content dir but no manifest file.
   *
   * @param files All files in the remote repository, including those not in its content dir.
   * @param treeSha The SHA of the tree in the remote repository.
   */
  private async firstSyncFromRemote(
    files: { [key: string]: GetTreeResponseItem },
    treeSha: string,
  ) {
    await this.logger.info("Starting first sync from remote files");

    // We want to avoid getting throttled by GitHub, so instead of making a request for each
    // file we download the whole repository as a ZIP file and extract it in the vault.
    // We exclude config dir files if the user doesn't want to sync those.
    const zipBuffer = await this.client.downloadRepositoryArchive();
    const zipBlob = new Blob([zipBuffer]);
    const reader = new ZipReader(new BlobReader(zipBlob));
    const entries = await reader.getEntries();

    await this.logger.info("Extracting files from ZIP", {
      length: entries.length,
    });

    // Process entries sequentially to avoid loading many files in memory at once
    // which can crash Obsidian when initializing a large Obsidian repository.
    for (const entry of entries) {
      // All repo ZIPs contain a root directory that contains all the content
      // of that repo, we need to ignore that directory so we strip the first
      // folder segment from the path
      const pathParts = entry.filename.split("/");
      const targetPath =
        pathParts.length > 1 ? pathParts.slice(1).join("/") : entry.filename;

      if (targetPath === "") {
        // Must be the root folder, skip it.
        // This is really important as that would lead us to try and
        // create the folder "/" and crash Obsidian
        continue;
      }

      if (
        !this.settings.syncConfigDir &&
        targetPath.startsWith(this.vault.configDir) &&
        targetPath !== `${this.vault.configDir}/${MANIFEST_FILE_NAME}`
      ) {
        await this.logger.info("Skipped config", { targetPath });
        continue;
      }

      if (entry.directory) {
        const normalizedPath = normalizePath(targetPath);
        try {
          await this.vault.adapter.mkdir(normalizedPath);
        } catch (err) {
          throw new Error(
            `Failed to create directory ${normalizedPath}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        await this.logger.info("Created directory", {
          normalizedPath,
        });
        continue;
      }

      if (targetPath === `${this.vault.configDir}/${LOG_FILE_NAME}`) {
        // We don't want to download the log file if the user synced it in the past.
        // This is necessary because in the past we forgot to ignore the log file
        // from syncing if the user enabled configs sync.
        // To avoid downloading it we ignore it if still present in the remote repo.
        continue;
      }

      if (targetPath.split("/").last()?.startsWith(".")) {
        // We must skip hidden files as that creates issues with syncing.
        // This is fine as users can't edit hidden files in Obsidian anyway.
        await this.logger.info("Skipping hidden file", targetPath);
        continue;
      }

      if (isExcludedPath(targetPath, this.settings.excludePatterns, this.settings.includePatterns)) {
        await this.logger.info("Skipping excluded file", targetPath);
        continue;
      }

      const writer = new Uint8ArrayWriter();
      await entry.getData!(writer);
      const data = await writer.getData();
      const dir = targetPath.split("/").splice(0, -1).join("/");
      if (dir !== "") {
        const normalizedDir = normalizePath(dir);
        try {
          await this.vault.adapter.mkdir(normalizedDir);
        } catch (err) {
          throw new Error(
            `Failed to create directory ${normalizedDir}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        await this.logger.info("Created directory", {
          normalizedDir,
        });
      }

      const normalizedPath = normalizePath(targetPath);
      const sanitizedPath = normalizePath(sanitizePathForLocalFilesystem(targetPath));
      try {
        await this.vault.adapter.writeBinary(sanitizedPath, data.buffer);
      } catch (err) {
        throw new Error(
          `Failed to write file ${sanitizedPath}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      await this.logger.info("Written file", {
        normalizedPath,
      });
      this.metadataStore.data.files[normalizedPath] = {
        path: normalizedPath,
        sha: files[normalizedPath].sha,
        dirty: false,
        justDownloaded: true,
        lastModified: Date.now(),
        ...(sanitizedPath !== normalizedPath ? { localPath: sanitizedPath } : {}),
      };
      await this.metadataStore.save();
    }

    await this.logger.info("Extracted zip");

    const newTreeFiles = Object.keys(files)
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {},
      );
    // Add files that are in the manifest but not in the tree.
    await Promise.all(
      Object.keys(this.metadataStore.data.files)
        .filter((filePath: string) => {
          return !Object.keys(files).contains(filePath);
        })
        .map(async (filePath: string) => {
          const normalizedPath = normalizePath(filePath);
          // We need to check whether the file is a text file or not before
          // reading it here because trying to read a binary file as text fails
          // on iOS, and probably on other mobile devices too, so we read the file
          // content only if we're sure it contains text only.
          //
          // It's fine not reading the binary file in here and just setting some bogus
          // content because when committing the sync we're going to read the binary
          // file and upload its blob if it needs to be synced. The important thing is
          // that some content is set so we know the file changed locally and needs to be
          // uploaded.
          let content = "binaryfile";
          if (hasTextExtension(normalizedPath)) {
            try {
              content = await this.vault.adapter.read(normalizedPath);
            } catch (err) {
              throw new Error(
                `Failed to read file ${normalizedPath}: ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
              );
            }
          }
          newTreeFiles[filePath] = {
            path: filePath,
            mode: "100644",
            type: "blob",
            content,
          };
        }),
    );
    await this.commitSync(newTreeFiles, treeSha);
  }

  /**
   * Handles first sync with the remote repository.
   * This must be called in case there are no files in the remote repo and no manifest while
   * local vault has files and a manifest.
   *
   * @param files All files in the remote repository
   * @param treeSha The SHA of the tree in the remote repository.
   */
  private async firstSyncFromLocal(
    files: { [key: string]: GetTreeResponseItem },
    treeSha: string,
  ) {
    await this.logger.info("Starting first sync from local files");
    const newTreeFiles = Object.keys(files)
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {},
      );
    await Promise.all(
      Object.keys(this.metadataStore.data.files)
        .filter((filePath: string) => {
          // We should not try to sync deleted files, this can happen when
          // the user renames or deletes files after enabling the plugin but
          // before syncing for the first time
          return !this.metadataStore.data.files[filePath].deleted;
        })
        .map(async (filePath: string) => {
          const normalizedPath = normalizePath(filePath);
          // We need to check whether the file is a text file or not before
          // reading it here because trying to read a binary file as text fails
          // on iOS, and probably on other mobile devices too, so we read the file
          // content only if we're sure it contains text only.
          //
          // It's fine not reading the binary file in here and just setting some bogus
          // content because when committing the sync we're going to read the binary
          // file and upload its blob if it needs to be synced. The important thing is
          // that some content is set so we know the file changed locally and needs to be
          // uploaded.
          let content = "binaryfile";
          if (hasTextExtension(normalizedPath)) {
            try {
              content = await this.vault.adapter.read(normalizedPath);
            } catch (err) {
              throw new Error(
                `Failed to read file ${normalizedPath}: ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
              );
            }
          }
          newTreeFiles[filePath] = {
            path: filePath,
            mode: "100644",
            type: "blob",
            content,
          };
        }),
    );
    await this.commitSync(newTreeFiles, treeSha);
  }

  /**
   * Syncs local and remote folders.
   * @returns
   */
  async sync() {
    if (this.syncing) {
      this.logger.info("Sync already in progress");
      new Notice("Sync already in progress");
      // We're already syncing, nothing to do
      return;
    }

    const notice = new Notice("Syncing...");
    this.syncing = true;
    if (this.pendingMetadataCleanup) {
      await this.pendingMetadataCleanup;
    }
    try {
      const removedFromRemoteCount = await this.syncImpl();
      // Shown only if sync doesn't fail
      await this.logger.info("Sync successful");
      const successMessage =
        removedFromRemoteCount > 0
          ? `Sync successful (${removedFromRemoteCount} removed from remote due to exclude patterns)`
          : "Sync successful";
      new Notice(successMessage, 5000);
    } catch (err) {
      await this.logger.error("Error syncing", { error: err instanceof Error ? err.message : String(err) });
      // Show the error to the user, it's not automatically dismissed to make sure
      // the user sees it.
      new Notice(`Error syncing. ${err}`);
    }
    this.syncing = false;
    notice.hide();
  }

  private async syncImpl(): Promise<number> {
    await this.logger.info("Starting sync");
    await this.reconcileConfigDirFiles();
    const { files, sha: treeSha } = await this.client.getRepoContent({
      retry: true,
    });
    const manifest = files[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`];

    if (manifest === undefined) {
      await this.logger.error("Remote manifest is missing", { files, treeSha });
      throw new Error("Remote manifest is missing");
    }

    if (
      Object.keys(files).contains(`${this.vault.configDir}/${LOG_FILE_NAME}`)
    ) {
      // We don't want to download the log file if the user synced it in the past.
      // This is necessary because in the past we forgot to ignore the log file
      // from syncing if the user enabled configs sync.
      // To avoid downloading it we delete it if still around.
      delete files[`${this.vault.configDir}/${LOG_FILE_NAME}`];
    }

    const blob = await this.client.getBlob({ sha: manifest.sha });
    const remoteMetadata: Metadata = JSON.parse(
      decodeBase64String(blob.content),
    );
    await this.removeVolatileArtifactsFromLocalMetadata();
    remoteMetadata.files = this.filterRemoteMetadataFiles(remoteMetadata.files);
    await this.reconcileRemoteMetadataWithTree(remoteMetadata.files, files);

    const migratedOldKeys = await this.migrateIllegalFilenames(remoteMetadata.files);

    const conflicts = await this.findConflicts(remoteMetadata.files, files);
    const filteredConflicts = conflicts.filter(c => !migratedOldKeys.has(c.filePath));

    // We treat every resolved conflict as an upload SyncAction, mainly cause
    // the user has complete freedom on the edits they can apply to the conflicting files.
    // So when a conflict is resolved we change the file locally and upload it.
    // That solves the conflict.
    let conflictActions: SyncAction[] = [];
    // We keep track of the conflict resolutions cause we want to update the file
    // locally only when we're sure the sync was successul. That happens after we
    // commit the sync.
    let conflictResolutions: ConflictResolution[] = [];

    if (filteredConflicts.length > 0) {
      await this.logger.warn("Found conflicts", filteredConflicts);
      if (this.settings.conflictHandling === "ask") {
        // Here we block the sync process until the user has resolved all the conflicts
        conflictResolutions = await this.onConflicts(filteredConflicts);
        conflictActions = conflictResolutions.map(
          (resolution: ConflictResolution) => {
            return { type: "upload", filePath: resolution.filePath };
          },
        );
      } else if (this.settings.conflictHandling === "overwriteLocal") {
        // The user explicitly wants to always overwrite the local file
        // in case of conflicts so we just download the remote file to solve it

        // It's not necessary to set conflict resolutions as the content the
        // user expect must be the content of the remote file with no changes.
        conflictActions = filteredConflicts.map(
          (conflict: ConflictFile) => {
            return { type: "download", filePath: conflict.filePath };
          },
        );
      } else if (this.settings.conflictHandling === "overwriteRemote") {
        // The user explicitly wants to always overwrite the remote file
        // in case of conflicts so we just upload the remote file to solve it.

        // It's not necessary to set conflict resolutions as the content the
        // user expect must be the content of the local file with no changes.
        conflictActions = filteredConflicts.map(
          (conflict: ConflictFile) => {
            return { type: "upload", filePath: conflict.filePath };
          },
        );
      }
    }

    const excludedRemoteOrphans = this.computeExcludedRemoteOrphans(files);
    const actions: SyncAction[] = [
      ...(await this.determineSyncActions(
        remoteMetadata.files,
        this.metadataStore.data.files,
        conflictActions.map((action) => action.filePath),
      )),
      ...conflictActions,
      ...excludedRemoteOrphans,
    ];

    if (actions.length === 0) {
      // Nothing to sync
      await this.logger.info("Nothing to sync");
      return 0;
    }
    await this.logger.info("Actions to sync", actions);

    const newTreeFiles: { [key: string]: NewTreeRequestItem } = Object.keys(
      files,
    )
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {},
      );

    await Promise.all(
      actions.map(async (action) => {
        switch (action.type) {
          case "upload": {
            const normalizedPath = normalizePath(action.filePath);
            const localPath = this.metadataStore.data.files[action.filePath]?.localPath ?? normalizedPath;
            if (!(await this.vault.adapter.exists(localPath))) {
              // File was removed from disk without the delete event being tracked
              // (e.g., a plugin folder deleted via Obsidian UI). Treat as a remote
              // deletion instead so the file is removed from GitHub on next sync.
              await this.logger.warn(
                "Upload action skipped: file no longer exists, treating as delete_remote",
                action.filePath,
              );
              if (this.metadataStore.data.files[action.filePath]) {
                this.metadataStore.data.files[action.filePath].deleted = true;
                this.metadataStore.data.files[action.filePath].deletedAt =
                  Date.now();
              }
              if (newTreeFiles[action.filePath]) {
                newTreeFiles[action.filePath].sha = null;
              }
              break;
            }
            const resolution = conflictResolutions.find(
              (c: ConflictResolution) => c.filePath === action.filePath,
            );
            // If the file was conflicting we need to read the content from the
            // conflict resolution instead of reading it from file since at this point
            // we still have not updated the local file.
            let content: string;
            if (resolution?.content) {
              content = resolution.content;
            } else {
              try {
                content = await this.vault.adapter.read(localPath);
              } catch (err) {
                throw new Error(
                  `Failed to read file ${localPath}: ${err instanceof Error ? err.message : String(err)}`,
                  { cause: err },
                );
              }
            }
            newTreeFiles[action.filePath] = {
              path: action.filePath,
              mode: "100644",
              type: "blob",
              content: content,
            };
            break;
          }
          case "delete_remote":
            if (newTreeFiles[action.filePath]) {
              newTreeFiles[action.filePath].sha = null;
            }
            break;
          case "download":
            break;
          case "delete_local":
            break;
        }
      }),
    );

    // Download files and delete local files
    await Promise.all([
      ...actions
        .filter((action) => action.type === "download")
        .map(async (action: SyncAction) => {
          await this.downloadFile(
            files[action.filePath],
            remoteMetadata.files[action.filePath].lastModified,
          );
        }),
      ...actions
        .filter((action) => action.type === "delete_local")
        .map(async (action: SyncAction) => {
          await this.deleteLocalFile(action.filePath);
        }),
    ]);

    await this.commitSync(newTreeFiles, treeSha, conflictResolutions);
    return excludedRemoteOrphans.length;
  }

  private isInternalSyncFile(filePath: string): boolean {
    return (
      filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}` ||
      this.isLogFile(filePath)
    );
  }

  private isLogFile(filePath: string): boolean {
    return filePath === `${this.vault.configDir}/${LOG_FILE_NAME}`;
  }

  private isVolatileSyncArtifact(filePath: string): boolean {
    return (
      this.isLogFile(filePath) ||
      filePath === `${this.vault.configDir}/workspace.json` ||
      filePath === `${this.vault.configDir}/workspace-mobile.json`
    );
  }

  shouldSkipFile(filePath: string): boolean {
    if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
      // The manifest must never be treated as excluded, even if a user
      // pattern would otherwise match it.
      return false;
    }
    return (
      this.isVolatileSyncArtifact(filePath) ||
      isExcludedPath(filePath, this.settings.excludePatterns, this.settings.includePatterns)
    );
  }

  /**
   * Whether filePath is actually synced under current settings -- shouldSkipFile()
   * plus the syncConfigDir gate and the configDir dot-file skip that live
   * separately in determineSyncActions() and reconcileConfigDirFiles(). Single
   * choke point for "will this file really sync", used by the settings-tab preview.
   */
  isPathSyncable(filePath: string): boolean {
    if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
      return true;
    }
    if (this.shouldSkipFile(filePath)) {
      return false;
    }
    if (!this.settings.syncConfigDir && filePath.startsWith(this.vault.configDir)) {
      return false;
    }
    if (
      filePath.startsWith(`${this.vault.configDir}/`) &&
      filePath.split("/").last()?.startsWith(".")
    ) {
      return false;
    }
    return true;
  }

  /**
   * Finds paths that are no longer synced under current settings but are still
   * present in the raw remote git tree from before that stopped being true --
   * an exclude pattern added after the file was already tracked, or syncConfigDir
   * turned off, or a dot-prefixed configDir file. These were dropped from
   * local+remote metadata by removeExcludedFromMetadata()/removeConfigDirFromMetadata(),
   * which never touch the remote repo itself. Returns one delete_remote action
   * per orphan so the next commit actually removes the blob from GitHub.
   */
  private computeExcludedRemoteOrphans(files: {
    [key: string]: GetTreeResponseItem;
  }): SyncAction[] {
    return Object.keys(files)
      .filter((filePath) => filePath !== `${this.vault.configDir}/${MANIFEST_FILE_NAME}`)
      .filter((filePath) => !this.isPathSyncable(filePath))
      .map((filePath) => ({ type: "delete_remote", filePath }));
  }

  private filterRemoteMetadataFiles(filesMetadata: {
    [key: string]: FileMetadata;
  }): {
    [key: string]: FileMetadata;
  } {
    return Object.keys(filesMetadata).reduce(
      (acc: { [key: string]: FileMetadata }, filePath: string) => {
        if (this.shouldSkipFile(filePath)) {
          return acc;
        }
        acc[filePath] = filesMetadata[filePath];
        return acc;
      },
      {},
    );
  }

  /**
   * Removes volatile artifacts from local metadata to prevent recurring conflicts.
   */
  private async removeVolatileArtifactsFromLocalMetadata() {
    let changed = false;
    Object.keys(this.metadataStore.data.files).forEach((filePath: string) => {
      if (this.shouldSkipFile(filePath)) {
        delete this.metadataStore.data.files[filePath];
        changed = true;
      }
    });
    if (changed) {
      await this.metadataStore.save();
    }
  }

  /**
   * Scans vault.configDir and adds any untracked files to local metadata.
   * Also resets files marked deleted that have since reappeared on disk (e.g. reinstalled plugin/theme).
   * No-op when syncConfigDir is disabled.
   */
  private async reconcileConfigDirFiles(): Promise<void> {
    if (!this.settings.syncConfigDir) {
      return;
    }

    let configFiles: string[] = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (!folder) continue;
      const res = await this.vault.adapter.list(folder);
      configFiles.push(...res.files);
      folders.push(...res.folders);
    }

    let changed = false;
    for (const filePath of configFiles) {
      if (this.shouldSkipFile(filePath)) continue;
      if (filePath.split("/").last()?.startsWith(".")) continue;

      const existing = this.metadataStore.data.files[filePath];
      if (!existing) {
        // Case A: new file, not yet tracked
        this.metadataStore.data.files[filePath] = {
          path: filePath,
          sha: null,
          dirty: false,
          justDownloaded: false,
          lastModified: Date.now(),
        };
        changed = true;
      } else if (existing.deleted === true) {
        // Case B: file marked deleted but exists on disk — likely reinstalled
        const stat = await this.vault.adapter.stat(filePath);
        if (stat === null) continue;
        if (stat.mtime <= (existing.deletedAt as number)) continue;
        // File appeared after deletion timestamp → reinstalled
        existing.deleted = false;
        existing.deletedAt = null;
        existing.sha = null;
        existing.lastModified = stat.mtime;
        changed = true;
      }
    }

    if (changed) {
      await this.logger.info("Reconciled config dir files into metadata");
      await this.metadataStore.save();
    }
  }

  /**
   * Reconciles remote metadata SHAs with the current tree to remove stale references.
   */
  private async reconcileRemoteMetadataWithTree(
    remoteMetadataFiles: {
      [key: string]: FileMetadata;
    },
    remoteRepoFiles: {
      [key: string]: GetTreeResponseItem;
    },
  ) {
    let updatedEntries = 0;
    let updatedSha = 0;
    Object.keys(remoteMetadataFiles).forEach((filePath: string) => {
      const metadataFile = remoteMetadataFiles[filePath];
      if (!metadataFile || metadataFile.deleted) {
        return;
      }
      const remoteTreeFile = remoteRepoFiles[filePath];
      if (!remoteTreeFile || !remoteTreeFile.sha) {
        return;
      }
      if (metadataFile.sha !== remoteTreeFile.sha) {
        metadataFile.sha = remoteTreeFile.sha;
        updatedEntries += 1;
        updatedSha += 1;
      }
    });
    if (updatedEntries > 0) {
      await this.logger.warn("Reconciled remote metadata with repository tree", {
        updatedEntries,
        updatedSha,
      });
    }
  }

  /**
   * Tries to load a blob by metadata SHA and, on 404, retries with the current tree SHA.
   */
  private async getRemoteFileContentWithFallback(
    filePath: string,
    metadataFile: FileMetadata,
    remoteRepoFiles: {
      [key: string]: GetTreeResponseItem;
    },
  ): Promise<string | null> {
    if (!metadataFile || metadataFile.deleted) {
      return null;
    }

    let sha = metadataFile.sha;
    if (!sha) {
      const remoteTreeFile = remoteRepoFiles[filePath];
      if (!remoteTreeFile?.sha) {
        return null;
      }
      sha = remoteTreeFile.sha;
      metadataFile.sha = sha;
    }

    try {
      const res = await this.client.getBlob({
        sha,
        retry: true,
        maxRetries: 1,
      });
      return decodeBase64String(res.content);
    } catch (err: any) {
      if (err?.status !== 404) {
        throw new Error(
          `Failed to fetch remote content for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    const remoteTreeFile = remoteRepoFiles[filePath];
    if (!remoteTreeFile?.sha) {
      await this.logger.warn("Blob SHA missing for remote file", {
        filePath,
        staleSha: sha,
      });
      return null;
    }
    if (remoteTreeFile.sha === sha) {
      await this.logger.warn("Blob SHA not found for remote file", {
        filePath,
        sha,
      });
      return null;
    }

    await this.logger.warn("Recovering from stale blob SHA using tree SHA", {
      filePath,
      staleSha: sha,
      treeSha: remoteTreeFile.sha,
    });
    metadataFile.sha = remoteTreeFile.sha;

    const res = await this.client.getBlob({
      sha: remoteTreeFile.sha,
      retry: true,
      maxRetries: 1,
    });
    return decodeBase64String(res.content);
  }

  private async migrateIllegalFilenames(
    remoteMetadataFiles: { [key: string]: FileMetadata },
  ): Promise<Set<string>> {
    const migratedOldKeys = new Set<string>();

    for (const key of Object.keys(this.metadataStore.data.files)) {
      if (this.isInternalSyncFile(key)) continue;

      const entry = this.metadataStore.data.files[key];
      if (entry.deleted) continue;

      const sanitizedKey = normalizePath(sanitizePathForLocalFilesystem(key));
      if (sanitizedKey === normalizePath(key)) continue;

      // Collision guard
      if (
        (this.metadataStore.data.files[sanitizedKey] && !this.metadataStore.data.files[sanitizedKey].deleted) ||
        (remoteMetadataFiles[sanitizedKey] && !remoteMetadataFiles[sanitizedKey].deleted)
      ) {
        this.logger.warn("Skipping migration, target exists (collision)", { key, sanitizedKey });
        continue;
      }

      const currentDisk = entry.localPath ?? normalizePath(key);
      const willRename = currentDisk !== sanitizedKey;

      if (willRename) {
        if (await this.vault.adapter.exists(currentDisk)) {
          const folder = normalizePath(sanitizedKey.split("/").slice(0, -1).join("/"));
          if (folder !== "/" && folder !== "") {
            try {
              const folderExists = await this.vault.adapter.exists(folder);
              if (!folderExists) {
                await this.vault.adapter.mkdir(folder);
              }
            } catch (e) {
              this.logger.warn(`Failed to create folder for migration: ${folder}`, e);
            }
          }

          try {
            const buf = await this.vault.adapter.readBinary(currentDisk);
            await this.vault.adapter.writeBinary(sanitizedKey, buf);
            await this.vault.adapter.remove(currentDisk);
          } catch (e) {
            this.logger.warn(`Failed to rename file for migration: ${currentDisk} -> ${sanitizedKey}`, e);
          }
        } else {
          this.logger.warn("Migration source missing on disk", currentDisk);
        }
      }

      // Re-key metadata
      this.metadataStore.data.files[sanitizedKey] = {
        path: sanitizedKey,
        sha: null,
        dirty: true,
        justDownloaded: willRename,
        lastModified: Date.now(),
      };

      entry.deleted = true;
      entry.deletedAt = Date.now();
      migratedOldKeys.add(key);
    }

    if (migratedOldKeys.size > 0) {
      await this.metadataStore.save();
      this.logger.info("Migrated illegal filenames", { count: migratedOldKeys.size });
    }

    return migratedOldKeys;
  }

  /**
   * Finds conflicts between local and remote files.
   * @param filesMetadata Remote files metadata
   * @param remoteRepoFiles Current remote repository tree
   * @returns List of object containing file path, remote and local content of conflicting files
   */
  async findConflicts(
    filesMetadata: {
      [key: string]: FileMetadata;
    },
    remoteRepoFiles: {
      [key: string]: GetTreeResponseItem;
    }
  ): Promise<ConflictFile[]> {
    const commonFiles = Object.keys(filesMetadata).filter(
      (key) => key in this.metadataStore.data.files,
    );
    if (commonFiles.length === 0) {
      return [];
    }

    const conflicts = await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (this.isInternalSyncFile(filePath)) {
          // Internal files must not handle conflicts
          return null;
        }
        const remoteFile = filesMetadata[filePath];
        const localFile = this.metadataStore.data.files[filePath];
        if (remoteFile.deleted && localFile.deleted) {
          return null;
        }
        const actualLocalSHA = await this.calculateSHA(filePath);
        const remoteFileHasBeenModifiedSinceLastSync =
          remoteFile.sha !== localFile.sha;
        const localFileHasBeenModifiedSinceLastSync =
          actualLocalSHA !== localFile.sha;
        // This is an unlikely case. If the user manually edits
        // the local file so that's identical to the remote one,
        // but the local metadata SHA is different we don't want
        // to show a conflict.
        // Since that would show two identical files.
        // Checking for this prevents showing a non conflict to the user.
        const actualFilesAreDifferent = remoteFile.sha !== actualLocalSHA;
        if (
          remoteFileHasBeenModifiedSinceLastSync &&
          localFileHasBeenModifiedSinceLastSync &&
          actualFilesAreDifferent
        ) {
          return filePath;
        }
        return null;
      }),
    );

    const resolvedConflicts = await Promise.all(
      conflicts
        .filter((filePath): filePath is string => filePath !== null)
        .map(async (filePath: string) => {
          const remoteContent = await this.getRemoteFileContentWithFallback(
            filePath,
            filesMetadata[filePath],
            remoteRepoFiles,
          );
          if (remoteContent === null) {
            return null;
          }
          let localContent = "";
          if (await this.vault.adapter.exists(normalizePath(filePath))) {
            localContent = await this.vault.adapter.read(
              normalizePath(filePath),
            );
          }
          return {
            filePath,
            remoteContent,
            localContent,
          };
        }),
    );

    return resolvedConflicts.filter(
      (conflict): conflict is ConflictFile => conflict !== null,
    );
  }

  /**
   * Determines which sync action to take for each file.
   *
   * @param remoteFiles All files in the remote repo
   * @param localFiles All files in the local vault
   * @param conflictFiles List of paths to files that have conflict with remote
   *
   * @returns List of SyncActions
   */
  async determineSyncActions(
    remoteFiles: { [key: string]: FileMetadata },
    localFiles: { [key: string]: FileMetadata },
    conflictFiles: string[],
  ) {
    let actions: SyncAction[] = [];

    const commonFiles = Object.keys(remoteFiles)
      .filter((filePath) => filePath in localFiles)
      // Remove conflicting files, we determine their actions in a different way
      .filter((filePath) => !conflictFiles.contains(filePath));

    // Get diff for common files
    await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
          // The manifest file must never trigger any action
          return;
        }

        const remoteFile = remoteFiles[filePath];
        const localFile = localFiles[filePath];
        if (remoteFile.deleted && localFile.deleted) {
          // Nothing to do
          return;
        }

        const localSHA = await this.calculateSHA(filePath);

        if (remoteFile.deleted && !localFile.deleted) {
          if ((remoteFile.deletedAt as number) > localFile.lastModified) {
            actions.push({
              type: "delete_local",
              filePath: filePath,
            });
            return;
          } else if (
            localFile.lastModified > (remoteFile.deletedAt as number)
          ) {
            actions.push({ type: "upload", filePath: filePath });
            return;
          }
        }

        if (!remoteFile.deleted && localFile.deleted) {
          if (remoteFile.lastModified > (localFile.deletedAt as number)) {
            actions.push({ type: "download", filePath: filePath });
            return;
          } else if (
            (localFile.deletedAt as number) > remoteFile.lastModified
          ) {
            actions.push({
              type: "delete_remote",
              filePath: filePath,
            });
            return;
          }
        }
        if (remoteFile.sha === localSHA) {
          // If the remote file sha is identical to the actual sha of the local file
          // there are no actions to take.
          return;
        }

        // For non-deletion cases, use SHA as the primary source of truth.
        // Conflicts are already filtered out above so we can safely determine direction.
        if (localSHA !== localFile.sha) {
          // Local file has changed since last sync → upload it.
          // This is the authoritative check: if the SHA on disk differs from what
          // we last recorded, the user (or a plugin) modified the file locally.
          actions.push({ type: "upload", filePath: filePath });
          return;
        } else {
          // Local file unchanged since last sync, but remote SHA differs →
          // the remote was updated by another device → download it.
          actions.push({ type: "download", filePath: filePath });
          return;
        }
      }),
    );

    // Get diff for files in remote but not in local
    Object.keys(remoteFiles).forEach((filePath: string) => {
      const remoteFile = remoteFiles[filePath];
      const localFile = localFiles[filePath];
      if (localFile) {
        // Local file exists, we already handled it.
        // Skip it.
        return;
      }
      if (remoteFile.deleted) {
        // Remote is deleted but we don't have it locally.
        // Nothing to do.
        // TODO: Maybe we need to remove remote reference too?
      } else {
        actions.push({ type: "download", filePath: filePath });
      }
    });

    // Get diff for files in local but not in remote
    Object.keys(localFiles).forEach((filePath: string) => {
      const remoteFile = remoteFiles[filePath];
      const localFile = localFiles[filePath];
      if (remoteFile) {
        // Remote file exists, we already handled it.
        // Skip it.
        return;
      }
      if (localFile.deleted) {
        // Local is deleted and remote doesn't exist.
        // Just remove the local reference.
      } else {
        actions.push({ type: "upload", filePath: filePath });
      }
    });

    return actions.filter((action: SyncAction) => {
      if (action.filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
        // The manifest file is always synced.
        return true;
      }
      if (isExcludedPath(action.filePath, this.settings.excludePatterns, this.settings.includePatterns)) {
        return false;
      }
      if (!this.settings.syncConfigDir && action.filePath.startsWith(this.vault.configDir)) {
        // Remove actions that involve the config directory if the user doesn't want to sync it.
        return false;
      }
      return true;
    });
  }

  /**
   * Calculates the SHA1 of a file given its content.
   * This is the same identical algoritm used by git to calculate
   * a blob's SHA.
   * @param filePath normalized path to file
   * @returns String containing the file SHA1 or null in case the file doesn't exist
   */
  async calculateSHA(filePath: string): Promise<string | null> {
    const localPath = this.metadataStore.data.files[filePath]?.localPath ?? normalizePath(filePath);
    if (!(await this.vault.adapter.exists(localPath))) {
      // The file doesn't exist, can't calculate any SHA
      return null;
    }
    const contentBuffer = await this.vault.adapter.readBinary(localPath);
    const contentBytes = new Uint8Array(contentBuffer);
    const header = new TextEncoder().encode(`blob ${contentBytes.length}\0`);
    const store = new Uint8Array([...header, ...contentBytes]);
    return await crypto.subtle.digest("SHA-1", store).then((hash) =>
      Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  }

  async calculateSHAFromString(content: string): Promise<string> {
    const contentBytes = new TextEncoder().encode(content);
    const header = new TextEncoder().encode(`blob ${contentBytes.length}\0`);
    const store = new Uint8Array([...header, ...contentBytes]);
    return await crypto.subtle.digest("SHA-1", store).then((hash) =>
      Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  }

  private static buildCommitMessage(template: string): string {
    return template.replace(/\{([^}]+)\}/g, (match, token: string) => {
      const formatted = (moment as any)().format(token);
      return formatted === token ? match : formatted;
    });
  }

  /**
   * Creates a new sync commit in the remote repository.
   *
   * @param treeFiles Updated list of files in the remote tree
   * @param baseTreeSha sha of the tree to use as base for the new tree
   * @param conflictResolutions list of conflicts between remote and local files
   */
  async commitSync(
    treeFiles: { [key: string]: NewTreeRequestItem },
    baseTreeSha: string,
    conflictResolutions: ConflictResolution[] = [],
  ) {
    // Update local sync time
    const syncTime = Date.now();
    this.metadataStore.data.lastSync = syncTime;
    this.metadataStore.save();

    // We update the last modified timestamp for all files that had resolved conflicts
    // to the the same time as the sync time.
    // At this time we still have not written the conflict resolution content to file,
    // so the last modified timestamp doesn't reflect that.
    // To prevent further conflicts in future syncs and to reflect the content change
    // on the remote metadata we update the timestamp for the conflicting files here,
    // just before pushing to remote.
    // We're going to update the local content when the sync is successful.
    conflictResolutions.forEach((resolution) => {
      this.metadataStore.data.files[resolution.filePath].lastModified =
        syncTime;
    });

    // We want the remote metadata file to track the correct SHA for each file blob,
    // so just before we upload any file we update all their SHAs in the metadata file.
    // This also makes it easier to handle conflicts.
    // We don't save the metadata file after setting the SHAs cause we do that when
    // the sync is fully commited at the end.
    // TODO: Understand whether it's a problem we don't revert the SHA setting in case of sync failure
    //
    // In here we also upload blob is file is a binary. We do it here because when uploading a blob we
    // also get back its SHA, so we can set it together with other files.
    // We also do that right before creating the new tree because we need the SHAs of those blob to
    // correctly create it.
    await Promise.all(
      Object.keys(treeFiles)
        .filter((filePath: string) => treeFiles[filePath].content)
        .map(async (filePath: string) => {
          // I don't fully trust file extensions as they're not completely reliable
          // to determine the file type, though I feel it's ok to compromise and rely
          // on them if it makes the plugin handle upload better on certain devices.
          if (hasTextExtension(filePath)) {
            const sha = await this.calculateSHAFromString(treeFiles[filePath].content as string);
            if (this.metadataStore.data.files[filePath]) {
              this.metadataStore.data.files[filePath].sha = sha;
            } else {
              this.metadataStore.data.files[filePath] = {
                path: filePath,
                sha: sha,
                dirty: false,
                justDownloaded: false,
                lastModified: syncTime,
                deleted: false,
              };
            }
            return;
          }

          // We can't upload binary files by setting the content of a tree item,
          // we first need to create a Git blob by uploading the file, then
          // we must update the tree item to point the SHA to the blob we just created.
          let buffer: ArrayBuffer;
          try {
            buffer = await this.vault.adapter.readBinary(filePath);
          } catch (err) {
            throw new Error(
              `Failed to read binary file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
          let sha: string;
          try {
            const result = await this.client.createBlob({
              content: arrayBufferToBase64(buffer),
              retry: true,
              maxRetries: 3,
            });
            sha = result.sha;
          } catch (err) {
            throw new Error(
              `Failed to upload binary blob for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
          await this.logger.info("Created blob", filePath);
          treeFiles[filePath].sha = sha;
          // Can't have both sha and content set, so we delete it
          delete treeFiles[filePath].content;

          if (this.metadataStore.data.files[filePath]) {
            this.metadataStore.data.files[filePath].sha = sha;
          } else {
            this.metadataStore.data.files[filePath] = {
              path: filePath,
              sha: sha,
              dirty: false,
              justDownloaded: false,
              lastModified: syncTime,
              deleted: false,
            };
          }
        }),
    );

    // Update manifest in list of new tree items
    delete treeFiles[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`].sha;
    treeFiles[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`].content =
      JSON.stringify(this.metadataStore.data);

    // Create the new tree
    const newTree: { tree: NewTreeRequestItem[]; base_tree: string } = {
      tree: Object.keys(treeFiles).map(
        (filePath: string) => treeFiles[filePath],
      ),
      base_tree: baseTreeSha,
    };
    const newTreeSha = await this.client.createTree({
      tree: newTree,
      retry: true,
    });

    const branchHeadSha = await this.client.getBranchHeadSha({ retry: true });

    const message = SyncManager.buildCommitMessage(getCommitMessageTemplate());

    const commitSha = await this.client.createCommit({
      message,
      treeSha: newTreeSha,
      parent: branchHeadSha,
    });

    await this.client.updateBranchHead({ sha: commitSha, retry: true });

    // Update the local content of all files that had conflicts we resolved
    await Promise.all(
      conflictResolutions.map(async (resolution) => {
        try {
          const writePath = this.metadataStore.data.files[resolution.filePath]?.localPath
            ?? normalizePath(resolution.filePath);
          await this.vault.adapter.write(writePath, resolution.content);
        } catch (err) {
          throw new Error(
            `Failed to write conflict resolution for ${resolution.filePath}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        // Even though we set the last modified timestamp for all files with conflicts
        // just before pushing the changes to remote we do it here again because the
        // write right above would overwrite that.
        // Since we want to keep the sync timestamp for this file to avoid future conflicts
        // we update it again.
        this.metadataStore.data.files[resolution.filePath].lastModified =
          syncTime;
      }),
    );
    // Now that the sync is done and we updated the content for conflicting files
    // we can save the latest metadata to disk.
    this.metadataStore.save();
    await this.logger.info("Sync done");
  }

  async downloadFile(file: GetTreeResponseItem, lastModified: number) {
    const fileMetadata = this.metadataStore.data.files[file.path];
    if (fileMetadata && fileMetadata.sha === file.sha) {
      return;
    }
    const blob = await this.client.getBlob({ sha: file.sha, retry: true });
    const sanitizedPath = normalizePath(sanitizePathForLocalFilesystem(file.path));
    const fileFolder = normalizePath(sanitizedPath.split("/").slice(0, -1).join("/"));
    if (!(await this.vault.adapter.exists(fileFolder))) {
      try {
        await this.vault.adapter.mkdir(fileFolder);
      } catch (err) {
        throw new Error(
          `Failed to create directory ${fileFolder}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
    try {
      await this.vault.adapter.writeBinary(sanitizedPath, base64ToArrayBuffer(blob.content));
    } catch (err) {
      throw new Error(
        `Failed to write file ${sanitizedPath}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const localPathDiffers = sanitizedPath !== normalizePath(file.path);
    this.metadataStore.data.files[file.path] = {
      path: file.path,
      sha: file.sha,
      dirty: false,
      justDownloaded: true,
      lastModified,
      ...(localPathDiffers ? { localPath: sanitizedPath } : {}),
    };
    await this.metadataStore.save();
  }

  async deleteLocalFile(filePath: string) {
    const localPath = this.metadataStore.data.files[filePath]?.localPath ?? normalizePath(filePath);
    try {
      await this.vault.adapter.remove(localPath);
    } catch (err) {
      throw new Error(
        `Failed to delete file ${localPath}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    this.metadataStore.data.files[filePath].deleted = true;
    this.metadataStore.data.files[filePath].deletedAt = Date.now();
    this.metadataStore.save();
  }

  async loadMetadata() {
    await this.logger.info("Loading metadata");
    await this.metadataStore.load();
    if (Object.keys(this.metadataStore.data.files).length === 0) {
      await this.logger.info("Metadata was empty, loading all files");
      let files = [];
      let folders = [this.vault.getRoot().path];
      while (folders.length > 0) {
        const folder = folders.pop();
        if (folder === undefined) {
          continue;
        }
        if (!this.settings.syncConfigDir && folder === this.vault.configDir) {
          await this.logger.info("Skipping config dir");
          // Skip the config dir if the user doesn't want to sync it
          continue;
        }
        const res = await this.vault.adapter.list(folder);
        files.push(...res.files);
        folders.push(...res.folders);
      }
      files.forEach((filePath: string) => {

        if (this.shouldSkipFile(filePath)) {
          return;
        }

        this.metadataStore.data.files[filePath] = {
          path: filePath,
          sha: null,
          dirty: false,
          justDownloaded: false,
          lastModified: Date.now(),
        };
      });

      // Must be the first time we run, initialize the metadata store
      // with itself and all files in the vault.
      this.metadataStore.data.files[
        `${this.vault.configDir}/${MANIFEST_FILE_NAME}`
      ] = {
        path: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
        sha: null,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
      };
      this.metadataStore.save();
    } else if (this.settings.syncConfigDir) {
      await this.reconcileConfigDirFiles();
    }
    await this.removeVolatileArtifactsFromLocalMetadata();
    await this.logger.info("Loaded metadata");
  }

  /**
   * Add all the files in the config dir in the metadata store.
   * This is mainly useful when the user changes the sync config settings
   * as we need to add those files to the metadata store or they would never be synced.
   */
  async addConfigDirToMetadata() {
    await this.logger.info("Adding config dir to metadata");
    // Get all the files in the config dir
    let files = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }
    // Add them to the metadata store
    files.forEach((filePath: string) => {
      if (this.shouldSkipFile(filePath)) {
        return;
      }
      this.metadataStore.data.files[filePath] = {
        path: filePath,
        sha: null,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
      };
    });
    this.metadataStore.save();
  }

  /**
   * Remove all the files in the config dir from the metadata store.
   * The metadata file is not removed as it must always be present.
   * This is mainly useful when the user changes the sync config settings
   * as we need to remove those files to the metadata store or they would
   * keep being synced.
   */
  async removeConfigDirFromMetadata() {
    await this.logger.info("Removing config dir from metadata");
    // Get all the files in the config dir
    let files = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }

    // Remove all them from the metadata store
    files.forEach((filePath: string) => {
      if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
        // We don't want to remove the metadata file even if it's in the config dir
        return;
      }
      delete this.metadataStore.data.files[filePath];
    });
    this.metadataStore.save();
  }

  /**
   * Removes tracked metadata entries that currently match settings.excludePatterns
   * (and are not overridden by settings.includePatterns). Does not touch the
   * physical file on disk -- same non-destructive contract as removeConfigDirFromMetadata.
   */
  async removeExcludedFromMetadata() {
    if (this.syncing) {
      await this.logger.info("Skipping excluded-metadata cleanup: sync in progress");
      return;
    }
    const cleanup = this.performExcludedMetadataCleanup();
    this.pendingMetadataCleanup = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.pendingMetadataCleanup === cleanup) {
        this.pendingMetadataCleanup = null;
      }
    }
  }

  private async performExcludedMetadataCleanup() {
    let changed = false;
    Object.keys(this.metadataStore.data.files).forEach((filePath: string) => {
      const fileMetadata = this.metadataStore.data.files[filePath];
      const matchPath = fileMetadata.localPath ?? filePath;
      if (this.shouldSkipFile(matchPath)) {
        delete this.metadataStore.data.files[filePath];
        changed = true;
      }
    });
    if (changed) {
      await this.logger.info("Removed excluded files from metadata");
      await this.metadataStore.save();
    }
  }

  getFileMetadata(filePath: string): FileMetadata {
    return this.metadataStore.data.files[filePath];
  }

  startEventsListener(plugin: GitHubSyncPlugin) {
    this.eventsListener.start(plugin);
  }

  /**
   * Starts a new sync interval.
   * Raises an error if the interval is already running.
   */
  startSyncInterval(minutes: number): number {
    if (this.syncIntervalId) {
      throw new Error("Sync interval is already running");
    }
    this.syncIntervalId = window.setInterval(
      async () => await this.sync(),
      // Sync interval is set in minutes but setInterval expects milliseconds
      minutes * 60 * 1000,
    );
    return this.syncIntervalId;
  }

  /**
   * Stops the currently running sync interval
   */
  stopSyncInterval() {
    if (this.syncIntervalId) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  /**
   * Util function that stops and restart the sync interval
   */
  restartSyncInterval(minutes: number) {
    this.stopSyncInterval();
    return this.startSyncInterval(minutes);
  }

  async resetMetadata() {
    this.metadataStore.reset();
    await this.metadataStore.save();
  }
}
