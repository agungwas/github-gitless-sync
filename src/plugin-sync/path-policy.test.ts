import { describe, expect, it } from "vitest";
import * as pathPolicy from "./path-policy";
import type { PolicyContext } from "./path-policy";

const context = {
  configDir: ".obsidian",
  syncConfigDir: false,
  syncCommunityPlugins: true,
  excludePatterns: [".obsidian/plugins/"],
  includePatterns: [".obsidian/plugins/gitless/"],
  selfPluginId: "gitless",
};

function classify(path: string, overrides: Record<string, unknown> = {}) {
  const classifyPath = (pathPolicy as unknown as Record<string, unknown>).classifyPath;
  expect(classifyPath).toBeTypeOf("function");
  return (classifyPath as (path: string, context: PolicyContext) => unknown)(path, { ...context, ...overrides } as PolicyContext);
}

describe("plugin sync path policy", () => {
  it("shares plugin intent files even when general config sync and broad excludes are off", () => {
    expect(classify(".obsidian/community-plugins.json")).toMatchObject({ transport: "share", owner: "managed" });
    expect(classify(".obsidian/plugins/quickadd/manifest.json")).toMatchObject({ transport: "share", owner: "managed" });
    expect(classify(".obsidian/plugins/quickadd/data.json")).toMatchObject({ transport: "share", owner: "managed" });
  });

  it("keeps ordinary plugin binaries local despite broad includes", () => {
    expect(classify(".obsidian/plugins/quickadd/main.js", {
      includePatterns: [".obsidian/plugins/**/main.js"],
    })).toMatchObject({ transport: "local", owner: "managed", cleanup: "binary-migration" });
  });

  it("preserves exact settings opt-out and custom full-directory exceptions", () => {
    expect(classify(".obsidian/plugins/quickadd/data.json", {
      excludePatterns: [".obsidian/plugins/quickadd/data.json"],
    })).toMatchObject({ transport: "local", owner: "managed", settingsOptOut: true });
    expect(classify(".obsidian/plugins/custom/main.js", {
      includePatterns: [".obsidian/plugins/custom/"],
    })).toMatchObject({ transport: "legacy", owner: "custom" });
    expect(classify(".obsidian/plugins/quickadd/main.js", {
      includePatterns: [".obsidian/plugins/quickadd/"],
    })).toMatchObject({ transport: "legacy", owner: "custom" });
  });

  it("shares Gitless package only when config sync is on and rejects staging or traversal paths", () => {
    expect(classify(".obsidian/plugins/gitless/main.js", { syncConfigDir: true })).toMatchObject({ transport: "share", owner: "self" });
    expect(classify(".obsidian/plugins/gitless/main.js", { syncConfigDir: false })).toMatchObject({ transport: "local", owner: "self" });
    expect(classify(".obsidian/plugins/gitless/data.json", { syncCommunityPlugins: false, syncConfigDir: false }))
      .toMatchObject({ transport: "local", owner: "self" });
    expect(classify(".obsidian/.gitless-plugin-staging/gitless/main.js")).toMatchObject({ transport: "local", owner: "internal" });
    expect(classify(".obsidian/plugins/../other/main.js")).toMatchObject({ transport: "local", owner: "internal" });
  });

  it("keeps feature-off filtering under legacy settings", () => {
    expect(classify(".obsidian/plugins/quickadd/manifest.json", { syncCommunityPlugins: false }))
      .toMatchObject({ transport: "local", owner: "ordinary" });
    expect(classify("notes/readme.md", { syncCommunityPlugins: false, syncConfigDir: true }))
      .toMatchObject({ transport: "share", owner: "ordinary" });
    expect(classify(".obsidian/plugins/gitless/main.js", { syncCommunityPlugins: false, syncConfigDir: true }))
      .toMatchObject({ transport: "share", owner: "self" });
  });
});
