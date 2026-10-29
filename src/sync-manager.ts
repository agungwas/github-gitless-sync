import {
  Platform,
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
  RepoSnapshot,
} from "./github/client";
import MetadataStore, {
  FileMetadata,
  Metadata,
  MANIFEST_FILE_NAME,
} from "./metadata-store";
import EventsListener from "./events-listener";
import { GitHubSyncSettings, getCommitMessageTemplate } from "./settings/settings";
import Logger, { LOG_FILE_NAME, serializeError } from "./logger";
import { decodeBase64String, hasTextExtension, sanitizePathForLocalFilesystem, pathHasMobileIllegalChars } from "./utils";
import { classifyPath, PathDecision, PolicyContext } from "./plugin-sync/path-policy";
import { isExcludedPath } from "./sync-filters";
import GitHubSyncPlugin from "./main";
import { BlobReader, Entry, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { PluginManagerRuntime } from "./plugin-sync/runtime-bridge";
import { PluginSyncCoordinator } from "./plugin-sync/coordinator";
import { ensureParentDirectory, isPathMissing, withParentDirectoryRetry } from "./fs-paths";

const MS_PER_DAY = 86_400_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SyncAction {
  type: "upload" | "download" | "delete_local" | "delete_remote";
  filePath: string;
}

export interface ConflictFile {
  filePath: string;
  remoteContent: string;
  localContent: string;
  pluginUninstall?: { pluginId: string; localPaths: string[]; changedPaths: string[] };
}

export interface ConflictResolution {
  filePath: string;
  content: string;
  pluginUninstallChoice?: "keep-local" | "accept-uninstall";
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
  private readonly pluginSyncCoordinator: PluginSyncCoordinator;

  constructor(
    private vault: Vault,
    private settings: GitHubSyncSettings,
    private onConflicts: OnConflictsCallback,
    private logger: Logger,
    credentialProvider?: () => Promise<string | null>,
    private readonly selfPluginId = "gitless",
    pluginManager?: PluginManagerRuntime,
  ) {
    this.metadataStore = new MetadataStore(this.vault);
    this.client = new GithubClient(this.settings, this.logger, credentialProvider);
    this.pluginSyncCoordinator = new PluginSyncCoordinator({
      vault: this.vault,
      metadataStore: this.metadataStore,
      settings: this.settings,
      logger: this.logger,
      selfPluginId,
      pluginManager,
      isCustomPlugin: (id) => this.pathDecision(`${this.vault.configDir}/plugins/${id}/manifest.json`).owner === "custom",
    });
    this.configurePluginSync();
    this.eventsListener = new EventsListener(
      this.vault,
      this.metadataStore,
      this.settings,
      this.logger,
      this.selfPluginId,
    );
  }

  configurePluginSync(): void {
    this.pluginSyncCoordinator.configure();
  }

  stopPluginSync(): void {
    this.pluginSyncCoordinator.stop();
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
    try {
      if (this.pendingMetadataCleanup) await this.pendingMetadataCleanup;
      await this.firstSyncImpl();
      if (this.settings.syncCommunityPlugins) {
        const snapshot = await this.client.getSnapshot({ metadataPath: `${this.vault.configDir}/${MANIFEST_FILE_NAME}` });
        await this.pluginSyncCoordinator.reconciler?.reconcile(snapshot.complete, new Set());
      }
    } catch (error) {
      await this.logSyncFailure("Error during first sync", error);
      throw error;
    } finally {
      this.syncing = false;
    }
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

    const metadataPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    if (!repositoryIsEmpty && files[metadataPath]) {
      const snapshot = await this.client.getSnapshot({ metadataPath });
      if (await this.adoptSharedSnapshot(snapshot)) {
        await this.logger.info("Adopted cloned vault using shared Gitless metadata", snapshot.commitSha);
        await this.syncImpl();
        return;
      }
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

  private async adoptSharedSnapshot(snapshot: RepoSnapshot): Promise<boolean> {
    if (!snapshot.complete || !snapshot.metadata) return false;
    this.metadataStore.data = { lastSync: snapshot.metadata.lastSync, files: snapshot.metadata.files };
    await this.metadataStore.save();
    return true;
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

      if (targetPath.startsWith(`${this.vault.configDir}/`) && !this.isPathSyncable(targetPath)) {
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

      if (!this.isPathSyncable(targetPath)) {
        await this.logger.info("Skipping excluded file", targetPath);
        continue;
      }

      const writer = new Uint8ArrayWriter();
      await entry.getData!(writer);
      let data = await writer.getData();
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
    const localSnapshot: { [key: string]: FileMetadata } = Object.fromEntries(
      Object.entries(this.metadataStore.data.files).map(([k, v]) => [k, { ...v }]),
    );
    await this.commitSync(newTreeFiles, treeSha, localSnapshot);
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
    const localSnapshot: { [key: string]: FileMetadata } = Object.fromEntries(
      Object.entries(this.metadataStore.data.files).map(([k, v]) => [k, { ...v }]),
    );
    await this.commitSync(newTreeFiles, treeSha, localSnapshot);
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
    try {
      if (this.pendingMetadataCleanup) await this.pendingMetadataCleanup;
      const removedFromRemoteCount = await this.syncImpl();
      // Shown only if sync doesn't fail
      await this.logger.info("Sync successful");
      const successMessage =
        removedFromRemoteCount > 0
          ? `Sync successful (${removedFromRemoteCount} removed from remote due to exclude patterns)`
          : "Sync successful";
      new Notice(successMessage, 5000);
    } catch (err) {
      await this.logSyncFailure("Error syncing", err);
      // Show the error to the user, it's not automatically dismissed to make sure
      // the user sees it.
      new Notice(`Error syncing. ${err}`);
    } finally {
      this.syncing = false;
      notice.hide();
    }
  }

  private async logSyncFailure(message: string, error: unknown): Promise<void> {
    try {
      await this.logger.error(message, { error: serializeError(error) });
    } catch (loggingError) {
      try {
        console.error("Failed to persist sync error", {
          error: serializeError(loggingError),
          originalError: serializeError(error),
        });
      } catch {
        // Logging failure must not hide the original sync failure.
      }
    }
  }

  private async syncImpl(): Promise<number> {
    await this.logger.info("Starting sync");
    await this.reconcileConfigDirFiles();
    let pinnedSnapshot: RepoSnapshot | null = null;
    let files: Record<string, GetTreeResponseItem>;
    let treeSha: string;
    if (this.settings.syncCommunityPlugins) {
      pinnedSnapshot = await this.client.getSnapshot({
        metadataPath: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
      });
      files = pinnedSnapshot.files;
      treeSha = pinnedSnapshot.treeSha;
    } else {
      const repo = await this.client.getRepoContent({ retry: true });
      files = repo.files;
      treeSha = repo.sha;
    }
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

    let remoteMetadata: Metadata;
    if (pinnedSnapshot) {
      if (!pinnedSnapshot.metadata) throw new Error("Remote manifest metadata is missing or invalid");
      remoteMetadata = {
        lastSync: pinnedSnapshot.metadata.lastSync,
        files: pinnedSnapshot.metadata.files,
      };
    } else {
      const blob = await this.client.getBlob({ sha: manifest.sha });
      remoteMetadata = JSON.parse(decodeBase64String(blob.content));
    }
    await this.removeVolatileArtifactsFromLocalMetadata();
    remoteMetadata.files = this.filterRemoteMetadataFiles(remoteMetadata.files);
    await this.reconcileRemoteMetadataWithTree(remoteMetadata.files, files);

    const migratedOldKeys = await this.migrateIllegalFilenames(remoteMetadata.files);

    // Frozen snapshot of local metadata, taken after reconcileConfigDirFiles() and
    // migrateIllegalFilenames() have applied their own legitimate this-sync mutations.
    // Everything from here on (action determination, manifest content) reads/writes this
    // snapshot instead of the live this.metadataStore.data.files object, so a concurrent
    // vault event (e.g. another plugin writing a file while this sync awaits a GitHub API
    // round-trip) can never leak a file reference into this commit's manifest without a
    // matching tree item — it stays live-only and is picked up on the next sync.
    const localSnapshot: { [key: string]: FileMetadata } = Object.fromEntries(
      Object.entries(this.metadataStore.data.files).map(([k, v]) => [k, { ...v }]),
    );
    const conflicts = await this.findConflicts(remoteMetadata.files, files);
    const pluginUninstallConflicts = this.settings.syncCommunityPlugins
      ? await this.findPluginUninstallConflicts(remoteMetadata.files, localSnapshot)
      : [];
    const filteredConflicts = [
      ...conflicts.filter(c => !migratedOldKeys.has(c.filePath)),
      ...pluginUninstallConflicts.filter(c => !conflicts.some((existing) => existing.filePath === c.filePath)),
    ];

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
      await this.logger.warn("Found conflicts", filteredConflicts.map((conflict) => ({
        filePath: conflict.filePath,
        pluginUninstall: conflict.pluginUninstall?.pluginId,
      })));
      const uninstallConflicts = filteredConflicts.filter((conflict) => conflict.pluginUninstall);
      if (this.settings.conflictHandling === "ask") {
        // Here we block the sync process until the user has resolved all the conflicts
        conflictResolutions = await this.onConflicts(filteredConflicts);
      } else {
        // The user chose a side for every conflict. Ordinary conflicts are solved
        // by a plain download/upload below, uninstall conflicts by a plugin choice.
        conflictResolutions = this.resolvePluginUninstallConflicts(
          uninstallConflicts,
          this.settings.conflictHandling === "overwriteLocal" ? "accept-uninstall" : "keep-local",
        );
        conflictActions = filteredConflicts
          .filter((conflict) => !conflict.pluginUninstall)
          .map((conflict: ConflictFile): SyncAction => ({
            type: this.settings.conflictHandling === "overwriteLocal" ? "download" : "upload",
            filePath: conflict.filePath,
          }));
      }
      const pluginConflicts = new Map(filteredConflicts
        .filter((conflict) => conflict.pluginUninstall)
        .map((conflict) => [conflict.pluginUninstall!.pluginId, conflict] as const));
      const acceptedUninstalls = new Set<string>();
      for (const resolution of conflictResolutions) {
        if (!resolution.pluginUninstallChoice) {
          conflictActions.push({ type: "upload", filePath: resolution.filePath });
          continue;
        }
        const conflict = [...pluginConflicts.values()].find((item) => item.filePath === resolution.filePath);
        const details = conflict?.pluginUninstall;
        if (!details) throw new Error("Plugin uninstall resolution did not match a pending conflict");
        if (resolution.pluginUninstallChoice === "keep-local") {
          for (const path of details.localPaths) {
            conflictActions.push({ type: "upload", filePath: path });
            const local = localSnapshot[path];
            if (local) {
              local.deleted = false;
              delete local.deletedAt;
            }
            const live = this.metadataStore.data.files[path];
            if (live) {
              live.deleted = false;
              delete live.deletedAt;
            }
          }
        } else {
          acceptedUninstalls.add(details.pluginId);
          const manifestPath = `${this.vault.configDir}/plugins/${details.pluginId}/manifest.json`;
          const remote = remoteMetadata.files[manifestPath];
          for (const path of details.localPaths) {
            const local = localSnapshot[path] ?? (remoteMetadata.files[path] ? { ...remoteMetadata.files[path]! } : undefined);
            if (!local) continue;
            local.deleted = true;
            local.deletedAt = remote?.deletedAt ?? Date.now();
            localSnapshot[path] = local;
            const live = this.metadataStore.data.files[path];
            if (live) {
              live.deleted = true;
              live.deletedAt = local.deletedAt;
            } else {
              this.metadataStore.data.files[path] = { ...local };
            }
          }
        }
      }
      for (const id of acceptedUninstalls) {
        const pluginConflict = pluginConflicts.get(id)!;
        for (const path of pluginConflict.pluginUninstall!.localPaths) {
          if (!conflictActions.some((action) => action.filePath === path)) {
            conflictActions.push({ type: "delete_local", filePath: path });
          }
        }
      }
    }

    const enabledPath = `${this.vault.configDir}/community-plugins.json`;
    const remoteEnabledFile = files[enabledPath];
    if (
      Platform.isMobile && this.settings.syncCommunityPlugins && remoteEnabledFile &&
      !filteredConflicts.some((conflict) => conflict.filePath === enabledPath) &&
      await this.vault.adapter.exists(enabledPath)
    ) {
      try {
        const [localText, remoteBlob] = await Promise.all([
          this.vault.adapter.read(enabledPath),
          this.client.getBlob({ sha: remoteEnabledFile.sha, retry: true }),
        ]);
        const preserved = await this.preserveDesktopOnlyIds(localText, decodeBase64String(remoteBlob.content));
        // Written locally first so the uploaded content equals the local file; otherwise
        // the file would look changed on every following sync.
        if (preserved !== null) await this.vault.adapter.write(enabledPath, preserved);
      } catch (error) {
        await this.logger.error("Could not preserve desktop-only plugin ids", {
          path: enabledPath,
          error: serializeError(error),
        });
      }
    }

    const excludedRemoteOrphans = this.computeExcludedRemoteOrphans(files);
    const actions: SyncAction[] = [
      ...(await this.determineSyncActions(
        remoteMetadata.files,
        localSnapshot,
        conflictActions.map((action) => action.filePath),
      )),
      ...conflictActions,
      ...excludedRemoteOrphans,
    ];

    if (actions.length === 0) {
      // Nothing to sync
      await this.logger.info("Nothing to sync");
      if (pinnedSnapshot) await this.pluginSyncCoordinator.reconciler?.reconcile(pinnedSnapshot.complete, new Set());
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
            const localPath = localSnapshot[action.filePath]?.localPath ?? normalizedPath;
            if (!(await this.vault.adapter.exists(localPath))) {
              if (this.isManagedPluginPath(action.filePath)) {
                await this.logger.warn(
                  "Deferred ambiguous plugin removal until explicit uninstall evidence exists",
                  action.filePath,
                );
                break;
              }
              // File was removed from disk without the delete event being tracked
              // (e.g., a plugin folder deleted via Obsidian UI). Treat as a remote
              // deletion instead so the file is removed from GitHub on next sync.
              await this.logger.warn(
                "Upload action skipped: file no longer exists, treating as delete_remote",
                action.filePath,
              );
              if (localSnapshot[action.filePath]) {
                localSnapshot[action.filePath].deleted = true;
                localSnapshot[action.filePath].deletedAt = Date.now();
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
            if (
              this.isManagedPluginPath(action.filePath) &&
              !this.hasAcceptedPluginUninstall(action.filePath, localSnapshot) &&
              !this.isVerifiedPluginBinaryMigration(action.filePath)
            ) {
              await this.logger.warn("Blocked plugin deletion without explicit uninstall evidence", action.filePath);
              break;
            }
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

    // Download files and delete local files. Gitless's own manifest is written
    // after the rest so an interrupted sync never leaves a new manifest with an old main.js.
    const selfManifestPath = `${this.vault.configDir}/plugins/${this.selfPluginId}/manifest.json`;
    const downloadAction = async (action: SyncAction) => {
      if (this.isPhantomManifestEntry(files, action.filePath)) {
        // The manifest lists this path as live but the raw remote tree has no
        // matching item for it (e.g. a drift-causing race on the device that
        // committed it). Don't crash — tombstone it in the snapshot so the
        // manifest this sync commits marks it deleted, converging the remote
        // state instead of repeating this on every future sync.
        await this.logger.warn(
          "Download action skipped: manifest references a file missing from the remote tree",
          action.filePath,
        );
        localSnapshot[action.filePath] = {
          path: action.filePath,
          sha: null,
          dirty: false,
          justDownloaded: false,
          lastModified: Date.now(),
          deleted: true,
          deletedAt: Date.now(),
        };
        return;
      }
      const downloadedMetadata = await this.downloadFile(
        files[action.filePath],
        remoteMetadata.files[action.filePath].lastModified,
        remoteMetadata.files[action.filePath],
      );
      localSnapshot[action.filePath] = { ...downloadedMetadata };
    };
    await Promise.all([
      ...actions
        .filter((action) => action.type === "download" && action.filePath !== selfManifestPath)
        .map(downloadAction),
      ...actions
        .filter((action) => action.type === "delete_local")
        .map(async (action: SyncAction) => {
          const incomingMetadata = remoteMetadata.files[action.filePath];
          const tombstone = incomingMetadata?.deleted
            ? incomingMetadata
            : localSnapshot[action.filePath]?.deleted ? localSnapshot[action.filePath] : undefined;
          await this.deleteLocalFile(action.filePath, tombstone);
          const deletedFile = this.metadataStore.data.files[action.filePath];
          // The commit uses this snapshot, so deleting only live metadata would republish a live entry.
          if (deletedFile) localSnapshot[action.filePath] = { ...deletedFile };
        }),
    ]);

    for (const action of actions) {
      if (action.type === "download" && action.filePath === selfManifestPath) await downloadAction(action);
    }

    await this.commitSync(newTreeFiles, treeSha, localSnapshot, conflictResolutions, pinnedSnapshot?.commitSha);
    if (pinnedSnapshot) {
      await this.pluginSyncCoordinator.reconciler?.reconcile(
        pinnedSnapshot.complete,
        this.collectHydrateIds(actions, conflictResolutions),
      );
    }
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

  private pathDecision(filePath: string): PathDecision {
    const context: PolicyContext = {
      configDir: this.vault.configDir,
      syncConfigDir: this.settings.syncConfigDir,
      syncCommunityPlugins: this.settings.syncCommunityPlugins,
      excludePatterns: this.settings.excludePatterns,
      includePatterns: this.settings.includePatterns,
      selfPluginId: this.selfPluginId,
    };
    return classifyPath(filePath, context);
  }

  private isManagedPluginPath(filePath: string): boolean {
    const owner = this.pathDecision(filePath).owner;
    return owner === "managed" || owner === "self";
  }


  /**
   * Plugin ids whose package files must be re-downloaded: a managed manifest was written
   * by this sync, either downloaded or settled by a conflict resolution (except an accepted uninstall).
   */
  private collectHydrateIds(actions: SyncAction[], resolutions: ConflictResolution[]): Set<string> {
    const manifestPaths = [
      ...actions.filter((action) => action.type === "download").map((action) => action.filePath),
      ...resolutions
        .filter((resolution) => resolution.pluginUninstallChoice !== "accept-uninstall")
        .map((resolution) => resolution.filePath),
    ];
    const prefix = `${this.vault.configDir}/plugins/`;
    const ids = new Set<string>();
    for (const path of manifestPaths) {
      if (!path.startsWith(prefix) || this.pathDecision(path).owner !== "managed") continue;
      const [id, name, ...rest] = path.slice(prefix.length).split("/");
      if (id && name === "manifest.json" && rest.length === 0) ids.add(id);
    }
    return ids;
  }

  private resolvePluginUninstallConflicts(
    conflicts: ConflictFile[],
    choice: "accept-uninstall" | "keep-local",
  ): ConflictResolution[] {
    // content is ignored for accept-uninstall (shouldApplyConflictContent) and is the unchanged local file for keep-local
    return conflicts.map((conflict) => ({
      filePath: conflict.filePath,
      content: conflict.localContent,
      pluginUninstallChoice: choice,
    }));
  }

  private isPluginDesiredStatePath(filePath: string): boolean {
    if (filePath === `${this.vault.configDir}/community-plugins.json`) return true;
    const prefix = `${this.vault.configDir}/plugins/`;
    if (!filePath.startsWith(prefix)) return false;
    const parts = filePath.slice(prefix.length).split("/");
    return parts.length === 2 && ["manifest.json", "data.json"].includes(parts[1] ?? "");
  }

  private isVerifiedPluginBinaryMigration(filePath: string): boolean {
    if (!this.settings.syncCommunityPlugins) return false;
    const prefix = `${this.vault.configDir}/plugins/`;
    if (!filePath.startsWith(prefix)) return false;
    const parts = filePath.slice(prefix.length).split("/");
    if (parts.length !== 2 || !["main.js", "styles.css"].includes(parts[1] ?? "")) return false;
    return parts[0] !== this.selfPluginId && this.pathDecision(filePath).owner === "managed";
  }

  private hasAcceptedPluginUninstall(filePath: string, files: Record<string, FileMetadata>): boolean {
    const prefix = `${this.vault.configDir}/plugins/`;
    if (!filePath.startsWith(prefix)) return false;
    const pluginId = filePath.slice(prefix.length).split("/")[0];
    if (!pluginId || pluginId === this.selfPluginId) return false;
    const manifest = files[`${prefix}${pluginId}/manifest.json`];
    return manifest?.deleted === true;
  }

  private async findPluginUninstallConflicts(
    remoteFiles: Record<string, FileMetadata>,
    localFiles: Record<string, FileMetadata>,
  ): Promise<ConflictFile[]> {
    const prefix = `${this.vault.configDir}/plugins/`;
    const conflicts: ConflictFile[] = [];
    for (const [manifestPath, remoteManifest] of Object.entries(remoteFiles)) {
      if (!manifestPath.startsWith(prefix) || remoteManifest.deleted !== true) continue;
      const parts = manifestPath.slice(prefix.length).split("/");
      if (parts.length !== 2 || parts[1] !== "manifest.json" || parts[0] === this.selfPluginId) continue;
      const id = parts[0];
      const localPaths: string[] = [];
      const changedPaths: string[] = [];
      let localManifest = "";
      for (const path of [manifestPath, `${prefix}${id}/data.json`]) {
        const local = localFiles[path];
        if (!local || local.deleted) continue;
        const localPath = local.localPath ?? normalizePath(path);
        if (!(await this.vault.adapter.exists(localPath))) continue;
        localPaths.push(path);
        const actualSha = await this.calculateSHA(path);
        if (actualSha !== local.sha) {
          changedPaths.push(path);
          if (path === manifestPath) localManifest = await this.vault.adapter.read(localPath);
        }
      }
      if (changedPaths.length) {
        if (!localPaths.includes(manifestPath)) localPaths.unshift(manifestPath);
        if (!localManifest) {
          const localPath = localFiles[manifestPath]?.localPath ?? normalizePath(manifestPath);
          if (await this.vault.adapter.exists(localPath)) localManifest = await this.vault.adapter.read(localPath);
        }
        conflicts.push({
          filePath: manifestPath,
          remoteContent: "",
          localContent: localManifest,
          pluginUninstall: { pluginId: id, localPaths, changedPaths },
        });
      }
    }
    return conflicts;
  }

  shouldSkipFile(filePath: string): boolean {
    if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
      // The manifest must never be treated as excluded, even if a user
      // pattern would otherwise match it.
      return false;
    }
    const pathDecision = this.pathDecision(filePath);
    if (pathDecision.owner === "managed" || pathDecision.owner === "self" || pathDecision.owner === "internal") {
      return pathDecision.transport === "local";
    }
    if (pathDecision.owner === "custom") return false;
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
    const pathDecision = this.pathDecision(filePath);
    if (pathDecision.owner !== "ordinary") return pathDecision.transport !== "local";
    if (pathDecision.transport === "local") return false;
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
      .filter((filePath) => {
        const pathDecision = this.pathDecision(filePath);
        // Desired state stays on the remote regardless of this device's filters, unless the
        // user opted this exact data.json out on purpose.
        if (this.isPluginDesiredStatePath(filePath) && !pathDecision.settingsOptOut) return false;
        const verifiedBinaryMigration = this.isVerifiedPluginBinaryMigration(filePath);
        return verifiedBinaryMigration || (pathDecision.cleanup !== "binary-migration" && !this.isPathSyncable(filePath));
      })
      .map((filePath) => ({ type: "delete_remote", filePath }));
  }

  /**
   * True when the manifest lists filePath as live but the raw remote tree
   * (the actual git commit) has no matching item for it.
   */
  private isPhantomManifestEntry(
    files: { [key: string]: GetTreeResponseItem },
    filePath: string,
  ): boolean {
    return files[filePath] === undefined;
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
    if (!this.settings.syncConfigDir && !this.settings.syncCommunityPlugins) {
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
      if (!this.isPathSyncable(filePath)) continue;
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
        await this.logger.warn("Skipping migration, target exists (collision)", { key, sanitizedKey });
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
              await this.logger.error("Failed to create folder for migration", {
                path: folder,
                error: serializeError(e),
              });
            }
          }

          try {
            const buf = await this.vault.adapter.readBinary(currentDisk);
            await this.vault.adapter.writeBinary(sanitizedKey, buf);
            await this.vault.adapter.remove(currentDisk);
          } catch (e) {
            await this.logger.error("Failed to rename file for migration", {
              source: currentDisk,
              destination: sanitizedKey,
              error: serializeError(e),
            });
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
      await this.logger.info("Migrated illegal filenames", { count: migratedOldKeys.size });
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

        if (this.settings.syncCommunityPlugins && remoteFile.deleted && this.hasAcceptedPluginUninstall(filePath, remoteFiles)) {
          // Local edits are resolved as package conflicts first; clocks cannot resurrect an unchanged package.
          actions.push({ type: "delete_local", filePath });
          return;
        }

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
      return this.isPathSyncable(action.filePath);
    });
  }

  /**
   * Finds tombstones that are past the retention window and whose file is gone
   * from this vault. Returns each path with the `deletedAt` it was judged on.
   */
  async findExpiredTombstones(
    files: { [key: string]: FileMetadata },
    now: number,
  ): Promise<Map<string, number>> {
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    const retentionMs = this.settings.tombstoneRetentionDays * MS_PER_DAY;
    const aged = Object.entries(files).filter(
      ([filePath, file]) =>
        filePath !== manifestPath &&
        file.deleted &&
        typeof file.deletedAt === "number" &&
        now - file.deletedAt > retentionMs,
    );
    const stillOnDisk = await Promise.all(
      aged.map(([filePath, file]) => this.existsWithExactCase(file.localPath ?? normalizePath(filePath))),
    );
    return new Map(
      aged.filter((_, i) => !stillOnDisk[i]).map(([filePath, file]) => [filePath, file.deletedAt as number]),
    );
  }

  private dropTombstonesFromSnapshot(
    snapshot: { [key: string]: FileMetadata },
    expired: Map<string, number>,
  ) {
    for (const filePath of expired.keys()) delete snapshot[filePath];
  }

  /**
   * Only drops a live row if it is still the same tombstone; a concurrent event
   * may have recreated or re-deleted the file while the sync was running.
   */
  private async dropTombstonesFromLiveMetadata(expired: Map<string, number>) {
    for (const [filePath, deletedAt] of expired) {
      const live = this.metadataStore.data.files[filePath];
      if (live?.deleted && live.deletedAt === deletedAt) delete this.metadataStore.data.files[filePath];
    }
    if (expired.size > 0) {
      await this.logger.info("Pruned expired tombstones", [...expired.keys()]);
    }
  }

  /**
   * `adapter.exists` ignores letter case on macOS/Windows, so `A.md` would look present
   * while only `a.md` is on disk. When it reports a hit, confirm the exact name is listed.
   */
  private async existsWithExactCase(localPath: string): Promise<boolean> {
    if (!(await this.vault.adapter.exists(localPath))) return false;
    const slash = localPath.lastIndexOf("/");
    const folder = slash < 0 ? "/" : localPath.slice(0, slash);
    const listing = await this.vault.adapter.list(folder);
    return [...listing.files, ...listing.folders].includes(localPath);
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
    localMetadataSnapshot: { [key: string]: FileMetadata },
    conflictResolutions: ConflictResolution[] = [],
    baseCommitSha?: string,
  ) {
    const capturedMetadataSnapshot = Object.fromEntries(
      Object.entries(localMetadataSnapshot).map(([path, file]) => [path, { ...file }]),
    );
    const syncTime = Date.now();
    this.metadataStore.data.lastSync = syncTime;
    await this.metadataStore.save();

    this.stampResolvedConflictTimes(localMetadataSnapshot, conflictResolutions, syncTime);
    await this.attachShasToTreeFiles(treeFiles, localMetadataSnapshot, syncTime);

    const expiredTombstones = await this.findExpiredTombstones(localMetadataSnapshot, syncTime);
    this.dropTombstonesFromSnapshot(localMetadataSnapshot, expiredTombstones);

    this.writeMetadataIntoTree(treeFiles, localMetadataSnapshot);
    await this.prepareConflictDestinations(conflictResolutions);
    await this.pushCommit(treeFiles, baseTreeSha, baseCommitSha);

    this.mergeCommittedSnapshotIntoLive(localMetadataSnapshot, capturedMetadataSnapshot);
    await this.dropTombstonesFromLiveMetadata(expiredTombstones);
    await this.applyResolvedConflictContent(conflictResolutions, syncTime);

    // Now that the sync is done and we updated the content for conflicting files
    // we can save the latest metadata to disk.
    await this.metadataStore.save();
    await this.logger.info("Sync done");
  }

  /**
   * We update the last modified timestamp for all files that had resolved conflicts
   * to the same time as the sync time.
   * At this time we still have not written the conflict resolution content to file,
   * so the last modified timestamp doesn't reflect that.
   * To prevent further conflicts in future syncs and to reflect the content change
   * on the remote metadata we update the timestamp for the conflicting files here,
   * just before pushing to remote.
   * This targets the snapshot (not live data) since it feeds the manifest content.
   */
  private stampResolvedConflictTimes(
    snapshot: { [key: string]: FileMetadata },
    conflictResolutions: ConflictResolution[],
    syncTime: number,
  ) {
    conflictResolutions
      .filter((resolution) => this.shouldApplyConflictContent(resolution))
      .forEach((resolution) => {
        snapshot[resolution.filePath].lastModified = syncTime;
      });
  }

  private recordSnapshotSha(
    snapshot: { [key: string]: FileMetadata },
    filePath: string,
    sha: string,
    syncTime: number,
  ) {
    if (snapshot[filePath]) {
      snapshot[filePath].sha = sha;
      return;
    }
    snapshot[filePath] = {
      path: filePath,
      sha,
      dirty: false,
      justDownloaded: false,
      lastModified: syncTime,
      deleted: false,
    };
  }

  /**
   * We want the remote metadata file to track the correct SHA for each file blob,
   * so just before we upload any file we update all their SHAs in the metadata file.
   * This also makes it easier to handle conflicts.
   * We don't save the metadata file after setting the SHAs cause we do that when
   * the sync is fully commited at the end.
   * TODO: Understand whether it's a problem we don't revert the SHA setting in case of sync failure
   *
   * Binary blobs are uploaded here too: uploading returns their SHA, and the new tree
   * needs those SHAs to be created.
   */
  private async attachShasToTreeFiles(
    treeFiles: { [key: string]: NewTreeRequestItem },
    snapshot: { [key: string]: FileMetadata },
    syncTime: number,
  ) {
    await Promise.all(
      Object.keys(treeFiles)
        .filter((filePath: string) => treeFiles[filePath].content)
        .map(async (filePath: string) => {
          // I don't fully trust file extensions as they're not completely reliable
          // to determine the file type, though I feel it's ok to compromise and rely
          // on them if it makes the plugin handle upload better on certain devices.
          if (hasTextExtension(filePath)) {
            const sha = await this.calculateSHAFromString(treeFiles[filePath].content as string);
            this.recordSnapshotSha(snapshot, filePath, sha, syncTime);
            return;
          }

          const sha = await this.uploadBinaryBlob(filePath);
          treeFiles[filePath].sha = sha;
          // Can't have both sha and content set, so we delete it
          delete treeFiles[filePath].content;
          this.recordSnapshotSha(snapshot, filePath, sha, syncTime);
        }),
    );
  }

  // We can't upload binary files by setting the content of a tree item,
  // we first need to create a Git blob by uploading the file, then
  // we must update the tree item to point the SHA to the blob we just created.
  private async uploadBinaryBlob(filePath: string): Promise<string> {
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
    return sha;
  }

  // Built from the snapshot (not live metadataStore.data) so a concurrent vault event
  // mutating live data mid-sync can never leak a file reference into the manifest
  // without a matching tree item.
  private writeMetadataIntoTree(
    treeFiles: { [key: string]: NewTreeRequestItem },
    snapshot: { [key: string]: FileMetadata },
  ) {
    const metadataItem = treeFiles[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`];
    delete metadataItem.sha;
    metadataItem.content = JSON.stringify({
      lastSync: this.metadataStore.data.lastSync,
      files: snapshot,
    });
  }

  private async pushCommit(
    treeFiles: { [key: string]: NewTreeRequestItem },
    baseTreeSha: string,
    baseCommitSha?: string,
  ) {
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

    const branchHeadSha = baseCommitSha ?? await this.client.getBranchHeadSha({ retry: true });
    const message = SyncManager.buildCommitMessage(getCommitMessageTemplate());
    const commitSha = await this.client.createCommit({
      message,
      treeSha: newTreeSha,
      parent: branchHeadSha,
    });

    await this.client.updateBranchHead({ sha: commitSha, retry: true });
  }

  private mergeCommittedSnapshotIntoLive(
    committed: { [key: string]: FileMetadata },
    captured: { [key: string]: FileMetadata },
  ) {
    for (const [path, committedFile] of Object.entries(committed)) {
      const capturedFile = captured[path];
      const liveFile = this.metadataStore.data.files[path];
      if (!capturedFile) {
        if (!liveFile) this.metadataStore.data.files[path] = committedFile;
        continue;
      }
      if (!liveFile || this.sameMetadataRevision(liveFile, capturedFile)) {
        this.metadataStore.data.files[path] = committedFile;
      }
    }
  }

  // Update the local content of all files that had conflicts we resolved.
  private async applyResolvedConflictContent(
    conflictResolutions: ConflictResolution[],
    syncTime: number,
  ) {
    await Promise.all(
      conflictResolutions
        .filter((resolution) => this.shouldApplyConflictContent(resolution))
        .map(async (resolution) => {
          const writePath = normalizePath(
            this.metadataStore.data.files[resolution.filePath]?.localPath
              ?? sanitizePathForLocalFilesystem(resolution.filePath),
          );
          try {
            await this.writeConflictResolution(writePath, resolution);
          } catch (err) {
            throw new Error(
              `Remote commit may already exist; failed to write conflict resolution for ${resolution.filePath}: ${errorMessage(err)}`,
              { cause: err },
            );
          }
          // Even though we set the last modified timestamp for all files with conflicts
          // just before pushing the changes to remote we do it here again because the
          // write right above would overwrite that.
          // Since we want to keep the sync timestamp for this file to avoid future conflicts
          // we update it again.
          this.metadataStore.data.files[resolution.filePath].lastModified = syncTime;
        }),
    );
  }

  /**
   * Obsidian mobile may rewrite community-plugins.json without desktop-only plugin ids.
   * Returns the local list with those ids restored from the remote list, or null when
   * nothing has to change.
   */
  private async preserveDesktopOnlyIds(localText: string, remoteText: string): Promise<string | null> {
    const parseIds = (text: string): string[] | null => {
      try {
        const value: unknown = JSON.parse(text);
        return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : null;
      } catch {
        return null;
      }
    };
    const localIds = parseIds(localText);
    const remoteIds = parseIds(remoteText);
    if (!localIds || !remoteIds) return null;
    const missing: string[] = [];
    for (const id of remoteIds) {
      if (localIds.includes(id)) continue;
      const manifestPath = `${this.vault.configDir}/plugins/${id}/manifest.json`;
      try {
        const manifest = JSON.parse(await this.vault.adapter.read(manifestPath)) as { isDesktopOnly?: boolean };
        if (manifest.isDesktopOnly === true) missing.push(id);
      } catch (error) {
        await this.logger.error("Could not inspect community plugin manifest", {
          path: manifestPath,
          error: serializeError(error),
        });
      }
    }
    if (missing.length === 0) return null;
    return `${JSON.stringify([...localIds, ...missing], null, 2)}\n`;
  }

  private sameMetadataRevision(left: FileMetadata, right: FileMetadata): boolean {
    return JSON.stringify({
      path: left.path,
      localPath: left.localPath,
      sha: left.sha,
      dirty: left.dirty,
      justDownloaded: left.justDownloaded,
      lastModified: left.lastModified,
      deleted: left.deleted,
      deletedAt: left.deletedAt,
    }) === JSON.stringify({
      path: right.path,
      localPath: right.localPath,
      sha: right.sha,
      dirty: right.dirty,
      justDownloaded: right.justDownloaded,
      lastModified: right.lastModified,
      deleted: right.deleted,
      deletedAt: right.deletedAt,
    });
  }

  private shouldApplyConflictContent(resolution: ConflictResolution): boolean {
    return resolution.pluginUninstallChoice !== "accept-uninstall";
  }

  private async prepareConflictDestinations(conflictResolutions: ConflictResolution[]): Promise<void> {
    await Promise.all(
      conflictResolutions
        .filter((resolution) => this.shouldApplyConflictContent(resolution))
        .map((resolution) => {
          const filePath = this.metadataStore.data.files[resolution.filePath]?.localPath
            ?? sanitizePathForLocalFilesystem(resolution.filePath);
          return ensureParentDirectory(this.vault.adapter, filePath);
        }),
    );
  }

  private async writeConflictResolution(writePath: string, resolution: ConflictResolution): Promise<void> {
    await withParentDirectoryRetry(
      this.vault.adapter,
      writePath,
      () => this.vault.adapter.write(writePath, resolution.content),
    );
  }

  async downloadFile(
    file: GetTreeResponseItem,
    lastModified: number,
    remoteMetadata?: FileMetadata,
  ): Promise<FileMetadata> {
    const fileMetadata = this.metadataStore.data.files[file.path];
    if (fileMetadata && fileMetadata.sha === file.sha && fileMetadata.deleted !== true) {
      const existingPath = normalizePath(
        fileMetadata.localPath ?? sanitizePathForLocalFilesystem(file.path),
      );
      if (!(await isPathMissing(this.vault.adapter, existingPath))) {
        let existingStat;
        try {
          existingStat = await this.vault.adapter.stat(existingPath);
        } catch (cause) {
          throw new Error(`Failed to inspect download path ${existingPath}: ${errorMessage(cause)}`, { cause });
        }
        if (existingStat?.type === "folder") {
          throw new Error(`Expected a file at ${existingPath}, but found a directory`);
        }
        if (existingStat?.type === "file") {
          const acceptedMetadata = {
            ...fileMetadata,
            path: file.path,
            sha: file.sha,
            dirty: false,
            lastModified: remoteMetadata?.lastModified ?? lastModified,
          };
          delete acceptedMetadata.deleted;
          delete acceptedMetadata.deletedAt;
          return acceptedMetadata;
        }
      }
    }
    const sanitizedPath = normalizePath(sanitizePathForLocalFilesystem(file.path));
    const localPath = normalizePath(fileMetadata?.localPath ?? sanitizedPath);
    await ensureParentDirectory(this.vault.adapter, localPath);
    const blob = await this.client.getBlob({ sha: file.sha, retry: true });
    try {
      const originalBytes = base64ToArrayBuffer(blob.content);
      await withParentDirectoryRetry(
        this.vault.adapter,
        localPath,
        () => this.vault.adapter.writeBinary(localPath, originalBytes),
      );
    } catch (err) {
      throw new Error(
        `Failed to write file ${localPath}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const localPathDiffers = localPath !== normalizePath(file.path);
    const downloadedMetadata: FileMetadata = {
      path: file.path,
      sha: file.sha,
      dirty: false,
      justDownloaded: true,
      lastModified,
      ...(localPathDiffers ? { localPath } : {}),
    };
    this.metadataStore.data.files[file.path] = downloadedMetadata;
    await this.metadataStore.save();
    return { ...downloadedMetadata };
  }

  async deleteLocalFile(filePath: string, incomingTombstone?: FileMetadata) {
    const localPath = this.metadataStore.data.files[filePath]?.localPath ?? normalizePath(filePath);
    if (await this.vault.adapter.exists(localPath)) {
      try {
        await this.vault.adapter.remove(localPath);
      } catch (err) {
        throw new Error(
          `Failed to delete file ${localPath}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    } else {
      // Already gone (e.g. removed by an earlier interrupted sync, or manually
      // deleted). Goal state is achieved; don't fail the whole sync over it.
      await this.logger.warn(
        "Delete-local skipped: file already absent on disk",
        filePath,
      );
    }
    let deletedMetadata = this.metadataStore.data.files[filePath];
    if (!deletedMetadata && incomingTombstone) {
      deletedMetadata = { ...incomingTombstone };
      this.metadataStore.data.files[filePath] = deletedMetadata;
    }
    if (deletedMetadata) {
      if (incomingTombstone) Object.assign(deletedMetadata, incomingTombstone);
      deletedMetadata.path = filePath;
      deletedMetadata.deleted = true;
      deletedMetadata.deletedAt = incomingTombstone?.deletedAt ?? Date.now();
    }
    await this.metadataStore.save();
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
      await this.metadataStore.save();
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
    await this.metadataStore.save();
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
    await this.metadataStore.save();
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
