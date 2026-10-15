import { MANIFEST_FILE_NAME } from "../metadata-store";
import { LOG_FILE_NAME } from "../logger";
import { isExcludedPath } from "../sync-filters";

export type PathDecision = {
  transport: "share" | "local" | "legacy";
  owner: "managed" | "custom" | "self" | "ordinary" | "internal";
  cleanup: "none" | "binary-migration" | "legacy-exclusion";
  settingsOptOut: boolean;
};

export interface PolicyContext {
  configDir: string;
  syncConfigDir: boolean;
  syncCommunityPlugins: boolean;
  excludePatterns: string[];
  includePatterns: string[];
  selfPluginId: string;
}

const STAGING_DIR = ".gitless-plugin-staging";
const COMMUNITY_PLUGINS_FILE = "community-plugins.json";

function decision(
  transport: PathDecision["transport"],
  owner: PathDecision["owner"],
  cleanup: PathDecision["cleanup"] = "none",
  settingsOptOut = false,
): PathDecision {
  return { transport, owner, cleanup, settingsOptOut };
}

function isUnsafePath(path: string): boolean {
  return (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === ".." || segment === ".")
  );
}

function customPluginId(pattern: string, configDir: string): string | null {
  const normalized = pattern.replace(/\/+$/, "");
  const prefix = `${configDir}/plugins/`;
  if (!normalized.startsWith(prefix)) return null;
  const pluginPath = normalized.slice(prefix.length).split("/");
  const pluginId = pluginPath[0];
  if (!pluginId || /[*?{}]/.test(pluginId) || pluginId === "." || pluginId === "..") return null;
  if (pluginPath.length === 1 || (pluginPath.length === 2 && pluginPath[1] === "**")) {
    return pluginId;
  }
  return null;
}

function hasCustomDirectoryException(path: string, context: PolicyContext): boolean {
  const prefix = `${context.configDir}/plugins/`;
  if (!path.startsWith(prefix)) return false;
  const pluginId = path.slice(prefix.length).split("/")[0];
  if (!pluginId || pluginId === context.selfPluginId) return false;
  return context.includePatterns.some((pattern) => customPluginId(pattern, context.configDir) === pluginId);
}

function isExactSettingsOptOut(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => pattern.replace(/\/+$/, "") === path);
}

function isManagedPluginFile(path: string, context: PolicyContext): boolean {
  const configPrefix = `${context.configDir}/`;
  const pluginPrefix = `${context.configDir}/plugins/`;
  if (!path.startsWith(configPrefix)) return false;
  const relativePath = path.slice(configPrefix.length);
  return (
    relativePath === COMMUNITY_PLUGINS_FILE ||
    (path.startsWith(pluginPrefix) && /\/manifest\.json$/.test(path) && path.slice(pluginPrefix.length).split("/").length === 2) ||
    (path.startsWith(pluginPrefix) && /\/data\.json$/.test(path) && path.slice(pluginPrefix.length).split("/").length === 2)
  );
}

export function classifyPath(path: string, context: PolicyContext): PathDecision {
  if (isUnsafePath(path)) return decision("local", "internal");

  const configPrefix = `${context.configDir}/`;
  const relativePath = path.startsWith(configPrefix) ? path.slice(configPrefix.length) : "";
  const filename = path.split("/").at(-1) ?? "";
  if (
    relativePath.startsWith(`${STAGING_DIR}/`) ||
    path === `${context.configDir}/${MANIFEST_FILE_NAME}` ||
    path === `${context.configDir}/${LOG_FILE_NAME}` ||
    path === `${context.configDir}/workspace.json` ||
    path === `${context.configDir}/workspace-mobile.json`
  ) {
    return decision("local", "internal");
  }

  const selfPrefix = `${context.configDir}/plugins/${context.selfPluginId}/`;
  if (path.startsWith(selfPrefix)) return decision(context.syncConfigDir ? "share" : "local", "self");

  if (context.syncCommunityPlugins) {
    if (hasCustomDirectoryException(path, context)) return decision("legacy", "custom");

    if (isManagedPluginFile(path, context)) {
      const settingsOptOut = path.endsWith("/data.json") && isExactSettingsOptOut(path, context.excludePatterns);
      return settingsOptOut
        ? decision("local", "managed", "none", true)
        : decision("share", "managed");
    }

    const pluginPrefix = `${context.configDir}/plugins/`;
    if (path.startsWith(pluginPrefix) && path.slice(pluginPrefix.length).includes("/")) {
      return decision("local", "managed", "binary-migration");
    }
  }

  const configPath = path.startsWith(configPrefix);
  if (isExcludedPath(path, context.excludePatterns, context.includePatterns)) {
    return decision("local", "ordinary", "legacy-exclusion");
  }
  if (configPath && !context.syncConfigDir) return decision("local", "ordinary");
  if (configPath && filename.startsWith(".")) return decision("local", "ordinary");
  return decision("share", "ordinary");
}
