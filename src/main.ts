import {
  EventRef,
  Plugin,
  WorkspaceLeaf,
  normalizePath,
  Notice,
  TextFileView,
} from "obsidian";
import { GitHubSyncSettings, DEFAULT_SETTINGS } from "./settings/settings";
import GitHubSyncSettingsTab from "./settings/tab";
import SyncManager, { ConflictFile, ConflictResolution } from "./sync-manager";
import Logger from "./logger";
import {
  ConflictsResolutionView,
  CONFLICTS_RESOLUTION_VIEW_TYPE,
} from "./views/conflicts-resolution/view";

export default class GitHubSyncPlugin extends Plugin {
  settings: GitHubSyncSettings;
  syncManager: SyncManager;
  logger: Logger;

  statusBarItem: HTMLElement | null = null;
  syncRibbonIcon: HTMLElement | null = null;
  conflictsRibbonIcon: HTMLElement | null = null;

  activeLeafChangeListener: EventRef | null = null;
  vaultCreateListener: EventRef | null = null;
  vaultModifyListener: EventRef | null = null;

  // Called in ConflictResolutionView when the user solves all the conflicts.
  // This is initialized every time we open the view to set new conflicts so
  // we can notify the SyncManager that everything has been resolved and the sync
  // process can continue on.
  conflictsResolver: ((resolutions: ConflictResolution[]) => void) | null =
    null;

  // We keep track of the sync conflicts in here too in case the
  // conflicts view must be rebuilt, or the user closes the view
  // and it gets destroyed.
  // By keeping them here we can recreate it easily.
  private conflicts: ConflictFile[] = [];

  // Pristine copy of the conflicts as they were found by the sync. The views
  // edit the ConflictFile objects in place, so this is what "reset" restores.
  private originalConflicts: ConflictFile[] = [];

  // Conflicts the user already resolved but that were not yet handed to the
  // SyncManager. Kept here so closing the view doesn't lose the progress.
  resolvedConflicts: Map<string, ConflictResolution> = new Map();

  // Shown when the conflicts view is closed with conflicts still pending.
  private pendingConflictsNotice: Notice | null = null;

  // Set while the plugin is being unloaded so closing the view then
  // doesn't trigger any user facing behavior.
  isUnloading = false;

  async onUserEnable() {
    if (
      this.settings.githubToken === "" ||
      this.settings.githubOwner === "" ||
      this.settings.githubRepo === "" ||
      this.settings.githubBranch === ""
    ) {
      new Notice("Go to settings to configure syncing");
    }
  }

  getConflictsView(): ConflictsResolutionView | null {
    const leaves = this.app.workspace.getLeavesOfType(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
    );
    if (leaves.length === 0) {
      return null;
    }
    return leaves[0].view as ConflictsResolutionView;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(CONFLICTS_RESOLUTION_VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      // Always use a dedicated tab, never replace the one the user is on.
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({
        type: CONFLICTS_RESOLUTION_VIEW_TYPE,
        active: true,
      });
    }
    workspace.revealLeaf(leaf);
  }

  async onload() {
    await this.loadSettings();

    this.logger = new Logger(this.app.vault, this.settings.enableLogging);
    this.logger.init();

    this.registerView(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
      (leaf) => new ConflictsResolutionView(leaf, this, this.conflicts),
    );

    this.addSettingTab(new GitHubSyncSettingsTab(this.app, this));

    this.syncManager = new SyncManager(
      this.app.vault,
      this.settings,
      this.onConflicts.bind(this),
      this.logger,
    );
    await this.syncManager.loadMetadata();

    if (this.settings.syncStrategy == "interval") {
      this.restartSyncInterval();
    }

    this.app.workspace.onLayoutReady(async () => {
      // Create the events handling only after tha layout is ready to avoid
      // getting spammed with create events.
      // See the official Obsidian docs:
      // https://docs.obsidian.md/Reference/TypeScript+API/Vault/on('create')
      this.syncManager.startEventsListener(this);

      // Load the ribbons after layout is ready so they're shown after the core
      // buttons
      if (this.settings.showStatusBarItem) {
        this.showStatusBarItem();
      }

      if (this.settings.showConflictsRibbonButton) {
        this.showConflictsRibbonIcon();
      }

      if (this.settings.showSyncRibbonButton) {
        this.showSyncRibbonIcon();
      }
    });

    this.addCommand({
      id: "sync-files",
      name: "Sync with GitHub",
      repeatable: false,
      icon: "refresh-cw",
      callback: this.sync.bind(this),
    });

    this.addCommand({
      id: "merge",
      name: "Open sync conflicts view",
      repeatable: false,
      icon: "refresh-cw",
      callback: this.openConflictsView.bind(this),
    });

    this.registerDomEvent(window, "focus", () => {
      if (this.settings.syncOnWindowFocus) {
        this.sync();
      }
    });

    this.registerDomEvent(window, "blur", () => {
      if (this.settings.syncOnWindowBlur) {
        this.sync();
      }
    });

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible" && this.settings.syncOnWindowFocus) {
        this.sync();
      } else if (document.visibilityState === "hidden" && this.settings.syncOnWindowBlur) {
        this.sync();
      }
    });
  }

  async sync() {
    // Force all open text editors to flush their in-memory changes to disk
    // This is critical on mobile where file writes are delayed, otherwise we upload stale data
    const savePromises: Promise<void>[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof TextFileView) {
        savePromises.push(leaf.view.save());
      }
    });
    await Promise.all(savePromises);

    if (
      this.settings.githubToken === "" ||
      this.settings.githubOwner === "" ||
      this.settings.githubRepo === "" ||
      this.settings.githubBranch === ""
    ) {
      new Notice("Sync plugin not configured");
      return;
    }
    if (this.settings.firstSync) {
      const notice = new Notice("Syncing...");
      try {
        await this.syncManager.firstSync();
        this.settings.firstSync = false;
        this.saveSettings();
        // Shown only if sync doesn't fail
        new Notice("Sync successful", 5000);
      } catch (err) {
        // Show the error to the user, it's not automatically dismissed to make sure
        // the user sees it.
        new Notice(`Error syncing. ${err}`);
      }
      notice.hide();
    } else {
      await this.syncManager.sync();
    }
    this.updateStatusBarItem();
  }

  async onunload() {
    this.isUnloading = true;
    this.hidePendingConflictsNotice();
    this.stopSyncInterval();
  }

  showStatusBarItem() {
    if (this.statusBarItem) {
      return;
    }
    this.statusBarItem = this.addStatusBarItem();

    if (!this.activeLeafChangeListener) {
      this.activeLeafChangeListener = this.app.workspace.on(
        "active-leaf-change",
        () => this.updateStatusBarItem(),
      );
    }
    if (!this.vaultCreateListener) {
      this.vaultCreateListener = this.app.vault.on("create", () => {
        this.updateStatusBarItem();
      });
    }
    if (!this.vaultModifyListener) {
      this.vaultModifyListener = this.app.vault.on("modify", () => {
        this.updateStatusBarItem();
      });
    }
  }

  hideStatusBarItem() {
    this.statusBarItem?.remove();
    this.statusBarItem = null;
  }

  updateStatusBarItem() {
    if (!this.statusBarItem) {
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      return;
    }

    let state = "Unknown";
    const fileData = this.syncManager.getFileMetadata(activeFile.path);
    if (!fileData) {
      state = "Untracked";
    } else if (fileData.dirty) {
      state = "Outdated";
    } else if (!fileData.dirty) {
      state = "Up to date";
    }

    this.statusBarItem.setText(`GitHub: ${state}`);
  }

  showSyncRibbonIcon() {
    if (this.syncRibbonIcon) {
      return;
    }
    this.syncRibbonIcon = this.addRibbonIcon(
      "refresh-cw",
      "Sync with GitHub",
      this.sync.bind(this),
    );
  }

  hideSyncRibbonIcon() {
    this.syncRibbonIcon?.remove();
    this.syncRibbonIcon = null;
  }

  showConflictsRibbonIcon() {
    if (this.conflictsRibbonIcon) {
      return;
    }
    this.conflictsRibbonIcon = this.addRibbonIcon(
      "merge",
      "Open sync conflicts view",
      this.openConflictsView.bind(this),
    );
  }

  hideConflictsRibbonIcon() {
    this.conflictsRibbonIcon?.remove();
    this.conflictsRibbonIcon = null;
  }

  clearConflicts() {
    this.conflicts = [];
    this.originalConflicts = [];
    this.resolvedConflicts.clear();
    this.hidePendingConflictsNotice();
  }

  getConflicts(): ConflictFile[] {
    return this.conflicts;
  }

  private cloneConflicts(conflicts: ConflictFile[]): ConflictFile[] {
    return conflicts.map((conflict) => ({ ...conflict }));
  }

  // Sync is still waiting on the user to resolve conflicts.
  hasPendingConflicts(): boolean {
    return this.conflictsResolver !== null;
  }

  // Every conflict has a resolution but the user hasn't confirmed them yet,
  // so the SyncManager is still waiting.
  allConflictsResolved(): boolean {
    return (
      this.hasPendingConflicts() &&
      this.conflicts.length > 0 &&
      this.conflicts.every((conflict) =>
        this.resolvedConflicts.has(conflict.filePath),
      )
    );
  }

  recordResolvedConflict(resolution: ConflictResolution) {
    this.resolvedConflicts.set(resolution.filePath, resolution);
  }

  // Brings every conflict back to how it was found, discarding both the
  // resolutions and any edit made to the files. Sync stays paused.
  resetConflicts() {
    this.conflicts = this.cloneConflicts(this.originalConflicts);
    this.resolvedConflicts.clear();
    this.hidePendingConflictsNotice();
  }

  // Hands the resolutions to the SyncManager so the sync can continue.
  // Returns false if there was nothing waiting for them.
  finalizeConflicts(): boolean {
    const resolver = this.conflictsResolver;
    if (!resolver) {
      return false;
    }
    const resolutions = Array.from(this.resolvedConflicts.values());
    this.conflictsResolver = null;
    // Clear the stored conflicts so that re-opening the view doesn't
    // replay the already-resolved conflicts as unresolved.
    this.clearConflicts();
    resolver(resolutions);
    return true;
  }

  hidePendingConflictsNotice() {
    this.pendingConflictsNotice?.hide();
    this.pendingConflictsNotice = null;
  }

  // Called when the conflicts view gets closed. The sync is blocked until the
  // conflicts are resolved, so let the user know and offer a way back.
  showPendingConflictsNotice() {
    this.hidePendingConflictsNotice();

    const fragment = document.createDocumentFragment();
    const message = document.createElement("div");
    message.textContent = "Sync is paused, conflicts are still unresolved.";
    fragment.appendChild(message);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "var(--size-4-2)";
    actions.style.marginTop = "var(--size-4-2)";

    const resumeButton = document.createElement("button");
    resumeButton.textContent = "Resume";
    resumeButton.addEventListener("click", () => {
      this.hidePendingConflictsNotice();
      this.openConflictsView();
    });
    actions.appendChild(resumeButton);

    const resetButton = document.createElement("button");
    resetButton.textContent = "Reset";
    resetButton.addEventListener("click", () => {
      // Sync stays paused, the conflicts are just back to their initial state
      this.resetConflicts();
    });
    actions.appendChild(resetButton);
    fragment.appendChild(actions);

    // A duration of 0 keeps the notice until the user dismisses it
    this.pendingConflictsNotice = new Notice(fragment, 0);
  }

  async openConflictsView() {
    this.hidePendingConflictsNotice();
    await this.activateView();
    this.getConflictsView()?.setConflictFiles(this.conflicts);
  }

  async onConflicts(conflicts: ConflictFile[]): Promise<ConflictResolution[]> {
    this.conflicts = conflicts;
    this.originalConflicts = this.cloneConflicts(conflicts);
    this.resolvedConflicts.clear();
    this.hidePendingConflictsNotice();
    return await new Promise(async (resolve) => {
      this.conflictsResolver = resolve;
      await this.activateView();
      this.getConflictsView()?.setConflictFiles(conflicts);
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Proxy methods from sync manager to ease handling the interval
  // when settings are changed
  startSyncInterval() {
    const intervalID = this.syncManager.startSyncInterval(
      this.settings.syncInterval,
    );
    this.registerInterval(intervalID);
  }

  stopSyncInterval() {
    this.syncManager.stopSyncInterval();
  }

  restartSyncInterval() {
    this.syncManager.stopSyncInterval();
    this.syncManager.startSyncInterval(this.settings.syncInterval);
  }

  async reset() {
    this.settings = DEFAULT_SETTINGS;
    this.saveSettings();
    await this.syncManager.resetMetadata();
  }
}
