import { Platform, PluginManifest, Vault, requireApiVersion } from "obsidian";
import MetadataStore from "../metadata-store";
import Logger, { formatError, serializeError } from "../logger";
import { OfficialPackageSource } from "./package-source";
import { NativePluginMutation, PluginRuntimeBridge } from "./runtime-bridge";
import { PluginPackageInstaller } from "./installer";
import { PluginMutationChangedError, withStableMutation } from "./mutation-guard";
import { validId } from "./plugin-id";
import { PluginSyncReporter } from "./reporter";

export interface PluginSyncReport {
  installed: string[];
  updated: string[];
  uninstalled: string[];
  enabled: string[];
  disabled: string[];
  runtimeFailures: string[];
  skipped: string[];
  failed: string[];
}

const EMPTY_REPORT = (): PluginSyncReport => ({
  installed: [], updated: [], uninstalled: [], enabled: [], disabled: [], runtimeFailures: [], skipped: [], failed: [],
});

function isCompatible(manifest: PluginManifest): string | null {
  if (Platform.isMobile && manifest.isDesktopOnly) return "desktop-only plugin";
  if (manifest.minAppVersion && !requireApiVersion(manifest.minAppVersion)) return `requires Obsidian ${manifest.minAppVersion}`;
  return null;
}

export class PluginLifecycleReconciler {
  private readonly configDir: string;
  private readonly pluginRoot: string;
  private readonly stagingRoot: string;
  private knownLocalIds = new Set<string>();
  private absenceScans = new Map<string, number>();
  private readonly pendingHydrate = new Set<string>();
  private readonly reporter: PluginSyncReporter;
  private readonly installer: PluginPackageInstaller;

  constructor(
    private readonly vault: Vault,
    private readonly metadataStore: MetadataStore,
    private readonly runtime: PluginRuntimeBridge,
    private readonly selfPluginId: string,
    private readonly logger: Logger,
    private readonly source = new OfficialPackageSource(),
    private readonly isCustomPlugin: (id: string) => boolean = () => false,
  ) {
    this.configDir = vault.configDir;
    this.pluginRoot = `${this.configDir}/plugins`;
    this.stagingRoot = `${this.configDir}/.gitless-plugin-staging`;
    this.reporter = new PluginSyncReporter(logger);
    this.installer = new PluginPackageInstaller(vault, runtime, this.stagingRoot, logger);
  }

  startObservingNativeMutations(): () => void {
    return this.runtime.observeNativeMutations((event) => {
      void this.handleNativeMutation(event).catch(async (error) => {
        await this.logger.error("Native community plugin change could not be recorded", {
          id: event.id,
          kind: event.kind,
          error: serializeError(error),
        });
      });
    });
  }

  private async handleNativeMutation(event: NativePluginMutation): Promise<void> {
    if (!validId(event.id) || event.id === this.selfPluginId) return;
    if (event.kind === "enable" || event.kind === "disable") return;
    if (event.kind === "install") return;
    const folder = `${this.pluginRoot}/${event.id}`;
    if (await this.vault.adapter.exists(`${folder}/manifest.json`) || await this.vault.adapter.exists(`${folder}/main.js`)) {
      throw new Error("Uninstall did not leave package directory absent; removal held for retry");
    }
    await this.recordExplicitUninstall(event.id);
  }

  private async recordExplicitUninstall(id: string): Promise<void> {
    if (!validId(id) || id === this.selfPluginId) throw new Error("Protected or invalid plugin ID");
    const folder = `${this.pluginRoot}/${id}`;
    if (await this.vault.adapter.exists(`${folder}/manifest.json`) || await this.vault.adapter.exists(`${folder}/main.js`)) {
      throw new Error("Plugin package is still present");
    }
    const manifestPath = `${folder}/manifest.json`;
    const metadata = this.metadataStore.data.files[manifestPath];
    if (!metadata?.sha) throw new Error("Uninstall has no acknowledged manifest baseline");
    const deletedAt = Date.now();
    metadata.deleted = true;
    metadata.deletedAt = deletedAt;
    const settings = this.metadataStore.data.files[`${folder}/data.json`];
    if (settings) {
      settings.deleted = true;
      settings.deletedAt = deletedAt;
    }
    await this.metadataStore.save();
  }

  async observeLocalRemovals(): Promise<void> {
    const report = EMPTY_REPORT();
    let listing: Awaited<ReturnType<typeof this.vault.adapter.list>>;
    try {
      listing = await this.vault.adapter.list(this.pluginRoot);
    } catch (error) {
      await this.logger.error("Community plugin removal scan could not list plugin directory", {
        path: this.pluginRoot,
        error: serializeError(error),
      });
      return;
    }
    const currentIds = new Set(listing.folders.map((folder) => folder.slice(this.pluginRoot.length + 1)).filter(validId));
    const enabledPath = `${this.configDir}/community-plugins.json`;
    let enabledText: string;
    try {
      enabledText = await this.vault.adapter.read(enabledPath);
    } catch (error) {
      await this.logger.error("Community plugin removal scan could not read enabled plugin list", {
        path: enabledPath,
        error: serializeError(error),
      });
      return;
    }
    let enabled: Set<string>;
    try {
      const value: unknown = JSON.parse(enabledText);
      if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
        throw new Error("invalid enabled-plugin list");
      }
      enabled = new Set(value);
    } catch (error) {
      await this.logger.error("Community plugin removal scan could not parse enabled plugin list", {
        path: enabledPath,
        error: serializeError(error),
      });
      return;
    }
    for (const id of currentIds) {
      this.knownLocalIds.add(id);
      this.absenceScans.delete(id);
    }
    for (const id of this.knownLocalIds) {
      if (currentIds.has(id) || enabled.has(id) || this.runtime.isLoaded(id) || this.runtime.isMutating(id)) {
        this.absenceScans.delete(id);
        continue;
      }
      const mutationVersion = this.runtime.mutationVersion(id);
      const scans = (this.absenceScans.get(id) ?? 0) + 1;
      this.absenceScans.set(id, scans);
      if (scans < 2) continue;
      try {
        const completed = await withStableMutation(this.runtime, id, mutationVersion, () => this.recordExplicitUninstall(id));
        if (!completed) {
          this.absenceScans.delete(id);
          report.skipped.push(`${id}: native package changed during removal scan`);
          continue;
        }
        this.knownLocalIds.delete(id);
        this.absenceScans.delete(id);
        report.uninstalled.push(id);
      } catch (error) {
        report.failed.push(`${id}: uninstall evidence unavailable at ${this.pluginRoot}/${id}/manifest.json: ${formatError(error)}`);
      }
    }
    if (report.uninstalled.length) await this.metadataStore.save();
    await this.reporter.log("removal-scan", report);
  }

  private async readEnabledIds(): Promise<Set<string>> {
    const path = `${this.configDir}/community-plugins.json`;
    try {
      const value: unknown = JSON.parse(await this.vault.adapter.read(path));
      if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new Error("invalid enabled-plugin list");
      return new Set(value);
    } catch (cause) {
      throw new Error(`Failed to read enabled plugin list at ${path}`, { cause });
    }
  }

  private async updateSavedStateIfUnchanged(id: string, wasEnabled: boolean, desiredEnabled: boolean): Promise<void> {
    const currentIds = await this.readEnabledIds();
    const currentSaved = this.runtime.savedEnabledIds();
    if (!currentSaved) throw new Error("Obsidian enabled plugin state unavailable");
    if (currentIds.has(id) !== desiredEnabled || currentSaved.has(id) !== wasEnabled) {
      throw new PluginMutationChangedError(`Plugin state changed during reconciliation: ${id}`);
    }
    this.runtime.setSavedEnabled(id, desiredEnabled);
  }

  private async synchronizeSavedEnabledState(
    desiredIds: ReadonlySet<string>,
    savedIds: ReadonlySet<string>,
    report: PluginSyncReport,
  ): Promise<boolean> {
    let changed = false;
    for (const id of new Set([...savedIds, ...desiredIds])) {
      const wasEnabled = savedIds.has(id);
      const desiredEnabled = desiredIds.has(id);
      if (id === this.selfPluginId || wasEnabled === desiredEnabled) continue;
      const version = this.runtime.mutationVersion(id);
      if (this.runtime.isMutating(id)) {
        report.skipped.push(`${id}: native package mutation in progress`);
        continue;
      }
      try {
        const completed = await withStableMutation(this.runtime, id, version, async () => {
          await this.updateSavedStateIfUnchanged(id, wasEnabled, desiredEnabled);
          changed = true;
        });
        if (!completed) report.skipped.push(`${id}: plugin state changed during reconciliation`);
      } catch (error) {
        report.failed.push(`${id}: saved state update failed: ${formatError(error)}`);
      }
    }
    return changed;
  }

  async reconcile(completeSnapshot: boolean, hydrateIds: ReadonlySet<string>): Promise<PluginSyncReport> {
    const report = EMPTY_REPORT();
    await this.logger.info("Community plugin reconciliation started", { completeSnapshot });
    if (!completeSnapshot) {
      report.skipped.push("incomplete remote snapshot");
      await this.reporter.log("reconciliation", report);
      return report;
    }
    let enabledIds: Set<string>;
    try {
      enabledIds = await this.readEnabledIds();
    } catch (error) {
      report.failed.push(`${this.configDir}/community-plugins.json: enabled state unavailable: ${formatError(error)}`);
      await this.reporter.log("reconciliation", report);
      return report;
    }
    const savedEnabledIds = this.runtime.savedEnabledIds();
    if (!savedEnabledIds) {
      report.failed.push("Obsidian enabled plugin state unavailable");
      await this.reporter.log("reconciliation", report);
      return report;
    }
    let folders: Awaited<ReturnType<typeof this.vault.adapter.list>>;
    try {
      folders = await this.vault.adapter.list(this.pluginRoot);
    } catch (error) {
      report.failed.push(`${this.pluginRoot}: plugin directory unavailable: ${formatError(error)}`);
      await this.reporter.log("reconciliation", report);
      return report;
    }
    await this.installer.cleanupStaging();
    let restartRequired = await this.synchronizeSavedEnabledState(enabledIds, savedEnabledIds, report);
    for (const [manifestPath, metadata] of Object.entries(this.metadataStore.data.files)) {
      const manifestPrefix = `${this.pluginRoot}/`;
      const segments = manifestPath.startsWith(manifestPrefix) ? manifestPath.slice(manifestPrefix.length).split("/") : [];
      const id = segments.length === 2 && segments[1] === "manifest.json" ? segments[0] : undefined;
      if (
        !id || id === this.selfPluginId || !validId(id) || metadata.deleted !== true
      ) continue;
      const folder = `${this.pluginRoot}/${id}`;
      if (!(await this.vault.adapter.exists(folder))) continue;
      const mutationVersion = this.runtime.mutationVersion(id);
      if (this.runtime.isMutating(id)) {
        report.skipped.push(`${id}: native package mutation in progress`);
        continue;
      }
      try {
        const completed = await withStableMutation(this.runtime, id, mutationVersion, async () => {
          if (this.runtime.isLoaded(id)) await this.installer.unloadPlugin(id, report);
          await this.vault.adapter.rmdir(folder, true);
          this.pendingHydrate.delete(id);
          report.uninstalled.push(id);
        });
        if (!completed) report.skipped.push(`${id}: native package changed during reconciliation`);
      } catch (error) {
        report.failed.push(`${id}: uninstall failed at ${folder}: ${formatError(error)}`);
      }
    }

    for (const folder of folders.folders) {
      const id = folder.slice(this.pluginRoot.length + 1);
      if (!validId(id) || id === this.selfPluginId) continue;
      this.knownLocalIds.add(id);
      const mutationVersion = this.runtime.mutationVersion(id);
      if (this.runtime.isMutating(id)) {
        report.skipped.push(`${id}: native package mutation in progress`);
        continue;
      }
      const manifestPath = `${folder}/manifest.json`;
      try {
        if (!(await this.vault.adapter.exists(manifestPath))) continue;
        const manifestText = await this.vault.adapter.read(manifestPath);
        const manifest = JSON.parse(manifestText) as PluginManifest;
        if (manifest.id !== id || !manifest.version) throw new Error("plugin manifest ID/version invalid");
        const incompatible = isCompatible(manifest);
        if (incompatible) {
          report.skipped.push(`${id}: ${incompatible}`);
          continue;
        }
        const desiredEnabled = enabledIds.has(id);
        const loaded = this.runtime.isLoaded(id);
        if (this.isCustomPlugin(id)) {
          if (!(await this.vault.adapter.exists(`${folder}/main.js`))) {
            report.skipped.push(`${id}: custom package files unavailable`);
          }
          continue;
        }
        const mainPath = `${folder}/main.js`;
        const stylesPath = `${folder}/styles.css`;
        const hadMain = await this.vault.adapter.exists(mainPath);
        const needsHydration = hydrateIds.has(id) || !hadMain || this.pendingHydrate.has(id);
        let packageFiles: Awaited<ReturnType<OfficialPackageSource["resolve"]>> | null = null;
        if (needsHydration) {
          try {
            packageFiles = await this.resolvePackage(manifest);
          } catch (error) {
            this.pendingHydrate.add(id);
            const reason = formatError(error);
            if (reason.includes("not in the official registry")) report.skipped.push(`${id}: ${reason}`);
            else report.failed.push(`${id}: ${reason}`);
            continue;
          }
        }
        const completed = await withStableMutation(this.runtime, id, mutationVersion, async () => {
          if (packageFiles) {
            try {
              await this.installer.install(id, folder, manifestText, packageFiles, mainPath, stylesPath, report);
              await this.runtime.refreshManifests();
              this.pendingHydrate.delete(id);
            } catch (error) {
              this.pendingHydrate.add(id);
              throw error;
            }
          }
          const loadedAfterInstall = this.runtime.isLoaded(id);
          if (packageFiles && loaded && !loadedAfterInstall) {
            await this.installer.enablePlugin(id, report);
            report.enabled.push(id);
          }
          if (packageFiles && desiredEnabled && !loaded) restartRequired = true;
        });
        if (!completed) {
          report.skipped.push(`${id}: native package changed during reconciliation`);
          continue;
        }
        if (packageFiles) (hadMain ? report.updated : report.installed).push(id);
      } catch (error) {
        if (error instanceof PluginMutationChangedError) {
          report.skipped.push(`${id}: native package changed during reconciliation`);
        } else {
          report.failed.push(`${id}: failed at ${manifestPath}: ${formatError(error)}`);
        }
      }
    }

    await this.reporter.log("reconciliation", report);
    this.reporter.notifyReconciliation(report);
    if (restartRequired) {
      await this.logger.info("Community plugin state will take effect after restart");
      this.reporter.notifyRestartRequired();
    }
    return report;
  }

  private async resolvePackage(manifest: PluginManifest) {
    await this.logger.info("Resolving community plugin package", { id: manifest.id, version: manifest.version });
    return this.source.resolve(manifest);
  }
}
