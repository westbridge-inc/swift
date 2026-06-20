import { defineConfig } from 'vitest/config';

// Pure-logic unit tests only (lib helpers). No RN/expo renderer — anything that
// touches native modules is mocked in the test file (e.g. ../services/api).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
