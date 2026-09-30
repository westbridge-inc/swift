import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { vi } from 'vitest';
import { resetKeyProviderForTests } from '../../providers/storage/envelope';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { verificationRoutes } from '../../modules/verification/verification.routes';
import { adminRoutes } from '../../modules/admin/admin.routes';
import { partnerRoutes } from '../../modules/partner/partner.routes';
import { type Actor, createGolden } from './gold-7-helpers';

// Same local encrypted-storage boundary as GOLD-5. Runtime-generated test
// material stays in memory; no credential or document bytes enter the log.
export function documentHarness(h: ReturnType<typeof createGolden>, name: string) {
  let uploadDir: string;
  async function start() {
    uploadDir = mkdtempSync(path.join(process.cwd(), `.gold7-${name}-`));
    vi.stubEnv('STORAGE_PROVIDER', 'local');
    vi.stubEnv('UPLOAD_DIR', uploadDir);
    vi.stubEnv('MASTER_KEK', randomBytes(32).toString('base64'));
    vi.stubEnv('PLATFORM_LEGAL_NAME', 'Westbridge test platform');
    vi.stubEnv('PLATFORM_REGISTERED_ADDRESS', '7 Golden Lane, Georgetown');
    vi.stubEnv('SUPPORT_EMAIL', 'support@example.test');
    resetKeyProviderForTests();
    await h.start(async (app) => {
      await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
      await app.register(adminRoutes, { prefix: '/api/v1/admin' });
      await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
    });
  }
  function upload(actor: Actor, bytes: Buffer, url = '/api/v1/verification/upload') {
    const boundary = `----gold7${nanoid(8)}`;
    return h.app.inject({ method: 'POST', url, payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="document.png"\r\ncontent-type: image/png\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${actor.token}` } });
  }
  return { start, upload, storage: getStorageProvider,
    bytes: () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(80)]),
    close: async () => {
      try { await h.close(); } finally {
        vi.unstubAllEnvs(); resetKeyProviderForTests();
        if (uploadDir) rmSync(uploadDir, { recursive: true, force: true });
      }
    },
  };
}
