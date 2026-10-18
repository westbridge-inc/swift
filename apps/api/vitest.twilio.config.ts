import { defineConfig } from 'vitest/config';
import { sideConfigTestEnv } from './src/lib/test-target-lock';

/** SMS credential and boot-contract tests run without the DB/Redis target lock. */
export default defineConfig({
  test: {
    root: '.',
    include: [
      'src/__tests__/twilio-sms-credentials.test.ts',
      'src/__tests__/boot-config.test.ts',
      'src/__tests__/email-provider-honesty.test.ts',
      'src/__tests__/secret-canary.test.ts',
    ],
    fileParallelism: false,
    // [AUD-G7-040] a disposable DB/Redis target, like vitest.config.ts.
    env: { ...sideConfigTestEnv(), NODE_ENV: 'test', DEV_OTP_BYPASS: '0' },
  },
});
