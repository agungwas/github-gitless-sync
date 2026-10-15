import { Platform, PluginManifest, Vault, requireApiVersion } from "obsidian";
import MetadataStore from "../metadata-store";
import Logger from "../logger";
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
    this.installer = new PluginPackageInstaller(vault, runtime, this.stagingRoot);
  }

  startObservingNativeMutations(): () => void {
    return this.runtime.observeNativeMutations((event) => {
      void this.handleNativeMutation(event).catch(async (error) => {
        await this.logger.error("Native community plugin change could not be recorded", {
          id: event.id,
          kind: event.kind,
          error: String(error),
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
    const listing = await this.vault.adapter.list(this.pluginRoot).catch(() => null);
    if (!listing) return;
    const currentIds = new Set(listing.folders.map((folder) => folder.slice(this.pluginRoot.length + 1)).filter(validId));
    const enabledText = await this.vault.adapter.read(`${this.configDir}/community-plugins.json`).catch(() => null);
    if (enabledText === null) return;
    let enabled: Set<string>;
    try {
      const value: unknown = JSON.parse(enabledText);
      if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) return;
      enabled = new Set(value);
    } catch {
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
        report.skipped.push(`${id}: uninstall evidence unavailable: ${String(error)}`);
      }
    }
    if (report.uninstalled.length) await this.metadataStore.save();
    await this.reporter.log("removal-scan", report);
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
      const enabled = JSON.parse(await this.vault.adapter.read(`${this.configDir}/community-plugins.json`));
      if (!Array.isArray(enabled) || enabled.some((id) => typeof id !== "string")) throw new Error("invalid enabled-plugin list");
      enabledIds = new Set(enabled);
    } catch (error) {
      report.skipped.push(`enabled state unavailable: ${String(error)}`);
      await this.reporter.log("reconciliation", report);
      return report;
    }
    const folders = await this.vault.adapter.list(this.pluginRoot).catch(() => null);
    if (!folders) {
      report.skipped.push("plugin directory unavailable");
      await this.reporter.log("reconciliation", report);
      return report;
    }
    await this.installer.cleanupStaging();
    for (const id of this.knownLocalIds) {
      if (id !== this.selfPluginId && !enabledIds.has(id) && this.runtime.isLoaded(id)) {
        const mutationVersion = this.runtime.mutationVersion(id);
        if (this.runtime.isMutating(id)) {
          report.skipped.push(`${id}: native package mutation in progress`);
          continue;
        }
        try {
          const completed = await withStableMutation(this.runtime, id, mutationVersion, () => this.installer.unloadPlugin(id, report));
          if (!completed) {
            report.skipped.push(`${id}: native package changed during reconciliation`);
            continue;
          }
          report.disabled.push(id);
        } catch (error) {
          const message = `${id}: disable failed: ${String(error)}`;
          report.failed.push(message);
        }
      }
    }
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
        report.failed.push(`${id}: uninstall failed: ${String(error)}`);
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
          } else if (desiredEnabled && !loaded) {
            const completed = await withStableMutation(this.runtime, id, mutationVersion, () => this.installer.enablePlugin(id, report));
            if (completed) report.enabled.push(id);
            else report.skipped.push(`${id}: native package changed during reconciliation`);
          } else if (!desiredEnabled && loaded) {
            const completed = await withStableMutation(this.runtime, id, mutationVersion, () => this.installer.unloadPlugin(id, report));
            if (completed) report.disabled.push(id);
            else report.skipped.push(`${id}: native package changed during reconciliation`);
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
            const reason = String(error);
            if (reason.includes("not in the official registry")) report.skipped.push(`${id}: ${reason}`);
            else report.failed.push(`${id}: ${reason}`);
            continue;
          }
        }
        const completed = await withStableMutation(this.runtime, id, mutationVersion, async () => {
          if (packageFiles) {
            try {
              await this.installer.install(id, folder, manifestText, packageFiles, mainPath, stylesPath, report);
            } catch (error) {
              this.pendingHydrate.add(id);
              throw error;
            }
            this.pendingHydrate.delete(id);
          }
          const loadedAfterInstall = this.runtime.isLoaded(id);
          if (desiredEnabled && !loadedAfterInstall) {
            await this.installer.enablePlugin(id, report);
            report.enabled.push(id);
          } else if (!desiredEnabled && loadedAfterInstall) {
            await this.installer.unloadPlugin(id, report);
            report.disabled.push(id);
          }
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
          report.failed.push(`${id}: ${String(error)}`);
          await this.logger.error("Community plugin reconciliation failed", { id, error: String(error) });
        }
      }
    }

    await this.reporter.log("reconciliation", report);
    this.reporter.notifyReconciliation(report);
    return report;
  }

  private async resolvePackage(manifest: PluginManifest) {
    await this.logger.info("Resolving community plugin package", { id: manifest.id, version: manifest.version });
    return this.source.resolve(manifest);
  }
}
