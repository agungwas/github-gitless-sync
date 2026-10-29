import { PluginManifest, Vault } from "obsidian";
import Logger, { serializeError } from "../logger";
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
    private readonly logger: Logger,
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
    await this.ensureDirectory(this.stagingRoot);
    await this.ensureDirectory(stageDir);
    await this.ensureDirectory(backupDir);
    await this.ensureDirectory(stagedDir);
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
      const rollbackFailures: string[] = [];
      for (const name of files) {
        const target = `${folder}/${name}`;
        const original = backups.get(name) ?? null;
        try {
          if (original) await adapter.writeBinary(target, original);
          else if (await adapter.exists(target)) await adapter.remove(target);
        } catch (rollbackError) {
          rollbackFailures.push(`${target}: ${String(rollbackError)}`);
          await this.logger.error("Community plugin install rollback failed", {
            id,
            path: target,
            error: serializeError(rollbackError),
          });
        }
      }
      if (wasLoaded) {
        try {
          await this.enablePlugin(id, report);
        } catch (rollbackError) {
          rollbackFailures.push(`${id}: re-enable failed: ${String(rollbackError)}`);
          await this.logger.error("Community plugin runtime rollback failed", {
            id,
            error: serializeError(rollbackError),
          });
        }
      }
      await this.removeStageDirectory(id, stageDir);
      if (rollbackFailures.length) {
        throw new Error(`Package operation failed and rollback remains pending: ${String(error)}; ${rollbackFailures.join("; ")}`, { cause: error });
      }
      throw error;
    }
    await this.removeStageDirectory(id, stageDir);
  }

  async cleanupStaging(): Promise<void> {
    try {
      if (!(await this.vault.adapter.exists(this.stagingRoot))) return;
      await this.vault.adapter.rmdir(this.stagingRoot, true);
    } catch (error) {
      await this.logger.error("Community plugin staging cleanup failed", {
        path: this.stagingRoot,
        error: serializeError(error),
      });
    }
  }

  private async ensureDirectory(path: string): Promise<void> {
    const adapter = this.vault.adapter;
    try {
      if (await adapter.exists(path)) return;
      await adapter.mkdir(path);
    } catch (error) {
      let directoryExists: boolean;
      try {
        directoryExists = await adapter.exists(path);
      } catch (recheckError) {
        throw new Error(
          `Failed to prepare package staging directory ${path}: ${String(error)}; existence check failed: ${String(recheckError)}`,
          { cause: error },
        );
      }
      if (directoryExists) return;
      throw new Error(`Failed to prepare package staging directory ${path}: ${String(error)}`, { cause: error });
    }
  }

  private async removeStageDirectory(id: string, path: string): Promise<void> {
    try {
      if (!(await this.vault.adapter.exists(path))) return;
      await this.vault.adapter.rmdir(path, true);
    } catch (error) {
      await this.logger.error("Community plugin staging cleanup failed", {
        id,
        path,
        error: serializeError(error),
      });
    }
  }
}
