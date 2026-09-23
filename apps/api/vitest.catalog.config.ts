import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['src/modules/services/service-catalog.unit.test.ts'] },
});
