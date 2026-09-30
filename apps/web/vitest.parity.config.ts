import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// Portable mutation-proof runner for fresh checkouts. Keep Vite's cache in
// this worktree, never in the shared symlinked dependency directory.
export default mergeConfig(base, defineConfig({
  cacheDir: fileURLToPath(new URL('../../.vitest-cache', import.meta.url)),
}));
