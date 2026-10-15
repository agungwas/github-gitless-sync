import { PluginManifest, Vault } from "obsidian";
import type { OfficialPackageSource } from "./package-source";
import type { PluginSyncReport } from "./reconciler";
import { PluginRuntimeBridge } from "./runtime-bridge";

const PACKAGE_FILES = ["manifest.json", "main.js", "styles.css"] as const;

/** Stages, promotes, verifies and rolls back plugin packages. */
export class PluginPackageInstaller {
  constructor(
    private readonly vault: Vault,
    private readonly runtime: PluginRuntimeBridge,
    private readonly stagingRoot: string,
  ) {}

  async enablePlugin(id: string, report: PluginSyncReport): Promise<void> {
    try {
      await this.runtime.enable(id);
    } catch (error) {
      report.runtimeFailures.push(`${id}: enable failed`);
      throw error;
    }
  }

  async unloadPlugin(id: string, report: PluginSyncReport): Promise<void> {
    try {
      await this.runtime.unload(id);
    } catch (error) {
      report.runtimeFailures.push(`${id}: disable failed`);
      throw error;
    }
  }

  async install(
    id: string,
    folder: string,
    manifestText: string,
    pkg: Awaited<ReturnType<OfficialPackageSource["resolve"]>>,
    mainPath: string,
    stylesPath: string,
    report: PluginSyncReport,
  ): Promise<void> {
    const stageDir = `${this.stagingRoot}/${id}`;
    const backupDir = `${stageDir}/backup`;
    const stagedDir = `${stageDir}/package`;
    const adapter = this.vault.adapter;
    const files = PACKAGE_FILES;
    const backups = new Map<string, ArrayBuffer | null>();
    await adapter.mkdir(this.stagingRoot).catch(() => undefined);
    await adapter.mkdir(stageDir).catch(() => undefined);
    await adapter.mkdir(backupDir).catch(() => undefined);
    await adapter.mkdir(stagedDir).catch(() => undefined);
    const manifestBytes = new TextEncoder().encode(manifestText).buffer;
    const staged = {
      "manifest.json": manifestBytes,
      "main.js": pkg.assets.mainJs,
      "styles.css": pkg.assets.stylesCss,
    };
    for (const name of files) {
      const target = `${folder}/${name}`;
      const existing = await adapter.exists(target) ? await adapter.readBinary(target) : null;
      backups.set(name, existing);
      if (existing) await adapter.writeBinary(`${backupDir}/${name}`, existing);
      const bytes = staged[name];
      if (bytes) await adapter.writeBinary(`${stagedDir}/${name}`, bytes);
    }
    const wasLoaded = this.runtime.isLoaded(id);
    try {
      if (wasLoaded) await this.unloadPlugin(id, report);
      for (const name of files) {
        const target = `${folder}/${name}`;
        const source = `${stagedDir}/${name}`;
        if (staged[name]) {
          await adapter.writeBinary(target, await adapter.readBinary(source));
        } else if (await adapter.exists(target)) {
          await adapter.remove(target);
        }
      }
      if (!(await adapter.exists(mainPath))) throw new Error("Installed package verification failed");
      const installedManifest = JSON.parse(await adapter.read(`${folder}/manifest.json`)) as PluginManifest;
      if (installedManifest.id !== id || installedManifest.version !== pkg.manifest.version) {
        throw new Error("Installed manifest verification failed");
      }
      if (pkg.assets.stylesCss && !(await adapter.exists(stylesPath))) {
        throw new Error("Installed stylesheet verification failed");
      }
    } catch (error) {
      let rollbackFailed = false;
      for (const name of files) {
        const target = `${folder}/${name}`;
        const original = backups.get(name) ?? null;
        try {
          if (original) await adapter.writeBinary(target, original);
          else if (await adapter.exists(target)) await adapter.remove(target);
        } catch {
          rollbackFailed = true;
        }
      }
      if (wasLoaded) {
        try {
          await this.enablePlugin(id, report);
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) {
        throw new Error(`Package operation failed and rollback remains pending: ${String(error)}`);
      }
      await adapter.rmdir(stageDir, true).catch(() => undefined);
      throw error;
    }
    await adapter.rmdir(stageDir, true).catch(() => undefined);
  }

  async cleanupStaging(): Promise<void> {
    try {
      await this.vault.adapter.rmdir(this.stagingRoot, true);
    } catch {
      // Nothing staged, or staging could not be removed; the next sync tries again.
    }
  }
}
