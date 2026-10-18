import { defineConfig } from 'vitest/config';
import { sideConfigTestEnv } from './src/lib/test-target-lock';

// Pure print rendering/decoding: no application boot, database or Redis.
export default defineConfig({
  test: {
    // [AUD-G7-040] a disposable DB/Redis target, like vitest.config.ts.
    env: sideConfigTestEnv(), environment: 'node', include: ['src/__tests__/qr-assets.test.ts', 'src/__tests__/qr-print-proof.test.ts'], testTimeout: 30_000 },
});
