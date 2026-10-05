import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  // A test file may run in Node (`@vitest-environment node`), where there is no
  // browser storage to clear; everywhere else this clears it exactly as before.
  globalThis.localStorage?.clear();
});
