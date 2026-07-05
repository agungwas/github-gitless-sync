import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Setting } from "obsidian";
import GitHubSyncSettingsTab, { bucketPathsByPattern } from "./tab";

vi.mock("obsidian", () => {
  class FakeTextComponent {
    inputEl = { type: "text" };
    onChangeHandler: ((value: string) => unknown) | undefined;
    setPlaceholder() {
      return this;
    }
    setValue() {
      return this;
    }
    onChange(fn: (value: string) => unknown) {
      this.onChangeHandler = fn;
      return this;
    }
  }

  class FakeButtonComponent {
    onClickHandler: (() => unknown) | undefined;
    setIcon() {
      return this;
    }
    setTooltip() {
      return this;
    }
    setButtonText() {
      return this;
    }
    setCta() {
      return this;
    }
    setDisabled() {
      return this;
    }
    onClick(fn: () => unknown) {
      this.onClickHandler = fn;
      return this;
    }
  }

  class FakeDropdownComponent {
    addOptions() {
      return this;
    }
    setValue() {
      return this;
    }
    onChange() {
      return this;
    }
  }

  class FakeToggleComponent {
    setValue() {
      return this;
    }
    onChange() {
      return this;
    }
  }

  class Setting {
    static instances: Setting[] = [];
    textComponent?: FakeTextComponent;
    buttonComponents: FakeButtonComponent[] = [];

    constructor(public containerEl: unknown) {
      Setting.instances.push(this);
    }
    setName() {
      return this;
    }
    setDesc() {
      return this;
    }
    setHeading() {
      return this;
    }
    setDisabled() {
      return this;
    }
    addText(cb: (text: FakeTextComponent) => unknown) {
      this.textComponent = new FakeTextComponent();
      cb(this.textComponent);
      return this;
    }
    addButton(cb: (button: FakeButtonComponent) => unknown) {
      const button = new FakeButtonComponent();
      cb(button);
      this.buttonComponents.push(button);
      return this;
    }
    addDropdown(cb: (dropdown: FakeDropdownComponent) => unknown) {
      cb(new FakeDropdownComponent());
      return this;
    }
    addToggle(cb: (toggle: FakeToggleComponent) => unknown) {
      cb(new FakeToggleComponent());
      return this;
    }
  }

  class PluginSettingTab {
    app: unknown;
    plugin: unknown;
    containerEl: unknown = {};
    constructor(app: unknown, plugin: unknown) {
      this.app = app;
      this.plugin = plugin;
    }
  }

  class Modal {
    contentEl = { createEl: () => ({}), empty: () => {} };
    constructor(public app: unknown) {}
    setTitle() {
      return this;
    }
    setContent() {
      return this;
    }
    open() {}
    close() {}
  }

  return {
    Setting,
    PluginSettingTab,
    Modal,
    Notice: vi.fn(),
  };
});

function makePlugin() {
  return {
    saveSettings: vi.fn().mockResolvedValue(undefined),
    syncManager: {
      removeExcludedFromMetadata: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("GitHubSyncSettingsTab", () => {
  let tab: GitHubSyncSettingsTab;
  let mockPlugin: ReturnType<typeof makePlugin>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockPlugin = makePlugin();
    tab = new GitHubSyncSettingsTab({} as any, mockPlugin as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("scheduleMetadataCleanup (plan-fix-exclude-patterns-qa-findings)", () => {
    it("debounces multiple rapid calls into a single removeExcludedFromMetadata invocation", async () => {
      const scheduleMetadataCleanup = (tab as any).scheduleMetadataCleanup.bind(tab);
      scheduleMetadataCleanup();
      vi.advanceTimersByTime(100);
      scheduleMetadataCleanup();
      vi.advanceTimersByTime(100);
      scheduleMetadataCleanup();

      expect(mockPlugin.syncManager.removeExcludedFromMetadata).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(400);

      expect(mockPlugin.syncManager.removeExcludedFromMetadata).toHaveBeenCalledTimes(1);
    });

    it("fires exactly once, 400ms after the last call", async () => {
      const scheduleMetadataCleanup = (tab as any).scheduleMetadataCleanup.bind(tab);
      scheduleMetadataCleanup();

      await vi.advanceTimersByTimeAsync(399);
      expect(mockPlugin.syncManager.removeExcludedFromMetadata).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mockPlugin.syncManager.removeExcludedFromMetadata).toHaveBeenCalledTimes(1);
    });
  });

  describe("renderPatternList (plan-pattern-settings-ux-and-remote-cleanup)", () => {
    beforeEach(() => {
      (Setting as any).instances = [];
      vi.spyOn(tab, "display").mockImplementation(() => {});
    });

    it("never calls display() when typing into any row, including the last one", async () => {
      const patterns = ["**/main.js"];
      (tab as any).renderPatternList({}, patterns, "placeholder");

      const rowSetting = (Setting as any).instances[0];
      await rowSetting.textComponent.onChangeHandler("**/main.jsx");

      expect(patterns[0]).toBe("**/main.jsx");
      expect(tab.display).not.toHaveBeenCalled();
    });

    it('"+ Add pattern" button pushes exactly one blank row and calls display() once', () => {
      const patterns = ["**/main.js"];
      (tab as any).renderPatternList({}, patterns, "placeholder");

      const rowSetting = (Setting as any).instances[0];
      const addRowSetting = (Setting as any).instances[1];
      // The add-row Setting is the one whose only component is a button (no text field).
      expect(addRowSetting.textComponent).toBeUndefined();
      const addButton = addRowSetting.buttonComponents[0];

      addButton.onClickHandler();

      expect(patterns).toEqual(["**/main.js", ""]);
      expect(tab.display).toHaveBeenCalledTimes(1);
      // sanity: the first row's own trash button is untouched by this click
      expect(rowSetting.buttonComponents).toHaveLength(1);
    });

    it("every row (no exceptions) gets a working delete button", async () => {
      const patterns = ["**/main.js", "**/other.js"];
      (tab as any).renderPatternList({}, patterns, "placeholder");

      const firstRow = (Setting as any).instances[0];
      const secondRow = (Setting as any).instances[1];

      expect(firstRow.buttonComponents).toHaveLength(1);
      expect(secondRow.buttonComponents).toHaveLength(1);

      await secondRow.buttonComponents[0].onClickHandler();

      expect(patterns).toEqual(["**/main.js"]);
      expect(mockPlugin.saveSettings).toHaveBeenCalled();
      expect(mockPlugin.syncManager.removeExcludedFromMetadata).toHaveBeenCalled();
      expect(tab.display).toHaveBeenCalledTimes(1);
    });
  });

  describe("bucketPathsByPattern (plan-fix-preview-accuracy-and-delete-visibility step 5: renamed param, flipped polarity from shouldSkipFile to isPathSyncable)", () => {
    it("buckets each path into willSync or excluded per the isPathSyncable predicate", () => {
      const isPathSyncable = (path: string) => !path.startsWith(".obsidian/plugins/");

      const result = bucketPathsByPattern(
        [".obsidian/plugins/foo/main.js", "notes/todo.md"],
        isPathSyncable,
      );

      expect(result).toEqual({
        willSync: ["notes/todo.md"],
        excluded: [".obsidian/plugins/foo/main.js"],
      });
    });

    it("returns empty arrays for an empty path list", () => {
      expect(bucketPathsByPattern([], () => true)).toEqual({
        willSync: [],
        excluded: [],
      });
    });
  });

  describe("showPatternPreview (plan-fix-preview-accuracy-and-delete-visibility)", () => {
    it("buckets using syncManager.isPathSyncable, not shouldSkipFile", async () => {
      const isPathSyncable = vi.fn().mockReturnValue(true);
      const shouldSkipFile = vi.fn().mockReturnValue(false);
      const list = vi.fn().mockImplementation(async (folder: string) => {
        if (folder === "/") {
          return { files: ["/notes.md"], folders: [] };
        }
        return { files: [], folders: [] };
      });
      const appWithVault = {
        vault: { getRoot: () => ({ path: "/" }), adapter: { list } },
      };
      const pluginWithSyncManager = {
        ...mockPlugin,
        syncManager: { ...mockPlugin.syncManager, isPathSyncable, shouldSkipFile },
      };
      const previewTab = new GitHubSyncSettingsTab(appWithVault as any, pluginWithSyncManager as any);

      await (previewTab as any).showPatternPreview();

      expect(isPathSyncable).toHaveBeenCalledWith("/notes.md");
      expect(shouldSkipFile).not.toHaveBeenCalled();
    });
  });

  describe("collectVaultPaths (plan-pattern-settings-ux-and-remote-cleanup)", () => {
    it("walks the vault root recursively and returns every file path", async () => {
      const list = vi.fn();
      list.mockImplementation(async (folder: string) => {
        if (folder === "/") {
          return { files: ["/notes.md"], folders: ["/sub"] };
        }
        if (folder === "/sub") {
          return { files: ["/sub/nested.md"], folders: [] };
        }
        return { files: [], folders: [] };
      });

      const appWithVault = {
        vault: {
          getRoot: () => ({ path: "/" }),
          adapter: { list },
        },
      };
      const previewTab = new GitHubSyncSettingsTab(appWithVault as any, mockPlugin as any);

      const paths = await (previewTab as any).collectVaultPaths();

      expect(paths.sort()).toEqual(["/notes.md", "/sub/nested.md"]);
    });
  });
});
