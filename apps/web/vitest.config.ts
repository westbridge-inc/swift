import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mirrors apps/admin's config — same Next.js-app-in-happy-dom shape, so the two
// dashboards are tested the same way rather than two ways.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: 'next/link',
        replacement: fileURLToPath(new URL('./src/test/next-link.tsx', import.meta.url)),
      },
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url)),
      },
    ],
    dedupe: ['react', 'react-dom'],
    preserveSymlinks: true,
  },
  oxc: {
    jsx: {
      runtime: 'automatic',
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    env: {
      // apps/web/src/lib/auth.ts reads this at module load to build every URL.
      NEXT_PUBLIC_API_URL: 'http://vendor-api.test',
    },
  },
});
