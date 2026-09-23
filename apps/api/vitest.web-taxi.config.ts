import { defineConfig } from 'vitest/config';

/** Service-free HTTP/auth regressions; no database/Redis global setup. */
export default defineConfig({
  test: {
    include: ['src/__tests__/web-taxi-pilot.unit.test.ts', 'src/modules/auth/browser-session.unit.test.ts'],
    env: { NODE_ENV: 'test', DEV_OTP_BYPASS: '0' },
  },
});
