import { defineConfig } from 'vitest/config';
import { sideConfigTestEnv } from './src/lib/test-target-lock';
export default defineConfig({
  test: {
    // [AUD-G7-040] a disposable DB/Redis target, like vitest.config.ts.
    env: sideConfigTestEnv(), environment: 'node', include: [
    'src/__tests__/service-catalog.unit.test.ts',
    'src/__tests__/doc1-registry-literals.test.ts',
  ] },
});
