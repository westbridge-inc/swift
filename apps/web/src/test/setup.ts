import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { TEST_MAPTILER_KEY } from './map-tiles-fixture';

// [WEB-TILES] A real build inlines the MapTiler browser key; tests draw every
// map with a made-up one (lib/map-tiles.ts reads it at render).
process.env.NEXT_PUBLIC_MAPTILER_KEY = TEST_MAPTILER_KEY;

afterEach(() => {
  cleanup();
  // A test file may run in Node (`@vitest-environment node`), where there is no
  // browser storage to clear; everywhere else this clears it exactly as before.
  globalThis.localStorage?.clear();
  // [FLOW-QA F6] sign-up keeps a per-tab draft (lib/signup-draft): no test inherits another's.
  // (a test may have stubbed storage with a blocked stand-in: that one is left alone)
  try { if (typeof globalThis.sessionStorage?.clear === 'function') globalThis.sessionStorage.clear(); } catch { /* blocked */ }
});
