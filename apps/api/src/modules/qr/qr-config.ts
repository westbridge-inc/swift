import { runtimeMode } from '../../utils/runtime-mode';

type Config = Record<string, string | undefined>;

/** One contract for boot and both request hashers. Never echo a salt. */
export function qrSalt(name: 'SCAN_IP_SALT' | 'ATTRIB_SALT', env: Config = process.env): string {
  const value = env[name];
  if (value?.trim()) return value;
  if (runtimeMode(env) === 'production') {
    throw new Error(`FATAL: ${name} is required and must not be blank in production. Refusing to start.`);
  }
  return name === 'SCAN_IP_SALT' ? 'dev-scan-ip-salt' : 'dev-attrib-salt';
}

/** The existing analytics/schema contract specifies a 90-day raw lifetime. */
export function scanRawRetentionDays(env: Config = process.env): number {
  const raw = env['SCAN_RAW_RETENTION_DAYS'];
  if (raw === undefined) return 90;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('FATAL: SCAN_RAW_RETENTION_DAYS must be a positive integer. Refusing to start.');
  }
  return Number(raw);
}

export function assertQrConfig(env: Config = process.env): void {
  qrSalt('SCAN_IP_SALT', env);
  qrSalt('ATTRIB_SALT', env);
  scanRawRetentionDays(env);
}
