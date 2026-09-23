import { defineConfig } from 'vitest/config';

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
    env: { NODE_ENV: 'test', DEV_OTP_BYPASS: '0' },
  },
});
