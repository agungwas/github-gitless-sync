import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { copyToClipboard } from "../utils";

export default class LogsModal extends Modal {
  private logs = "";
  private loadGeneration = 0;
  private copyButton: ButtonComponent | null = null;
  private cleanButton: ButtonComponent | null = null;

  constructor(
    app: App,
    private readonly readLogs: () => Promise<string>,
    private readonly clearLogs: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const generation = ++this.loadGeneration;
    this.logs = "";
    this.setTitle("Gitless logs");
    this.contentEl.replaceChildren();

    const logOutput = document.createElement("div");
    logOutput.className = "gitless-logs-content";
    logOutput.tabIndex = 0;
    logOutput.setAttribute("role", "region");
    logOutput.setAttribute("aria-label", "Sync logs");
    logOutput.textContent = "Loading logs...";
    this.contentEl.append(logOutput);

    new Setting(this.contentEl)
      .addButton((button) => {
        this.copyButton = button;
        button.setButtonText("Copy").setDisabled(true).onClick(() => this.copyLogs());
      })
      .addButton((button) => {
        this.cleanButton = button;
        button.setButtonText("Clean logs").setDisabled(true).onClick(() => this.cleanLogs(logOutput, button));
      })
      .addButton((button) => button.setButtonText("Close").onClick(() => this.close()));
    void this.loadLogs(logOutput, generation);
  }

  onClose(): void {
    this.loadGeneration++;
    this.logs = "";
    this.copyButton = null;
    this.cleanButton = null;
    this.contentEl.replaceChildren();
  }

  private async loadLogs(output: HTMLElement, generation: number): Promise<void> {
    try {
      const logs = await this.readLogs();
      if (generation !== this.loadGeneration) return;
      this.logs = logs;
      this.renderLogs(output, logs);
      this.copyButton?.setDisabled(logs.trim().length === 0);
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      output.textContent = `Could not read logs: ${String(error)}`;
    } finally {
      if (generation === this.loadGeneration) this.cleanButton?.setDisabled(false);
    }
  }

  private async cleanLogs(output: HTMLElement, button: ButtonComponent): Promise<void> {
    const generation = ++this.loadGeneration;
    button.setDisabled(true);
    this.copyButton?.setDisabled(true);
    try {
      await this.clearLogs();
      if (generation !== this.loadGeneration) return;
      this.logs = "";
      this.renderLogs(output, "");
      new Notice("Logs cleaned", 5000);
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      new Notice(`Failed cleaning logs: ${String(error)}`, 10000);
    } finally {
      if (generation === this.loadGeneration) {
        button.setDisabled(false);
        this.copyButton?.setDisabled(this.logs.trim().length === 0);
      }
    }
  }

  private renderLogs(output: HTMLElement, logs: string): void {
    const lines = logs.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      output.textContent = "No logs recorded yet. Enable logging in settings to record sync activity.";
      return;
    }

    const table = document.createElement("table");
    table.className = "gitless-logs-table";
    table.setAttribute("aria-label", "Sync log entries");
    const heading = table.createTHead().insertRow();
    for (const label of ["Timestamp (local)", "Level", "Message", "Additional data"]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      heading.append(cell);
    }

    const timestampFormatter = new Intl.DateTimeFormat("en-GB", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    });
    const body = table.createTBody();
    for (const line of lines) {
      const row = body.insertRow();
      const entry = this.parseEntry(line);
      const timestamp = row.insertCell();
      const date = new Date(entry.timestamp);
      if (Number.isNaN(date.getTime())) {
        timestamp.textContent = entry.timestamp;
      } else {
        const parts = Object.fromEntries(timestampFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
        timestamp.textContent = `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
      }
      timestamp.title = entry.timestamp;
      for (const value of [entry.level, entry.message]) {
        row.insertCell().textContent = value;
      }
      const data = row.insertCell();
      if (entry.additional_data === undefined) {
        data.textContent = "—";
        continue;
      }
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "View data";
      const content = document.createElement("pre");
      content.textContent = JSON.stringify(entry.additional_data, null, 2);
      details.append(summary, content);
      data.append(details);
    }
    output.replaceChildren(table);
  }

  private parseEntry(line: string): {
    readonly timestamp: string;
    readonly level: string;
    readonly message: string;
    readonly additional_data?: unknown;
  } {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (typeof value === "object" && value !== null &&
      "timestamp" in value && typeof value.timestamp === "string" &&
      "level" in value && typeof value.level === "string" &&
      "message" in value && typeof value.message === "string") {
      return {
        timestamp: value.timestamp,
        level: value.level,
        message: value.message,
        additional_data: "additional_data" in value ? value.additional_data : undefined,
      };
    }
    return { timestamp: "—", level: "UNPARSED", message: line };
  }

  private async copyLogs(): Promise<void> {
    if (!this.logs) return;
    try {
      await copyToClipboard(this.logs);
      new Notice("Logs copied", 5000);
    } catch (error) {
      new Notice(`Failed copying logs: ${String(error)}`, 10000);
    }
  }
}
