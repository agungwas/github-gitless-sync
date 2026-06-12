import { vi } from 'vitest';

// Mock localStorage
const localStorageMock = (function () {
  let store: Record<string, string> = {};

  return {
    getItem(key: string) {
      return store[key] || null;
    },
    setItem(key: string, value: string) {
      store[key] = value.toString();
    },
    removeItem(key: string) {
      delete store[key];
    },
    clear() {
      store = {};
    }
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true
});

export const base64ToArrayBuffer = (s: string) => {
  const binaryString = atob(s);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
};

export const Notice = vi.fn();
export const normalizePath = (path: string) => path;
export class Plugin {}
export class ItemView {}
export const Platform = { isMobile: false };
export class WorkspaceLeaf {}
export class PluginSettingTab {}
