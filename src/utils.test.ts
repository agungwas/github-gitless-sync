import { describe, it, expect, vi } from "vitest";
import { hasTextExtension, retryUntil, sanitizePathForLocalFilesystem } from "./utils";

describe("utils", () => {
  describe("hasTextExtension", () => {
    it("should return true for valid text extensions", () => {
      expect(hasTextExtension("file.md")).toBe(true);
      expect(hasTextExtension("styles.css")).toBe(true);
      expect(hasTextExtension("data.json")).toBe(true);
      expect(hasTextExtension("log.txt")).toBe(true);
      expect(hasTextExtension("data.csv")).toBe(true);
      expect(hasTextExtension("script.js")).toBe(true);
    });

    it("should return false for non-text extensions", () => {
      expect(hasTextExtension("image.png")).toBe(false);
      expect(hasTextExtension("video.mp4")).toBe(false);
      expect(hasTextExtension("archive.zip")).toBe(false);
      expect(hasTextExtension("noextension")).toBe(false);
    });
  });

  describe("sanitizePathForLocalFilesystem", () => {
    it("replaces > with fullwidth equivalent", () => {
      expect(sanitizePathForLocalFilesystem("foo >100%.md")).toBe("foo ＞100%.md");
    });

    it("replaces < with fullwidth equivalent", () => {
      expect(sanitizePathForLocalFilesystem("Books/foo <bar>.md")).toBe("Books/foo ＜bar＞.md");
    });

    it("replaces : ? in separate segments", () => {
      expect(sanitizePathForLocalFilesystem("a:b/c?d.md")).toBe("a：b/c？d.md");
    });

    it("is a no-op for clean paths", () => {
      expect(sanitizePathForLocalFilesystem("clean/path.md")).toBe("clean/path.md");
    });

    it("replaces all illegal chars: * | \" \\", () => {
      expect(sanitizePathForLocalFilesystem('star*.md')).toBe("star＊.md");
      expect(sanitizePathForLocalFilesystem('pipe|.md')).toBe("pipe｜.md");
      expect(sanitizePathForLocalFilesystem('quote".md')).toBe("quote＂.md");
      expect(sanitizePathForLocalFilesystem('back\\.md')).toBe("back＼.md");
    });

    it("handles empty string", () => {
      expect(sanitizePathForLocalFilesystem("")).toBe("");
    });

    it("is a no-op for paths with no illegal chars", () => {
      expect(sanitizePathForLocalFilesystem("no/illegal/chars.md")).toBe("no/illegal/chars.md");
    });

    it("sanitizes each path segment independently", () => {
      expect(sanitizePathForLocalFilesystem("seg>a/seg>b.md")).toBe("seg＞a/seg＞b.md");
    });
  });

  describe("retryUntil", () => {
    it("should retry until condition is met", async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        return attempts;
      });

      const condition = (res: number) => res === 3;
      
      const result = await retryUntil(fn, condition, 5, 10, 1);
      
      expect(result).toBe(3);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should stop retrying when max retries is reached", async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        return attempts;
      });

      const condition = (res: number) => res === 10; // Never met within max retries
      
      const result = await retryUntil(fn, condition, 3, 10, 1);
      
      // Will execute 1 initial time + 3 retries = 4 times. Wait, maxRetries logic:
      // if (condition(result) || retries >= maxRetries) return result;
      // if maxRetries=3, it runs for retries=0, 1, 2, 3. So 4 times.
      expect(result).toBe(4);
      expect(fn).toHaveBeenCalledTimes(4);
    });
  });
});
