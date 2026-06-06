import { describe, it, expect, vi } from "vitest";
import { hasTextExtension, retryUntil } from "./utils";

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
