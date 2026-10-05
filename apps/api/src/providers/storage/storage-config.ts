import path from 'node:path';
import { runtimeMode } from '../../utils/runtime-mode';

/** A declaration of the storage contract, not evidence of a mounted volume
 * or a successful backup. Managed Compose supplies the shared mount; other
 * orchestrators must prove equivalent topology before activation. */
export function assertDurableStorageConfig(env: Record<string, string | undefined> = process.env): void {
  const mode = runtimeMode(env);
  const deployment = env['STORAGE_DEPLOYMENT'];
  if (deployment !== undefined && deployment !== 'managed') throw new Error('Invalid STORAGE_DEPLOYMENT');
  const kind = env['STORAGE_PROVIDER'] ?? 'local';
  if (!['local', 's3', 'r2'].includes(kind)) throw new Error('Unsupported storage provider');
  const managed = deployment === 'managed' || mode === 'production'
    || env['PILOT_ENV'] === 'staging' || env['PILOT_ENV'] === 'production';
  if (!managed) return;
  if (kind !== 'local') {
    if (!env['AWS_S3_BUCKET']?.trim()) throw new Error('AWS_S3_BUCKET is required for managed storage');
    return;
  }
  if (env['STORAGE_ALLOW_LOCAL'] !== '1') throw new Error('STORAGE_PROVIDER=local requires STORAGE_ALLOW_LOCAL=1 in a managed runtime');
  const root = env['UPLOAD_DIR'];
  if (!root || !path.isAbsolute(root) || path.normalize(root) !== root || root === path.parse(root).root) {
    throw new Error('UPLOAD_DIR must be an explicit canonical absolute persistent-storage directory');
  }
  if (env['STORAGE_LOCAL_BACKUP_ACK'] !== '1') {
    throw new Error('STORAGE_LOCAL_BACKUP_ACK=1 is required: a database backup does not contain local document bytes');
  }
}
