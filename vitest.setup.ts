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
export class TextFileView {}
export class TAbstractFile { path = ""; }
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile { children: TAbstractFile[] = []; }
export class Modal {
  app: unknown;
  contentEl = { createEl: () => ({ createEl: () => ({}) }), empty: () => {} };
  constructor(app: unknown) { this.app = app; }
  setTitle() { return this; }
  setContent() { return this; }
  open() {}
  close() {}
}
export const moment = vi.fn().mockReturnValue({ format: vi.fn((x: string) => x) });
