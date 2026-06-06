export interface GitHubSyncSettings {
  firstSync: boolean;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  syncStrategy: "manual" | "interval";
  syncInterval: number;
  syncOnStartup: boolean;
  syncConfigDir: boolean;
  conflictHandling: "overwriteLocal" | "ask" | "overwriteRemote";
  conflictViewMode: "default" | "unified" | "split";
  showStatusBarItem: boolean;
  showSyncRibbonButton: boolean;
  showConflictsRibbonButton: boolean;
  enableLogging: boolean;
  syncOnWindowFocus: boolean;
  syncOnWindowBlur: boolean;
}

export const DEFAULT_SETTINGS: GitHubSyncSettings = {
  firstSync: true,
  githubToken: "",
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  syncStrategy: "manual",
  syncInterval: 1,
  syncOnStartup: false,
  syncConfigDir: false,
  conflictHandling: "ask",
  conflictViewMode: "default",
  showStatusBarItem: true,
  showSyncRibbonButton: true,
  showConflictsRibbonButton: true,
  enableLogging: false,
  syncOnWindowFocus: false,
  syncOnWindowBlur: false,
};

const COMMIT_TEMPLATE_KEY = "gitless-commit-message-template";
const COMMIT_TEMPLATE_DEFAULT = "Sync at {YYYY-MM-DD HH:mm}";

export function getCommitMessageTemplate(): string {
  return localStorage.getItem(COMMIT_TEMPLATE_KEY) ?? COMMIT_TEMPLATE_DEFAULT;
}

export function setCommitMessageTemplate(value: string): void {
  localStorage.setItem(COMMIT_TEMPLATE_KEY, value || COMMIT_TEMPLATE_DEFAULT);
}
