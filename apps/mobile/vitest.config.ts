import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';

// Reuse the workspace's installed DOM renderer; mobile installs no test runtime.
const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
const stackRequire = createRequire(createRequire(import.meta.url).resolve('@react-navigation/native-stack'));

// Keep unit tests in Node; the navigation project adds a real React renderer
// with native drawing mocked, without changing the unit tests' module runtime.
export default defineConfig({
  // Keep writes out of a borrowed node_modules install in release worktrees.
  cacheDir: './.vitest-cache',
  test: {
    projects: [
      { cacheDir: './.vitest-cache/unit', test: { name: 'unit', environment: 'node', include: ['src/**/*.test.ts'], exclude: ['src/**/*.navigation.test.ts'] } },
      {
        cacheDir: './.vitest-cache/navigation',
        resolve: { alias: [
          { find: /^@react-navigation\/elements$/, replacement: stackRequire.resolve('@react-navigation/elements') },
          { find: /^use-latest-callback$/, replacement: new URL('../../src/index.ts', `file://${stackRequire.resolve('use-latest-callback')}`).pathname },
          { find: /^react$/, replacement: webRequire.resolve('react') },
          { find: /^react\/jsx-runtime$/, replacement: webRequire.resolve('react/jsx-runtime') },
          { find: /^react-dom\/client$/, replacement: webRequire.resolve('react-dom/client') },
        ] },
        test: {
          name: 'navigation', environment: 'node', include: ['src/**/*.navigation.test.ts'],
          setupFiles: ['./vitest.navigation.setup.ts'],
          // Native drawing is mocked, while navigation and React run together.
          server: { deps: { inline: true } },
        },
      },
    ],
  },
});
