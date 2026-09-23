import { defineConfig } from 'vitest/config';

// [NO-AI] The permanent negative gate and the manual-engine unit test, service-free: no
// database, no Redis, no target lock. The default API config (which owns the lock) also
// picks these files up in CI through its `src/**/*.test.ts` include.
export default defineConfig({
  test: {
    include: ['src/__tests__/no-ai-kyc-gate.unit.test.ts', 'src/__tests__/kyc-manual-only.test.ts', 'src/__tests__/boot-config.test.ts', 'src/__tests__/identity-signal-safety.unit.test.ts'],
    fileParallelism: false,
    env: { NODE_ENV: 'test', DEV_OTP_BYPASS: '0', KYC_PROVIDER: 'manual' },
  },
});
