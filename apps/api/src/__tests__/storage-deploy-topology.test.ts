import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertDurableStorageConfig } from '../providers/storage/storage-config';

const deploy = join(__dirname, '../../../../deploy');
type Service = { environment: Record<string, string>; volumes: { type: string; source: string; target: string; read_only?: boolean }[] };
type Model = { services: Record<'api' | 'worker', Service>; volumes: Record<string, { external?: boolean; name: string }> };

// Render the actual deployment source with Compose's own merge/interpolation
// rules. Never read a developer's .env or contact Docker's daemon/providers.
function render(settings: Record<string, string>, local = false): Model {
  const dir = mkdtempSync(join(tmpdir(), 'swift-storage-compose-'));
  try {
    const base = readFileSync(join(deploy, 'docker-compose.yml'), 'utf8');
    writeFileSync(join(dir, 'compose.yml'), base.replace(/^ {4}env_file: \.env$/gm, '    env_file: settings.fixture'));
    writeFileSync(join(dir, 'settings.fixture'), Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n'));
    const args = ['compose', '--env-file', '/dev/null', '-f', join(dir, 'compose.yml')];
    if (local) args.push('-f', join(deploy, 'docker-compose.storage-local.yml'));
    args.push('config', '--format', 'json');
    const result = spawnSync('docker', args, {
      env: { PATH: process.env['PATH'], HOME: process.env['HOME'], ...settings },
      encoding: 'utf8', timeout: 15000,
    });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    return JSON.parse(result.stdout) as Model;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const objectSettings = {
  STORAGE_PROVIDER: 's3', AWS_S3_BUCKET: 'synthetic-private-documents',
  AWS_S3_ENDPOINT: 'https://objects.example.invalid', AWS_REGION: 'auto',
  AWS_ACCESS_KEY_ID_FILE: '/run/secrets/AWS_ACCESS_KEY_ID',
  AWS_SECRET_ACCESS_KEY_FILE: '/run/secrets/AWS_SECRET_ACCESS_KEY',
  AWS_S3_SSE: 'AES256',
};
const storageFields = [...Object.keys(objectSettings), 'STORAGE_DEPLOYMENT', 'STORAGE_ALLOW_LOCAL', 'UPLOAD_DIR', 'STORAGE_LOCAL_BACKUP_ACK'];

function assertPair(model: Model) {
  const api = model.services.api.environment;
  const worker = model.services.worker.environment;
  for (const field of storageFields) expect(worker[field], `worker ${field} must match API`).toBe(api[field]);
  for (const env of [api, worker]) {
    expect(env['STORAGE_DEPLOYMENT']).toBe('managed');
    expect(() => assertDurableStorageConfig(env)).not.toThrow();
  }
}

describe('MASTER-074 rendered deployment storage contract', () => {
  for (const mode of ['development', 'loadtest', 'production']) {
    it.each(['s3', 'r2'])(`${mode}: %s preserves the shared object-store target without local activation`, (provider) => {
      const model = render({ ...objectSettings, NODE_ENV: mode, STORAGE_PROVIDER: provider });
      assertPair(model);
      for (const service of [model.services.api, model.services.worker]) {
        expect(service.environment).toMatchObject({ ...objectSettings, STORAGE_PROVIDER: provider });
        expect(service.volumes.some(v => v.target === '/srv/swift/uploads')).toBe(false);
      }
    });
    it(`${mode}: env acknowledgement alone cannot enable per-container local storage`, () => {
      const model = render({ NODE_ENV: mode, STORAGE_PROVIDER: 'local', STORAGE_ALLOW_LOCAL: '1',
        UPLOAD_DIR: '/srv/swift/uploads', STORAGE_LOCAL_BACKUP_ACK: '1' });
      for (const service of [model.services.api, model.services.worker]) {
        expect(service.environment['STORAGE_ALLOW_LOCAL']).toBe('0');
        expect(() => assertDurableStorageConfig(service.environment)).toThrow(/STORAGE_ALLOW_LOCAL/);
      }
    });
    it(`${mode}: explicit local overlay gives both processes the same external persistent volume`, () => {
      const model = render({ NODE_ENV: mode, STORAGE_PROVIDER: 'local', STORAGE_LOCAL_BACKUP_ACK: '1',
        SWIFT_UPLOAD_VOLUME: 'synthetic-existing-upload-volume' }, true);
      assertPair(model);
      const mounts = [model.services.api, model.services.worker].map(service => {
        expect(service.environment['UPLOAD_DIR']).toBe('/srv/swift/uploads');
        const mount = service.volumes.find(v => v.target === service.environment['UPLOAD_DIR']);
        expect(mount).toMatchObject({ type: 'volume', source: 'swift-private-uploads' });
        expect(mount?.read_only).not.toBe(true);
        return mount;
      });
      expect(mounts[1]).toEqual(mounts[0]);
      expect(model.volumes['swift-private-uploads']).toEqual({ external: true, name: 'synthetic-existing-upload-volume' });
    });
  }
  it('documents S3 by default and the complete explicit local alternative', () => {
    const template = readFileSync(join(deploy, '.env.deploy.example'), 'utf8');
    expect(template).toMatch(/^STORAGE_PROVIDER=s3$/m);
    for (const instruction of ['UPLOAD_DIR=/srv/swift/uploads', 'STORAGE_LOCAL_BACKUP_ACK=1', 'SWIFT_UPLOAD_VOLUME=', 'docker-compose.storage-local.yml']) {
      expect(template).toContain(instruction);
    }
  });
});
