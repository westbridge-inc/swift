import { defineConfig } from 'vitest/config';

/** Manual-only admission and the policy graded against it use synthetic inputs; no database or provider calls. */
export default defineConfig({
  test: {
    include: [
      'src/__tests__/kyc-launch-policy.test.ts', 'src/__tests__/boot-config.test.ts',
      'src/__tests__/legal-launch-processors.test.ts', 'src/__tests__/legal-ai-claim.test.ts',
      'src/__tests__/legal-human-review-claim.test.ts', 'src/__tests__/legal-version-binding.test.ts',
      'src/__tests__/doc1-processor-register.test.ts',
    ],
    fileParallelism: false,
    // Same as the main config: the boot suite spawns the preflight CLI per case.
    testTimeout: 30000,
    env: { NODE_ENV: 'test', DEV_OTP_BYPASS: '0' },
  },
});
