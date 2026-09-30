import { IconName, ItemView, Menu, Platform, WorkspaceLeaf } from "obsidian";
import { Root, createRoot } from "react-dom/client";
import GitHubSyncPlugin from "src/main";
import { ConflictFile, ConflictResolution } from "src/sync-manager";
import SplitView from "./split-view/split-view";
import UnifiedView from "./unified-view/unified-view";

export const CONFLICTS_RESOLUTION_VIEW_TYPE = "conflicts-resolution-view";

export class ConflictsResolutionView extends ItemView {
  icon: IconName = "merge";
  private root: Root | null = null;
  private renderKey: number = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: GitHubSyncPlugin,
    private conflicts: ConflictFile[],
  ) {
    super(leaf);
  }

  getViewType() {
    return CONFLICTS_RESOLUTION_VIEW_TYPE;
  }

  getDisplayText() {
    return "Conflicts resolution";
  }

  private onFileResolved(resolution: ConflictResolution) {
    this.plugin.recordResolvedConflict(resolution);
  }

  // The user confirmed the resolutions (or the countdown ended). Hand them to
  // the sync and close the tab, there's nothing left to do here.
  private onConfirm() {
    if (!this.plugin.finalizeConflicts()) {
      // Nobody was waiting for the resolutions, don't hide them by closing.
      return;
    }
    // Closing is deferred so we don't unmount React while it's still
    // running one of its own event handlers.
    setTimeout(() => this.leaf.detach(), 0);
  }

  private onReset() {
    this.plugin.resetConflicts();
    this.setConflictFiles(this.plugin.getConflicts());
  }

  setConflictFiles(conflicts: ConflictFile[]) {
    this.conflicts = conflicts;
    // Bump the key so React fully remounts the view component,
    // resetting its internal state (resolved files list, etc.).
    this.renderKey++;
    this.render(conflicts);
  }

  async onOpen() {
    this.render(this.conflicts);
  }

  private render(conflicts: ConflictFile[]) {
    if (!this.root) {
      // Hides the navigation header
      (this.containerEl.children[0] as HTMLElement).className =
        "hidden-navigation-header";
      const container = this.containerEl.children[1];
      container.empty();
      // We don't want any padding, the DiffView component will handle that
      (container as HTMLElement).className = "padless-conflicts-view-container";
      this.root = createRoot(container);
    }

    let diffMode = "default";
    if (this.plugin.settings.conflictViewMode === "default") {
      if (Platform.isMobile) {
        diffMode = "unified";
      } else {
        diffMode = "split";
      }
    } else if (this.plugin.settings.conflictViewMode === "split") {
      diffMode = "split";
    } else if (this.plugin.settings.conflictViewMode === "unified") {
      diffMode = "unified";
    }

    // Conflicts resolved before the view was closed are not shown again
    const unresolved = conflicts.filter(
      (conflict) => !this.plugin.resolvedConflicts.has(conflict.filePath),
    );
    const props = {
      initialFiles: unresolved,
      totalCount: conflicts.length,
      autoCloseDelay: this.plugin.settings.conflictsAutoCloseDelay,
      onFileResolved: this.onFileResolved.bind(this),
      onConfirm: this.onConfirm.bind(this),
      onReset: this.onReset.bind(this),
    };

    if (diffMode === "split") {
      this.root.render(<SplitView key={this.renderKey} {...props} />);
    } else {
      this.root.render(<UnifiedView key={this.renderKey} {...props} />);
    }
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;

    if (this.plugin.isUnloading) {
      return;
    }
    if (this.plugin.allConflictsResolved()) {
      // Everything is resolved and only the confirmation was missing,
      // closing the tab counts as confirming.
      this.plugin.finalizeConflicts();
    } else if (this.plugin.hasPendingConflicts()) {
      // The sync is blocked until the conflicts are resolved
      this.plugin.showPendingConflictsNotice();
    }
  }
}
