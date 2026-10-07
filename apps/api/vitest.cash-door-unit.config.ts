import { defineConfig } from 'vitest/config';

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
    env: { NODE_ENV: 'test' },
  },
});
