import { defineConfig } from 'vitest/config';

// Pure print rendering/decoding: no application boot, database or Redis.
export default defineConfig({
  test: { environment: 'node', include: ['src/__tests__/qr-assets.test.ts', 'src/__tests__/qr-print-proof.test.ts'], testTimeout: 30_000 },
});
