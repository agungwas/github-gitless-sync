import { Notice } from "obsidian";
import Logger from "../logger";
import { validId } from "./plugin-id";
import type { PluginSyncReport } from "./reconciler";

export class PluginSyncReporter {
  private lastSkipNotice = "";

  constructor(private readonly logger: Logger) {}

  async log(phase: "reconciliation" | "removal-scan", report: PluginSyncReport): Promise<void> {
    for (const entry of report.skipped) {
      await this.logger.warn("Community plugin skipped", { phase, ...this.reasonDetails(entry) });
    }
    for (const entry of report.failed) {
      await this.logger.error("Community plugin operation failed", { phase, ...this.reasonDetails(entry) });
    }
    for (const entry of report.runtimeFailures) {
      await this.logger.error("Community plugin reload failed; restart recommended", {
        phase, ...this.reasonDetails(entry),
      });
    }
    for (const action of ["installed", "updated", "uninstalled", "enabled", "disabled"] as const) {
      for (const id of report[action]) {
        await this.logger.info(`Community plugin ${action}`, { phase, id });
      }
    }
    const counts = Object.fromEntries(Object.entries(report).map(([status, entries]) => [status, entries.length]));
    await this.logger.info("Community plugin processing completed", { phase, counts });
  }

  notifyReconciliation(report: PluginSyncReport): void {
    if (report.installed.length || report.updated.length || report.uninstalled.length || report.enabled.length || report.disabled.length) {
      new Notice(`Community plugins: ${report.installed.length} installed, ${report.updated.length} updated, ${report.uninstalled.length} removed, ${report.enabled.length} enabled, ${report.disabled.length} disabled`);
    }
    if (report.failed.length) new Notice(`Community plugin sync failed: ${report.failed.join("; ")}`);
    if (report.runtimeFailures.length) new Notice("Plugin lifecycle reload failed. Reload or restart Obsidian if plugin remains inactive.");
    const skipNotice = report.skipped.join("\n");
    if (skipNotice !== this.lastSkipNotice && skipNotice) new Notice(`Community plugins skipped: ${report.skipped.join("; ")}`);
    this.lastSkipNotice = skipNotice;
  }

  private reasonDetails(entry: string): { readonly id?: string; readonly reason: string } {
    const separator = entry.indexOf(": ");
    const id = entry.slice(0, separator);
    return separator > 0 && validId(id)
      ? { id, reason: entry.slice(separator + 2) }
      : { reason: entry };
  }
}
