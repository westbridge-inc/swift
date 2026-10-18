import { defineConfig } from 'vitest/config';
import { sideConfigTestEnv } from './src/lib/test-target-lock';

/** Service-free HTTP/auth regressions; no database/Redis global setup. */
export default defineConfig({
  test: {
    include: ['src/__tests__/web-taxi-pilot.unit.test.ts', 'src/modules/auth/browser-session.unit.test.ts'],
    // [AUD-G7-040] a disposable DB/Redis target, like vitest.config.ts.
    env: { ...sideConfigTestEnv(), NODE_ENV: 'test', DEV_OTP_BYPASS: '0' },
  },
});
