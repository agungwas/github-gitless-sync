import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    alias: {
      obsidian: path.resolve(__dirname, './vitest.setup.ts'),
      src: path.resolve(__dirname, './src'),
    }
  },
});
