import { defineConfig } from 'vitest/config';

// Explicitly service-free tests only (storage adapter uses its own temp files).
// The database suite keeps its target lock.
export default defineConfig({
  test: {
    include: [
      'src/__tests__/verification-object-containment.unit.test.ts',
      'src/__tests__/identity-signal-*.unit.test.ts',
      'src/__tests__/doc1-expiry-plausibility.test.ts',
      'src/__tests__/doc1-fx-peg.test.ts',
      'src/__tests__/doc1-no-face-recognition-deps.test.ts',
      'src/__tests__/doc1-processor-register.test.ts',
      'src/__tests__/doc1-registry-literals.test.ts',
      'src/__tests__/document-durability.test.ts',
      'src/__tests__/minimisation-allowlist.test.ts',
      'src/__tests__/mover-pointer-census.test.ts',
      'src/__tests__/inv15-expiry-not-short-circuited.test.ts',
      'src/__tests__/admin-audit-inline-census.test.ts',
      'src/__tests__/integrity-founder-guard.test.ts',
      'src/__tests__/admin-config-truth.test.ts',
      'src/__tests__/image-metadata-strip.test.ts',
      'src/__tests__/order-status-single-source.test.ts',
    ],
    fileParallelism: false,
    env: { NODE_ENV: 'test', KYC_PROVIDER: 'manual' },
  },
});
