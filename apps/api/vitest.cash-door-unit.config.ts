import { defineConfig } from 'vitest/config';
import { sideConfigTestEnv } from './src/lib/test-target-lock';

/** Pure cash decisions and a transaction double: no database or Redis connections. */
export default defineConfig({
  test: {
    include: [
      'src/__tests__/cash-door-decision.unit.test.ts',
      'src/__tests__/cancel-missing-stock.unit.test.ts',
      'src/__tests__/money-units.test.ts',
      'src/__tests__/money-schema.test.ts',
      'src/__tests__/stock-single-writer.test.ts',
    ],
    fileParallelism: false,
    // [AUD-G7-040] a disposable DB/Redis target, like vitest.config.ts.
    env: { ...sideConfigTestEnv(), NODE_ENV: 'test' },
  },
});
