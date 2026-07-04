import { describe, it, expect } from "vitest";
import { matchesGlobPattern, isExcludedPath } from "./sync-filters";

describe("sync-filters", () => {
  describe("matchesGlobPattern", () => {
    it("** matches any depth, not a wrong extension", () => {
      expect(matchesGlobPattern("**/main.js", ".obsidian/plugins/foo/main.js")).toBe(true);
      expect(matchesGlobPattern("**/main.js", ".obsidian/plugins/foo/bar/main.js")).toBe(true);
      expect(matchesGlobPattern("**/main.js", "mainjs.md")).toBe(false);
      expect(matchesGlobPattern("**/main.js", "main.jsx")).toBe(false);
    });

    it("single * does not cross a path segment boundary", () => {
      expect(matchesGlobPattern(".obsidian/plugins/*/main.js", ".obsidian/plugins/foo/main.js")).toBe(true);
      expect(matchesGlobPattern(".obsidian/plugins/*/main.js", ".obsidian/plugins/foo/bar/main.js")).toBe(false);
    });

    it("trailing slash matches the directory and everything under it", () => {
      expect(matchesGlobPattern(".obsidian/plugins/foo/", ".obsidian/plugins/foo/main.js")).toBe(true);
      expect(matchesGlobPattern(".obsidian/plugins/foo/", ".obsidian/plugins/foo/bar/data.json")).toBe(true);
      expect(matchesGlobPattern(".obsidian/plugins/foo/", ".obsidian/plugins/foobar/main.js")).toBe(false);
    });

    it("never hangs on a wildcard-heavy pattern (ReDoS regression)", () => {
      const pathologicalPattern = "*a*a*a*a*a*a*a*a*a*a*a*ab";
      const nonMatchingInput = "a".repeat(32);
      const start = Date.now();
      const result = matchesGlobPattern(pathologicalPattern, nonMatchingInput);
      const elapsedMs = Date.now() - start;
      expect(result).toBe(false);
      expect(elapsedMs).toBeLessThan(100);
    });
  });

  describe("isExcludedPath", () => {
    it("ignores blank/whitespace-only entries in either array", () => {
      expect(isExcludedPath("x/main.js", ["", "**/main.js", "  "], [])).toBe(true);
      expect(isExcludedPath("x/main.js", ["**/main.js"], ["", "  "])).toBe(true);
    });

    it("never throws on a pathological pattern and treats it as non-matching", () => {
      expect(() => isExcludedPath("x/main.js", ["["], [])).not.toThrow();
      expect(isExcludedPath("x/main.js", ["["], [])).toBe(false);
    });

    it("include pattern overrides a matching exclude pattern", () => {
      expect(
        isExcludedPath("gitless/plugins/foo/main.js", ["**/main.js"], ["gitless/**/main.js"]),
      ).toBe(false);
    });

    it("exclude applies when include pattern targets a different path", () => {
      expect(
        isExcludedPath("other/plugins/foo/main.js", ["**/main.js"], ["gitless/**/main.js"]),
      ).toBe(true);
    });

    it("empty include list never suppresses a matching exclude", () => {
      expect(isExcludedPath("gitless/plugins/foo/main.js", ["**/main.js"], [])).toBe(true);
    });

    it("include overrides a directory-level (trailing slash) exclude, no tree-pruning limitation", () => {
      expect(
        isExcludedPath("gitless/plugins/foo/main.js", ["gitless/"], ["gitless/**/main.js"]),
      ).toBe(false);
    });

    it("result is independent of array construction/edit order", () => {
      const a = isExcludedPath("gitless/plugins/foo/main.js", ["**/main.js", "other/"], ["gitless/**/main.js"]);
      const b = isExcludedPath("gitless/plugins/foo/main.js", ["other/", "**/main.js"], ["gitless/**/main.js"]);
      expect(a).toBe(b);
      expect(a).toBe(false);
    });

    it("returns false when no pattern matches at all", () => {
      expect(isExcludedPath("notes/foo.md", ["**/main.js"], [])).toBe(false);
    });
  });

  describe("pattern-length cap (plan-harden-exclude-patterns)", () => {
    it("an over-long exclude pattern is silently ignored (never excludes)", () => {
      const tail = "a".repeat(600);
      const overLongPattern = `**/${tail}`;
      const path = `notes/${tail}`;
      // Sanity: this pattern WOULD match if length weren't capped.
      expect(isExcludedPath(path, [overLongPattern], [])).toBe(false);
    });

    it("an over-long include pattern is silently ignored (never overrides an exclude)", () => {
      const overLongIncludePattern = `gitless/${"*".repeat(600)}`;
      expect(isExcludedPath("gitless/main.js", ["**/main.js"], [overLongIncludePattern])).toBe(true);
    });

    it("a pattern exactly at the length threshold still matches (boundary)", () => {
      const atThreshold = "*".repeat(500);
      const overThreshold = "*".repeat(501);
      expect(isExcludedPath("notes.md", [atThreshold], [])).toBe(true);
      expect(isExcludedPath("notes.md", [overThreshold], [])).toBe(false);
    });
  });
});
