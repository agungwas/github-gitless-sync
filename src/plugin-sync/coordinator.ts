import { Vault } from "obsidian";
import MetadataStore from "../metadata-store";
import Logger, { serializeError } from "../logger";
import { GitHubSyncSettings } from "../settings/settings";
import { PluginLifecycleReconciler } from "./reconciler";
import { PluginManagerRuntime, PluginRuntimeBridge } from "./runtime-bridge";

const LOCAL_REMOVAL_SCAN_INTERVAL_MS = 15_000;

export interface PluginSyncCoordinatorOptions {
  vault: Vault;
  metadataStore: MetadataStore;
  settings: GitHubSyncSettings;
  logger: Logger;
  selfPluginId: string;
  pluginManager?: PluginManagerRuntime;
  isCustomPlugin: (id: string) => boolean;
}

export class PluginSyncCoordinator {
  private currentReconciler: PluginLifecycleReconciler | null = null;
  private stopObservingMutations: (() => void) | null = null;
  private removalScanTimer: number | null = null;

  constructor(private readonly options: PluginSyncCoordinatorOptions) {}

  get reconciler(): PluginLifecycleReconciler | null {
    return this.currentReconciler;
  }

  configure(): void {
    this.disposeRuntime();
    const { pluginManager, settings } = this.options;
    if (!pluginManager || !settings.syncCommunityPlugins) return;

    const reconciler = new PluginLifecycleReconciler(
      this.options.vault,
      this.options.metadataStore,
      new PluginRuntimeBridge(pluginManager, this.options.selfPluginId),
      this.options.selfPluginId,
      this.options.logger,
      undefined,
      this.options.isCustomPlugin,
    );
    this.currentReconciler = reconciler;
    this.stopObservingMutations = reconciler.startObservingNativeMutations();
    this.removalScanTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void reconciler.observeLocalRemovals().catch((error) => this.options.logger.error("Community plugin scan failed", {
        error: serializeError(error),
      }));
    }, LOCAL_REMOVAL_SCAN_INTERVAL_MS);
  }

  stop(): void {
    this.disposeRuntime();
  }

  private disposeRuntime(): void {
    this.stopObservingMutations?.();
    this.stopObservingMutations = null;
    if (this.removalScanTimer !== null) window.clearInterval(this.removalScanTimer);
    this.removalScanTimer = null;
    this.currentReconciler = null;
  }
}
