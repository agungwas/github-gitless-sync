import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const helperDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(helperDir, "../../../../../../");
const qaDir = path.resolve(helperDir, "..");
const require = createRequire(import.meta.url);
function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    const cliPath = process.env.PLAYWRIGHT_CLI_PATH
      ?? execFileSync("asdf", ["which", "playwright"], { encoding: "utf8" }).trim();
    return require(path.resolve(path.dirname(cliPath), "../lib/node_modules/playwright"));
  }
}
const { chromium } = loadPlaywright();
const esbuild = require(path.join(repoRoot, "node_modules/esbuild"));
const tempDir = mkdtempSync(path.join(tmpdir(), "gitless-logs-qa-"));
const bundlePath = path.join(tempDir, "bundle.js");
const pagePath = path.join(tempDir, "index.html");

const obsidianStub = `
  export class Modal {
    constructor() {
      this.modalEl = document.createElement("section");
      this.modalEl.className = "modal";
      this.titleEl = document.createElement("h2");
      this.contentEl = document.createElement("div");
      this.modalEl.append(this.titleEl, this.contentEl);
      document.body.append(this.modalEl);
    }
    setTitle(title) { this.titleEl.textContent = title; }
    close() { this.onClose(); this.modalEl.remove(); }
  }
  export class ButtonComponent {
    constructor(parent) {
      this.buttonEl = document.createElement("button");
      this.buttonEl.type = "button";
      parent.append(this.buttonEl);
    }
    setButtonText(text) { this.buttonEl.textContent = text; return this; }
    setDisabled(disabled) { this.buttonEl.disabled = disabled; return this; }
    onClick(callback) { this.buttonEl.addEventListener("click", callback); return this; }
  }
  export class Setting {
    constructor(parent) { this.el = document.createElement("div"); parent.append(this.el); }
    addButton(callback) { callback(new ButtonComponent(this.el)); return this; }
  }
  export class Notice { constructor(message) { window.__notices.push(message); } }
`;

async function main() {
  await esbuild.build({
    stdin: {
      contents: `
        import LogsModal from ${JSON.stringify(path.join(repoRoot, "src/settings/logs-modal.ts"))};
        window.makeLogsModal = (readLogs, clearLogs) => new LogsModal({}, readLogs, clearLogs);
        window.mountLogsModal = (readLogs, clearLogs) => {
          const modal = window.makeLogsModal(readLogs, clearLogs);
          modal.onOpen();
          return modal;
        };
      `,
      resolveDir: repoRoot,
      sourcefile: "qa-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile: bundlePath,
    plugins: [{
      name: "qa-runtime-stubs",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "qa" }));
        build.onResolve({ filter: /^\.\.\/utils$/ }, () => ({ path: "utils", namespace: "qa" }));
        build.onLoad({ filter: /.*/, namespace: "qa" }, ({ path: modulePath }) => ({
          loader: "js",
          contents: modulePath === "obsidian"
            ? obsidianStub
            : `export async function copyToClipboard(text) { window.__copiedText = text; }`,
        }));
      },
    }],
  });

  const pluginCss = readFileSync(path.join(repoRoot, "styles.css"), "utf8");
  writeFileSync(pagePath, `<!doctype html>
    <html><head><meta charset="utf-8"><style>
      :root { --font-ui-small: 13px; --size-4-2: 8px; --size-4-4: 16px; --color-blue: #086ddd; --text-on-accent: #fff; --background-primary: #20232b;
        --background-modifier-border: #555; --font-monospace: monospace; --interactive-accent: #7c9cff; }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 16px; background: #15171c; color: #f3f4f6; font: 14px sans-serif; }
      .modal { width: min(100%, 72rem); margin: auto; padding: 16px; background: var(--background-primary); }
      .modal h2 { margin: 0 0 12px; }
      button { background: #e6e7e9; border-radius: 6px; box-shadow: 0 1px 3px #0006; }
      ${pluginCss}
    </style></head><body><main id="root"></main><script>window.__notices = [];</script>
    <script src="bundle.js"></script></body></html>`);

  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(pathToFileURL(pagePath).href);

    const longData = { html: "<img src=x onerror=alert(1)>", nested: { long: "x".repeat(8192) } };
    const rawLogs = [
      { timestamp: "2026-10-20T20:45:59.035Z", level: "INFO", message: "Expand from row", additional_data: longData },
      { timestamp: "2026-10-20T20:46:00.000Z", level: "WARN", message: "Null data", additional_data: null },
      { timestamp: "2026-10-20T20:46:01.000Z", level: "ERROR", message: "False data", additional_data: false },
      { timestamp: "2026-10-20T20:46:02.000Z", level: "INFO", message: "Zero data", additional_data: 0 },
      { timestamp: "2026-10-20T20:46:03.000Z", level: "INFO", message: "Empty data", additional_data: "" },
      { timestamp: "2026-10-20T20:46:04.000Z", level: "DEBUG", message: "No additional data" },
      "malformed log line",
    ].map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n");

    await page.evaluate((logs) => {
      window.__qaModal = window.mountLogsModal(async () => logs, async () => {});
    }, rawLogs);
    const table = page.getByRole("table", { name: "Sync log entries" });
    await table.waitFor();
    assert.deepEqual(await table.locator("thead th").allTextContents(), ["Timestamp", "Message", "Level"]);
    const rows = table.locator("tbody tr");
    assert.equal(await rows.count(), 7);
    assert.equal(await rows.nth(0).locator("pre").isHidden(), true);
    const toggleStyle = await rows.nth(0).locator("button").evaluate((button) => {
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, shadow: style.boxShadow, radius: style.borderRadius };
    });
    assert.deepEqual(toggleStyle, { background: "rgba(0, 0, 0, 0)", shadow: "none", radius: "0px" });
    assert.equal(await rows.nth(5).locator("button").count(), 0);
    assert.equal(await rows.nth(6).locator("button").count(), 0);
    await page.screenshot({ path: path.join(qaDir, "logs-desktop-current.png"), fullPage: true });

    await rows.nth(0).locator("td").nth(2).click();
    const firstToggle = rows.nth(0).getByRole("button");
    assert.equal(await firstToggle.getAttribute("aria-expanded"), "true");
    assert.equal(await rows.nth(0).locator("pre").isHidden(), false);
    assert.equal(await page.locator("img").count(), 0);

    await firstToggle.focus();
    await firstToggle.press("Enter");
    assert.equal(await firstToggle.getAttribute("aria-expanded"), "false", "Enter collapses the row");
    await firstToggle.press("Space");
    assert.equal(await firstToggle.getAttribute("aria-expanded"), "true", "Space expands the row");
    const firstJson = await rows.nth(0).locator("pre").textContent();
    assert.equal(firstJson, JSON.stringify(longData, null, 2));
    await page.screenshot({ path: path.join(qaDir, "logs-expanded-current.png"), fullPage: true });
    await firstToggle.click();
    await firstToggle.locator("span").first().selectText();
    assert.ok((await page.evaluate(() => window.getSelection().toString())).includes("Expand from row"));
    assert.equal(await firstToggle.getAttribute("aria-expanded"), "false", "selecting message text should not expand the row");
    await page.evaluate(() => window.getSelection().removeAllRanges());

    for (const [index, expected] of [[1, "null"], [2, "false"], [3, "0"], [4, '""']]) {
      const row = rows.nth(index);
      await row.locator("td").nth(1).click();
      assert.equal(await row.locator("pre").textContent(), expected);
      assert.equal(await row.getByRole("button").getAttribute("aria-expanded"), "true");
      await row.getByRole("button").click();
    }

    await firstToggle.click();
    await page.setViewportSize({ width: 390, height: 844 });
    await rows.nth(0).scrollIntoViewIfNeeded();
    const mobileLayout = await page.evaluate(() => {
      const content = document.querySelector(".gitless-logs-content");
      const pre = document.querySelector(".gitless-log-additional-data");
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        contentWidth: content.clientWidth,
        contentScrollWidth: content.scrollWidth,
        detailsWrap: getComputedStyle(pre).overflowWrap,
        detailsWhiteSpace: getComputedStyle(pre).whiteSpace,
      };
    });
    assert.equal(mobileLayout.documentWidth, mobileLayout.viewportWidth, "page should not clip horizontally");
    assert.equal(mobileLayout.detailsWrap, "anywhere");
    assert.equal(mobileLayout.detailsWhiteSpace, "pre-wrap");
    await page.screenshot({ path: path.join(qaDir, "logs-mobile.png"), fullPage: true });
    await page.locator(".gitless-logs-content").evaluate((content) => { content.scrollLeft = content.scrollWidth; });
    const levelBox = await table.locator("thead th").nth(2).boundingBox();
    const contentBox = await page.locator(".gitless-logs-content").boundingBox();
    assert.ok(levelBox.x + levelBox.width <= contentBox.x + contentBox.width, "horizontal scroll should reveal the Level column");
    await page.screenshot({ path: path.join(qaDir, "logs-mobile-right.png"), fullPage: true });

    await page.getByRole("button", { name: "Copy" }).click();
    assert.equal(await page.evaluate(() => window.__copiedText), rawLogs);
    await page.getByRole("button", { name: "Clean" }).click();
    await page.getByText("No logs recorded yet.").waitFor();
    assert.equal(await page.getByRole("button", { name: "Copy" }).isDisabled(), true);

    await page.evaluate(() => {
      let resolveOld;
      let resolveNew;
      let callCount = 0;
      const readLogs = () => new Promise((resolve) => {
        callCount++;
        if (callCount === 1) resolveOld = resolve;
        else resolveNew = resolve;
      });
      window.__asyncReads = { get old() { return resolveOld; }, get current() { return resolveNew; } };
      window.__asyncModal = window.makeLogsModal(readLogs, async () => {});
      window.__asyncModal.onOpen();
      window.__asyncModal.onClose();
      window.__asyncModal.onOpen();
    });
    await page.waitForFunction(() => window.__asyncReads.old && window.__asyncReads.current);
    await page.evaluate(() => {
      window.__asyncReads.old("stale log");
      window.__asyncReads.current(JSON.stringify({ timestamp: "2026-10-20T20:47:00Z", level: "INFO", message: "current log" }));
    });
    await page.getByRole("table", { name: "Sync log entries" }).waitFor();
    assert.equal(await page.getByText("current log").count(), 1);
    assert.equal(await page.getByText("stale log").count(), 0);
    await page.locator(".modal").last().getByRole("button", { name: "Cancel" }).click();
    assert.equal(await page.locator(".modal").count(), 1, "Close removes the reopened modal");
    await page.locator(".modal").first().getByRole("button", { name: "Cancel" }).click();
    assert.equal(await page.locator(".modal").count(), 0, "Close removes modal content");

    process.stdout.write(`PASS modal rows, falsey data, pointer/keyboard toggles, text selection, safe rendering, mobile scroll/wrap, copy/clean/close, async reopen. ${JSON.stringify(mobileLayout)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}).finally(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
