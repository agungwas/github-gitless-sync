import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getCommitMessageTemplate, setCommitMessageTemplate, DEFAULT_SETTINGS } from "./settings";

describe("settings", () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  describe("Commit Message Template", () => {
    it("should return default template if none is set", () => {
      const template = getCommitMessageTemplate();
      expect(template).toBe("Sync at {YYYY-MM-DD HH:mm}");
    });

    it("should return the saved template", () => {
      localStorage.setItem("gitless-commit-message-template", "My custom template {deviceName}");
      const template = getCommitMessageTemplate();
      expect(template).toBe("My custom template {deviceName}");
    });

    it("should save a new template", () => {
      setCommitMessageTemplate("New template");
      expect(localStorage.getItem("gitless-commit-message-template")).toBe("New template");
    });

    it("should fallback to default if empty string is passed to setCommitMessageTemplate", () => {
      setCommitMessageTemplate("");
      expect(localStorage.getItem("gitless-commit-message-template")).toBe("Sync at {YYYY-MM-DD HH:mm}");
    });
  });

  describe("DEFAULT_SETTINGS", () => {
    it("should have correct default values", () => {
      expect(DEFAULT_SETTINGS.firstSync).toBe(true);
      expect(DEFAULT_SETTINGS.githubBranch).toBe("main");
      expect(DEFAULT_SETTINGS.syncStrategy).toBe("manual");
      expect(DEFAULT_SETTINGS.conflictHandling).toBe("ask");
    });

    it("should default excludePatterns and includePatterns to empty arrays", () => {
      expect(DEFAULT_SETTINGS.excludePatterns).toEqual([]);
      expect(DEFAULT_SETTINGS.includePatterns).toEqual([]);
    });
  });
});
