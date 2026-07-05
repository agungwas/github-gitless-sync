import {
  PluginSettingTab,
  App,
  Setting,
  TextComponent,
  Modal,
  Notice,
} from "obsidian";
import GitHubSyncPlugin from "src/main";
import { copyToClipboard } from "src/utils";
import { getCommitMessageTemplate, setCommitMessageTemplate } from "src/settings/settings";

const METADATA_CLEANUP_DEBOUNCE_MS = 400;

/**
 * Splits every vault path into "will sync" / "excluded" per the given
 * predicate -- pure so it's testable without a Modal or real vault.
 */
export function bucketPathsByPattern(
  paths: string[],
  isPathSyncable: (path: string) => boolean,
): { willSync: string[]; excluded: string[] } {
  const willSync: string[] = [];
  const excluded: string[] = [];
  for (const path of paths) {
    if (isPathSyncable(path)) {
      willSync.push(path);
    } else {
      excluded.push(path);
    }
  }
  return { willSync, excluded };
}

class PatternPreviewModal extends Modal {
  constructor(
    app: App,
    private willSync: string[],
    private excluded: string[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Pattern preview" });

    contentEl.createEl("h3", { text: `Will sync (${this.willSync.length})` });
    const willSyncList = contentEl.createEl("ul");
    (this.willSync.length ? this.willSync : ["None"]).forEach((path) =>
      willSyncList.createEl("li", { text: path }),
    );

    contentEl.createEl("h3", {
      text: `Excluded by pattern (${this.excluded.length})`,
    });
    const excludedList = contentEl.createEl("ul");
    (this.excluded.length ? this.excluded : ["None"]).forEach((path) =>
      excludedList.createEl("li", { text: path }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export default class GitHubSyncSettingsTab extends PluginSettingTab {
  plugin: GitHubSyncPlugin;
  private metadataCleanupTimer: number | undefined;

  constructor(app: App, plugin: GitHubSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Debounces the expensive full-metadata-store rescan triggered by pattern
   * edits -- settings themselves are still saved immediately on every
   * keystroke (see renderPatternList), only this reconciliation pass waits
   * for typing to pause.
   */
  private scheduleMetadataCleanup() {
    if (this.metadataCleanupTimer !== undefined) {
      window.clearTimeout(this.metadataCleanupTimer);
    }
    this.metadataCleanupTimer = window.setTimeout(async () => {
      await this.plugin.syncManager.removeExcludedFromMetadata();
    }, METADATA_CLEANUP_DEBOUNCE_MS);
  }

  /**
   * Renders a dynamic list of glob pattern rows plus a trailing "+ Add
   * pattern" button. Typing in a row never rebuilds the settings tab (only
   * saves + debounces metadata cleanup) so it never steals focus; growing or
   * shrinking the list (button click / row delete) does rebuild, since
   * there's nothing being typed into at that moment. Shared by the Sync
   * Exclusions and Sync Inclusions lists.
   */
  private renderPatternList(
    containerEl: HTMLElement,
    patterns: string[],
    placeholder: string,
  ) {
    const onPatternDeleted = async () => {
      await this.plugin.saveSettings();
      await this.plugin.syncManager.removeExcludedFromMetadata();
    };

    patterns.forEach((pattern, index) => {
      new Setting(containerEl)
        .addText((text) =>
          text
            .setPlaceholder(placeholder)
            .setValue(pattern)
            .onChange(async (value) => {
              patterns[index] = value;
              await this.plugin.saveSettings();
              this.scheduleMetadataCleanup();
            }),
        )
        .addButton((button) =>
          button
            .setIcon("trash")
            .setTooltip("Remove")
            .onClick(async () => {
              patterns.splice(index, 1);
              await onPatternDeleted();
              this.display();
            }),
        );
    });

    new Setting(containerEl).addButton((button) =>
      button.setButtonText("+ Add pattern").onClick(() => {
        patterns.push("");
        this.display();
      }),
    );
  }

  /**
   * Recursively walks the vault root and returns every file path -- same
   * stack-based walk shape as SyncManager.reconcileConfigDirFiles(), just
   * starting from the vault root instead of configDir.
   */
  private async collectVaultPaths(): Promise<string[]> {
    const vault = this.app.vault;
    const paths: string[] = [];
    const folders = [vault.getRoot().path];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (!folder) continue;
      const res = await vault.adapter.list(folder);
      paths.push(...res.files);
      folders.push(...res.folders);
    }
    return paths;
  }

  /**
   * Local-only preview: no GitHub call, just the vault walk + current
   * exclude/include patterns via SyncManager.isPathSyncable().
   */
  private async showPatternPreview(): Promise<void> {
    const paths = await this.collectVaultPaths();
    const { willSync, excluded } = bucketPathsByPattern(paths, (path) =>
      this.plugin.syncManager.isPathSyncable(path),
    );
    new PatternPreviewModal(this.app, willSync, excluded).open();
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl).setName("Remote Repository").setHeading();

    let tokenInput: TextComponent;
    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc(
        "A personal access token or a fine-grained token with read and write access to your repository",
      )
      .addButton((button) =>
        button.setIcon("eye-off").onClick((e) => {
          if (tokenInput.inputEl.type === "password") {
            tokenInput.inputEl.type = "text";
            button.setIcon("eye");
          } else {
            tokenInput.inputEl.type = "password";
            button.setIcon("eye-off");
          }
        }),
      )
      .addText((text) => {
        text
          .setPlaceholder("Token")
          .setValue(this.plugin.settings.githubToken)
          .onChange(async (value) => {
            this.plugin.settings.githubToken = value;
            await this.plugin.saveSettings();
          }).inputEl.type = "password";
        tokenInput = text;
      });

    new Setting(containerEl)
      .setName("Owner")
      .setDesc("Owner of the repository to sync")
      .addText((text) =>
        text
          .setPlaceholder("Owner")
          .setValue(this.plugin.settings.githubOwner)
          .onChange(async (value) => {
            this.plugin.settings.githubOwner = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Repository")
      .setDesc("Name of the repository to sync")
      .addText((text) =>
        text
          .setPlaceholder("Repository")
          .setValue(this.plugin.settings.githubRepo)
          .onChange(async (value) => {
            this.plugin.settings.githubRepo = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Repository branch")
      .setDesc("Branch to sync")
      .addText((text) =>
        text
          .setPlaceholder("Branch name")
          .setValue(this.plugin.settings.githubBranch)
          .onChange(async (value) => {
            this.plugin.settings.githubBranch = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Sync").setHeading();

    const syncStrategies = {
      manual: "Manually",
      interval: "On Interval",
    };
    const uploadStrategySetting = new Setting(containerEl)
      .setName("Sync strategy")
      .setDesc("How to sync files with remote repository");

    let syncInterval = "1";
    if (this.plugin.settings.syncInterval) {
      syncInterval = this.plugin.settings.syncInterval.toString();
    }
    const intervalSettings = new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("Interval in minutes between automatic syncs")
      .addText((text) =>
        text
          .setPlaceholder("Interval in minutes")
          .setValue(syncInterval)
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = parseInt(value) || 1;
            await this.plugin.saveSettings();
            // We need to restart the interval if the value is changed
            this.plugin.restartSyncInterval();
          }),
      );
    intervalSettings.setDisabled(
      this.plugin.settings.syncStrategy !== "interval",
    );

    uploadStrategySetting.addDropdown((dropdown) =>
      dropdown
        .addOptions(syncStrategies)
        .setValue(this.plugin.settings.syncStrategy)
        .onChange(async (value: keyof typeof syncStrategies) => {
          intervalSettings.setDisabled(value !== "interval");
          this.plugin.settings.syncStrategy = value;
          await this.plugin.saveSettings();
          if (value === "interval") {
            this.plugin.startSyncInterval();
          } else {
            this.plugin.stopSyncInterval();
          }
        }),
    );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Download up to date files from remote on startup")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStartup = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync on window focus")
      .setDesc("Automatically sync when Obsidian gains focus")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncOnWindowFocus)
          .onChange(async (value) => {
            this.plugin.settings.syncOnWindowFocus = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync on window blur")
      .setDesc("Automatically sync when Obsidian loses focus (e.g. switching apps)")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncOnWindowBlur)
          .onChange(async (value) => {
            this.plugin.settings.syncOnWindowBlur = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync configs")
      .setDesc("Sync Vault config folder with remote repository")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncConfigDir)
          .onChange(async (value) => {
            this.plugin.settings.syncConfigDir = value;
            if (value) {
              await this.plugin.syncManager.addConfigDirToMetadata();
            } else {
              await this.plugin.syncManager.removeConfigDirFromMetadata();
            }
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync exclusions")
      .setDesc("Files matching these patterns are never synced.")
      .setHeading();
    this.renderPatternList(containerEl, this.plugin.settings.excludePatterns, "e.g. **/main.js");

    new Setting(containerEl)
      .setName("Sync inclusions")
      .setDesc(
        "Files matching these patterns are always synced, even if also matched by an exclusion above.",
      )
      .setHeading();
    this.renderPatternList(
      containerEl,
      this.plugin.settings.includePatterns,
      "e.g. gitless/**/main.js",
    );

    new Setting(containerEl)
      .setName("Preview pattern matches")
      .setDesc(
        "Shows which vault files will sync vs. be excluded under your current patterns. Local check only, no GitHub call.",
      )
      .addButton((button) =>
        button.setButtonText("Preview").onClick(() => this.showPatternPreview()),
      );

    new Setting(containerEl).setName("Device Specific").setHeading();

    new Setting(containerEl)
      .setName("Commit message template")
      .setDesc(
        "Template for GitHub commit messages. This is stored on the device and will not be synced to other devices. " +
          "Use any moment.js format token in braces for date/time, e.g. {YYYY-MM-DD HH:mm}.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Sync at {YYYY-MM-DD HH:mm}")
          .setValue(getCommitMessageTemplate())
          .onChange((value) => {
            setCommitMessageTemplate(value);
          }),
      );

    const conflictHandlingOptions = {
      overwriteLocal: "Overwrite local file",
      ask: "Ask",
      overwriteRemote: "Overwrite remote file",
    };
    new Setting(containerEl)
      .setName("Conflict handling")
      .setDesc(
        `What to do in case remote and local files conflict
        when downloading from GitHub repository`,
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(conflictHandlingOptions)
          .setValue(this.plugin.settings.conflictHandling)
          .onChange(async (value: keyof typeof conflictHandlingOptions) => {
            this.plugin.settings.conflictHandling = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName("Interface").setHeading();

    new Setting(containerEl)
      .setName("Show status bar item")
      .setDesc("Displays the status bar item that show the file sync status")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showStatusBarItem)
          .onChange((value) => {
            this.plugin.settings.showStatusBarItem = value;
            this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Show sync button")
      .setDesc("Displays a ribbon button to sync files")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showSyncRibbonButton)
          .onChange((value) => {
            this.plugin.settings.showSyncRibbonButton = value;
            this.plugin.saveSettings();
            if (value) {
              this.plugin.showSyncRibbonIcon();
            } else {
              this.plugin.hideSyncRibbonIcon();
            }
          });
      });

    new Setting(containerEl)
      .setName("Show conflicts view button")
      .setDesc("Displays a ribbon button that opens the conflicts view")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showConflictsRibbonButton)
          .onChange((value) => {
            this.plugin.settings.showConflictsRibbonButton = value;
            this.plugin.saveSettings();
            if (value) {
              this.plugin.showConflictsRibbonIcon();
            } else {
              this.plugin.hideConflictsRibbonIcon();
            }
          });
      });

    const diffModeOptions = {
      default: "Default",
      unified: "Unified",
      split: "Split",
    };
    new Setting(containerEl)
      .setName("Conflict resolution view mode")
      .setDesc("Set which diff view mode should be shown in case of conflicts")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(diffModeOptions)
          .setValue(this.plugin.settings.conflictViewMode)
          .onChange(async (value: keyof typeof diffModeOptions) => {
            this.plugin.settings.conflictViewMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName("Extra").setHeading();

    new Setting(containerEl)
      .setName("Enable logging")
      .setDesc(
        "If enabled logs from this plugin will be saved in a file in your config directory.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableLogging)
          .onChange((value) => {
            this.plugin.settings.enableLogging = value;
            if (value) {
              this.plugin.logger.enable();
            } else {
              this.plugin.logger.disable();
            }
            this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Copy logs")
      .setDesc("Copy the log file content, this is useful to report bugs.")
      .addButton((button) => {
        button.setButtonText("Copy").onClick(async () => {
          const logs: string = await this.plugin.logger.read();
          try {
            await copyToClipboard(logs);
            new Notice("Logs copied", 5000);
          } catch (err) {
            new Notice(`Failed copying logs: ${err}`, 10000);
          }
        });
      });

    new Setting(containerEl)
      .setName("Clean logs")
      .setDesc("Delete all existing logs.")
      .addButton((button) => {
        button.setButtonText("Clean").onClick(async () => {
          await this.plugin.logger.clean();
        });
      });

    new Setting(containerEl)
      .setName("Reset")
      .setDesc("Reset the plugin settings and metadata")
      .addButton((button) => {
        button
          .setButtonText("RESET")
          .setCta()
          .onClick(() => {
            const modal = new Modal(this.plugin.app);
            modal.setTitle("Are you sure?");
            modal.setContent(
              "This will completely delete all sync metadata and plugin settings.\n" +
                "You'll have to repeat the first sync if you want to use the plugin again.",
            );
            new Setting(modal.contentEl);
            new Setting(modal.contentEl)
              .addButton((btn) =>
                btn
                  .setButtonText("Reset")
                  .setCta()
                  .onClick(async () => {
                    await this.plugin.reset();
                    modal.close();
                  }),
              )
              .addButton((btn) =>
                btn.setButtonText("Cancel").onClick(() => {
                  modal.close();
                }),
              );
            modal.open();
          });
      });
  }
}
