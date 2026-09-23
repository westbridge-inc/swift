import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: [
    'src/__tests__/service-catalog.unit.test.ts',
    'src/__tests__/doc1-registry-literals.test.ts',
  ] },
});
