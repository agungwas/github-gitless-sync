import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/dom";
import { App, Notice } from "obsidian";
import { copyToClipboard } from "../utils";
import LogsModal from "./logs-modal";

vi.mock("../utils", () => ({ copyToClipboard: vi.fn() }));
vi.mock("obsidian", () => {
  class Modal {
    contentEl = document.createElement("div");
    setTitle(title: string) { this.contentEl.setAttribute("aria-label", title); return this; }
    onOpen() {}
    onClose() {}
    open() { document.body.append(this.contentEl); this.onOpen(); }
    close() { this.onClose(); this.contentEl.remove(); }
  }
  class ButtonComponent {
    buttonEl = document.createElement("button");
    constructor(container: HTMLElement) { container.append(this.buttonEl); }
    setButtonText(text: string) { this.buttonEl.textContent = text; return this; }
    setDisabled(disabled: boolean) { this.buttonEl.disabled = disabled; return this; }
    onClick(handler: () => unknown) { this.buttonEl.addEventListener("click", () => { void handler(); }); return this; }
  }
  class Setting {
    constructor(private readonly container: HTMLElement) {}
    addButton(configure: (button: ButtonComponent) => void) { configure(new ButtonComponent(this.container)); return this; }
  }
  return { Modal, ButtonComponent, Setting, Notice: vi.fn() };
});

function openModal(read: () => Promise<string>, clean: () => Promise<void> = async () => undefined): LogsModal {
  const modal = new LogsModal({} as App, read, clean);
  modal.open();
  return modal;
}

describe("LogsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("groups Clean on the left and Copy and Cancel on the right", () => {
    openModal(async () => "");
    const actions = document.querySelector(".gitless-logs-actions") as HTMLElement;
    const buttons = within(actions).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Clean", "Copy", "Cancel"]);
    expect(buttons[0].classList.contains("gitless-logs-clean")).toBe(true);
  });

  it("shows JSON entries as safe table cells and copies the original text on request", async () => {
    let resolveLogs!: (logs: string) => void;
    const readLogs = vi.fn(() => new Promise<string>((resolve) => { resolveLogs = resolve; }));
    openModal(readLogs);
    const copyButton = screen.getByRole<HTMLButtonElement>("button", { name: "Copy" });
    const output = screen.getByRole("region", { name: "Sync logs" });
    expect(output.textContent).toBe("Loading logs...");
    expect(copyButton.disabled).toBe(true);

    const message = '<img src=x onerror="alert(1)">';
    const logs = JSON.stringify({ timestamp: "2026-10-15T03:00:00.000Z", level: "INFO", message }) + "\n";
    resolveLogs(logs);
    const table = await screen.findByRole("table", { name: "Sync log entries" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent))
      .toEqual(["Timestamp", "Message", "Level"]);
    const cells = within(table).getAllByRole("cell");
    expect(cells[0].textContent).not.toBe("2026-10-15T03:00:00.000Z");
    expect(cells[0].title).toBe("2026-10-15T03:00:00.000Z");
    expect(cells.slice(1).map((cell) => cell.textContent)).toEqual([message, "INFO"]);
    expect(within(table).queryByRole("button", { name: /additional data/i })).toBeNull();
    expect(output.querySelector("img")).toBeNull();
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(copyButton.disabled).toBe(false);

    fireEvent.click(copyButton);
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(logs));
    await waitFor(() => expect(Notice).toHaveBeenCalledWith("Logs copied", 5000));
  });

  it.each([
    { timeZone: "Asia/Jakarta", timestamp: "2026-10-15T03:00:37Z", expected: "15/10 10:00:37" },
    { timeZone: "America/New_York", timestamp: "2026-10-15T03:00:37Z", expected: "14/10 23:00:37" },
    { timeZone: "Asia/Jakarta", timestamp: "2026-10-15T17:00:37Z", expected: "16/10 00:00:37" },
  ])("uses device timezone $timeZone and exact format at $timestamp", async ({ timeZone, timestamp, expected }) => {
    const DateTimeFormat = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (_locales, options) {
      return new DateTimeFormat("en-GB", { ...options, timeZone });
    });
    openModal(async () => JSON.stringify({ timestamp, level: "INFO", message: "Sync" }));

    const table = await screen.findByRole("table");

    expect(within(table).getAllByRole("cell")[0].textContent).toBe(expected);
  });

  it("preserves invalid timestamps without breaking valid log rows", async () => {
    openModal(async () => JSON.stringify({ timestamp: "invalid-date", level: "INFO", message: "Sync" }));

    const table = await screen.findByRole("table");

    expect(within(table).getAllByRole("cell")[0].textContent).toBe("invalid-date");
  });

  it.each(["", " \n\r\n\t"])("shows an empty state with copying disabled for %j", async (logs) => {
    openModal(async () => logs);

    await waitFor(() => expect(screen.getByRole("region").textContent).toContain("No logs recorded yet"));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Copy" }).disabled).toBe(true);
  });

  it("keeps valid rows around malformed JSON and unsupported entry shapes", async () => {
    const valid = JSON.stringify({ timestamp: "2026-10-15T03:00:00Z", level: "WARN", message: "Retrying" });
    const invalid = ['{"timestamp":', 'null', '[]', '{"message":42}'];
    openModal(async () => [valid, ...invalid, valid, ""].join("\r\n"));

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(6);
    expect(within(table).getAllByRole("cell", { name: "Retrying" })).toHaveLength(2);
    invalid.forEach((line, index) => {
      expect(within(rows[index + 1]).getAllByRole("cell").map((cell) => cell.textContent))
          .toEqual(["—", line, "UNPARSED"]);
    });
  });

  it.each([{ files: ["notes/a.md"], error: { message: "<img src=x>" } }, null, false, 0, ""])(
    "shows additional data without losing JSON values: %j",
    async (data) => {
      const logs = JSON.stringify({ timestamp: "2026-10-15T03:00:00Z", level: "ERROR", message: "Sync failed", additional_data: data });
      openModal(async () => logs);

      const table = await screen.findByRole("table");
      const button = within(table).getByRole<HTMLButtonElement>("button", { name: /additional data/i });
      const details = table.querySelector("pre");
      expect(within(table).getAllByRole("cell")).toHaveLength(3);
      expect(details?.hidden).toBe(true);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(within(table).getAllByRole("cell")[0]);
      expect(details?.hidden).toBe(false);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(details?.textContent).toBe(JSON.stringify(data, null, 2));
      fireEvent.keyDown(button, { key: " " });
      expect(details?.hidden).toBe(true);
      fireEvent.keyDown(button, { key: "Enter" });
      expect(details?.hidden).toBe(false);
      fireEvent.click(button);
      expect(details?.hidden).toBe(true);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(table.querySelector("img")).toBeNull();
    },
  );

  it("keeps each additional-data disclosure independent", async () => {
    const logs = [
      { timestamp: "2026-10-15T03:00:00Z", level: "WARN", message: "First", additional_data: { id: 1 } },
      { timestamp: "2026-10-15T03:00:01Z", level: "ERROR", message: "Second", additional_data: { id: 2 } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    openModal(async () => logs);

    const table = await screen.findByRole("table");
    const buttons = within(table).getAllByRole<HTMLButtonElement>("button", { name: /additional data/i });
    const details = Array.from(table.querySelectorAll("pre"));

    fireEvent.click(buttons[0]);
    expect(details.map((item) => item.hidden)).toEqual([false, true]);
    fireEvent.click(buttons[1]);
    expect(details.map((item) => item.hidden)).toEqual([false, false]);
  });

  it("shows read failures inside the modal", async () => {
    openModal(async () => { throw new Error("Disk unavailable"); });

    await waitFor(() => expect(screen.getByRole("region").textContent).toContain("Could not read logs: Error: Disk unavailable"));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Copy" }).disabled).toBe(true);
  });

  it("retains visible logs when clipboard access fails", async () => {
    vi.mocked(copyToClipboard).mockRejectedValue(new Error("Clipboard unavailable"));
    openModal(async () => "INFO Sync completed");
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Copy" }).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(Notice).toHaveBeenCalledWith("Failed copying logs: Error: Clipboard unavailable", 10000));
    expect(screen.getByRole("cell", { name: "INFO Sync completed" })).toBeTruthy();
  });

  it("ignores a pending read after closing the modal", async () => {
    let resolveLogs!: (logs: string) => void;
    const read = new Promise<string>((resolve) => { resolveLogs = resolve; });
    openModal(() => read);
    const output = screen.getByRole("region");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    resolveLogs("INFO Delayed read");
    await read;

    expect(screen.queryByRole("region")).toBeNull();
    expect(output.textContent).toBe("Loading logs...");
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("clears stored logs and the table from inside the modal", async () => {
    let logs = JSON.stringify({ timestamp: "2026-10-15T03:00:00Z", level: "INFO", message: "Sync completed" });
    const clean = vi.fn(async () => { logs = ""; });
    openModal(async () => logs, clean);
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("button", { name: "Clean" }));

    await waitFor(() => expect(screen.getByRole("region").textContent).toContain("No logs recorded yet"));
    expect(clean).toHaveBeenCalledTimes(1);
    expect(logs).toBe("");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Copy" }).disabled).toBe(true);
    expect(Notice).toHaveBeenCalledWith("Logs cleaned", 5000);
  });

  it("preserves displayed logs and restores copying when cleaning fails", async () => {
    const clean = vi.fn(async () => { throw new Error("Disk unavailable"); });
    openModal(async () => "Original logs", clean);
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("button", { name: "Clean" }));

    await waitFor(() => expect(Notice).toHaveBeenCalledWith("Failed cleaning logs: Error: Disk unavailable", 10000));
    expect(screen.getByRole("cell", { name: "Original logs" })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Copy" }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Clean" }).disabled).toBe(false);
  });

  it("blocks duplicate cleaning and ignores completion after closing and reopening", async () => {
    let resolveClean: () => void = () => { throw new Error("Clean gate not initialized"); };
    const pending = new Promise<void>((resolve) => { resolveClean = resolve; });
    const clean = vi.fn(() => pending);
    const modal = openModal(async () => "Visible logs", clean);
    await screen.findByRole("table");
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Clean" });

    button.click();
    button.click();

    expect(button.disabled).toBe(true);
    expect(clean).toHaveBeenCalledTimes(1);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Copy" }).disabled).toBe(true);
    modal.close();
    modal.open();
    await screen.findByRole("table");
    resolveClean();
    await pending;
    expect(screen.getByRole("cell", { name: "Visible logs" })).toBeTruthy();
    expect(Notice).not.toHaveBeenCalledWith("Logs cleaned", 5000);
  });
});
