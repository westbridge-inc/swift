import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { AttributionService } from '../modules/qr/attribution.service';
import { computeFpHash } from '../modules/qr/attribution';
import { enqueueScanEvent, flushScanLog, resetScanLogForTests, scanEventsLostTotal, startScanLog, stopScanLog } from '../modules/qr/scan-log';
import { qrResolverRoutes } from '../modules/qr/qr-resolver.routes';
import { qrPublicRoutes } from '../modules/qr/qr-public.routes';
import { attribSalt } from '../modules/qr/attribution';
import { hashScanIp } from '../modules/qr/scan-log';
import { scanRawRetentionDays } from '../modules/qr/qr-config';
import { assertSafeBootConfig } from '../utils/boot-config';

// These tests exercise actual service control flow with synthetic delegates.
// They open no database/Redis connection. Restrictive-role proofs live in the
// separate database suite and cannot be inferred from this unit evidence.
const lookup = vi.hoisted(() => ({ id: 'synthetic-code', tenantId: 'swift-default', entityId: 'synthetic-vendor',
  shortCode: 'BCDFGHJKMN', status: 'ACTIVE', supersededAt: null, version: 1,
  entity: { live: true, slug: 'synthetic-store' } }));
vi.mock('../modules/qr/qr.service', () => ({ QrService: class {
  async findByShortCode() { return lookup; }
  async graceDays() { return 30; }
} }));

afterEach(async () => {
  await stopScanLog();
  resetScanLogForTests();
  vi.unstubAllEnvs();
});

describe('AX7: a lineage refusal affects only that scan', () => {
  it('persists 499 valid scans from a batch containing one stale scan', async () => {
    const saved: unknown[] = [];
    const createMany = vi.fn(async ({ data }: { data: Array<{ qrCodeId: string }> }) => {
      if (data.some(r => r.qrCodeId === 'stale-code')) throw new Error('STA-1 lineage refused');
      saved.push(...data); return { count: data.length };
    });
    startScanLog({ scanEvent: { createMany } } as unknown as PrismaClient);
    enqueueScanEvent({ tenantId: 'synthetic-a', qrCodeId: 'stale-code', decision: 'WEB_RENDER' });
    for (let n = 0; n < 499; n++) enqueueScanEvent({ tenantId: 'synthetic-b', qrCodeId: 'valid-code', decision: 'WEB_RENDER' });
    await flushScanLog();
    expect(saved).toHaveLength(499);
    expect(scanEventsLostTotal()).toBe(1);
  });
});

function claimFixture() {
  const request = { ip: '198.51.100.44', ua: 'iPhone OS 18_0' };
  const candidate = { id: 'synthetic-pending', tenantId: lookup.tenantId, qrCodeId: lookup.id,
    fpHash: computeFpHash(request.ip, request.ua), claimedAt: null as Date | null, claimedInstallId: null as string | null };
  let receipt: Record<string, unknown> | null = null;
  const client = {
    qrCode: { findFirst: vi.fn(async () => ({ shortCode: lookup.shortCode })) },
    pendingAttribution: {
      findMany: vi.fn(async () => candidate.claimedAt ? [] : [{ ...candidate }]),
      updateMany: vi.fn(async ({ data }: { data: { claimedAt: Date; claimedInstallId: string } }) => {
        if (candidate.claimedAt) return { count: 0 };
        Object.assign(candidate, data); return { count: 1 };
      }),
    },
    attributionClaim: {
      findUnique: vi.fn(async () => receipt),
      findUniqueOrThrow: vi.fn(async () => { if (!receipt) throw new Error('missing synthetic receipt'); return receipt; }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (receipt) {
          const { Prisma } = await import('@prisma/client');
          throw new Prisma.PrismaClientKnownRequestError('synthetic unique collision', { code: 'P2002', clientVersion: '6' });
        }
        receipt = data; return receipt;
      }),
    },
  };
  // [AX8] A transaction the way PostgreSQL runs it for this service: the
  // per-install advisory lock (taken by the service's own $executeRaw) is held
  // until the transaction ends, and a throw rolls back every write inside it.
  let held: Promise<void> = Promise.resolve();
  const transactional = Object.assign(client, {
    $transaction: vi.fn(async <T,>(fn: (tx: unknown) => Promise<T>) => {
      const saved = { candidate: { ...candidate }, receipt };
      let release: (() => void) | null = null;
      const tx = { ...client, $executeRaw: vi.fn(async () => {
        const previous = held;
        held = new Promise<void>(r => { release = r; });
        await previous;
        return 1;
      }) };
      try { return await fn(tx); }
      catch (e) { Object.assign(candidate, saved.candidate); receipt = saved.receipt; throw e; }
      finally { (release as (() => void) | null)?.(); }
    }),
  });
  return { request, candidate, client: transactional, service: new AttributionService(transactional as unknown as PrismaClient) };
}

describe('AX8: candidate consumption and receipt insertion commit together', () => {
  it('keeps the candidate available when receipt insertion fails', async () => {
    const f = claimFixture();
    f.client.attributionClaim.create.mockRejectedValueOnce(new Error('synthetic receipt failure'));
    await expect(f.service.claim('synthetic-install-rollback', 'ios', undefined, f.request)).rejects.toThrow('synthetic receipt failure');
    expect(f.candidate.claimedAt).toBeNull();
    expect((await f.service.claim('synthetic-install-rollback', 'ios', undefined, f.request)).outcome).toBe('matched');
  });
  it('concurrent same-install requests retain the matched destination', async () => {
    const f = claimFixture();
    let release!: () => void, reached!: () => void;
    const hold = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { reached = r; });
    const create = f.client.attributionClaim.create.getMockImplementation()!;
    f.client.attributionClaim.create.mockImplementationOnce(async args => { reached(); await hold; return create(args); });
    const a = f.service.claim('synthetic-install-race', 'ios', undefined, f.request);
    await ready;
    // The second request for the same install is serialized behind the first
    // (contract §7): it starts while the first holds its receipt write, and is
    // answered only after the first commits.
    const b = f.service.claim('synthetic-install-race', 'ios', undefined, f.request);
    await new Promise(r => setTimeout(r, 20));
    release();
    const first = await a;
    const second = await b;
    expect([first, second]).toEqual([0, 1].map(() => ({ destination: '/store/synthetic-store', tenantHint: lookup.tenantId, outcome: 'matched' })));
  });
});

// Inert, synthetic boot inputs only; no provider is called, no file is read.
function productionConfig(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'production', LIFECYCLE_V2: '0', JWT_SECRET: 'synthetic'.repeat(8),
    KYC_PROVIDER: 'manual', PAYMENT_PROVIDER: 'disabled', CARD_RAIL_KILL: '1',
    MMG_DRIVER: 'live', MMG_API_URL: 'https://example.invalid/api', MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1',
    NOTIFICATION_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
    TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`, TWILIO_API_KEY_SECRET: 'synthetic-only', TWILIO_FROM: '+15550000000',
    PUSH_PROVIDER: 'expo', MASTER_KEK: Buffer.alloc(32, 7).toString('base64'),
    STORAGE_SIGNING_SECRET: 'synthetic'.repeat(8), STORAGE_PROVIDER: 's3', CONSENT_IP_PEPPER: 'synthetic'.repeat(8),
    AWS_S3_BUCKET: 'synthetic-boot-bucket',
    SCAN_IP_SALT: 'synthetic-scan'.repeat(4), ATTRIB_SALT: 'synthetic-attribution'.repeat(4),
  };
  for (const key of ['MMG_API_KEY', 'MMG_MERCHANT_ID', 'MMG_PASSWORD', 'MMG_MKEY', 'MMG_MSECRET']) env[key] = 'synthetic-only';
  return env;
}

describe('AUD-G1a-001: salts fail at boot and logging failures leave redirects valid', () => {
  it('the fully configured synthetic production baseline boots', () => {
    expect(() => assertSafeBootConfig(productionConfig())).not.toThrow();
  });
  for (const key of ['SCAN_IP_SALT', 'ATTRIB_SALT']) it(`refuses production boot without ${key}`, () => {
    const env = productionConfig(); delete env[key];
    expect(() => assertSafeBootConfig(env)).toThrow(new RegExp(key));
  });
  for (const key of ['SCAN_IP_SALT', 'ATTRIB_SALT']) it(`refuses blank ${key} at boot and its hash caller`, () => {
    const env = productionConfig(); env[key] = ' \t ';
    expect(() => assertSafeBootConfig(env)).toThrow(new RegExp(key));
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv(key, ' \t ');
    expect(() => key === 'SCAN_IP_SALT' ? hashScanIp('198.51.100.1', new Date()) : attribSalt()).toThrow(new RegExp(key));
  });
  it('a valid printed redirect survives synchronous analytics construction failure', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('SCAN_IP_SALT', '');
    const app = Fastify({ logger: false });
    app.decorate('prisma', {} as PrismaClient);
    await app.register(qrResolverRoutes);
    try {
      const response = await app.inject({ url: `/s/${lookup.shortCode}` });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toContain('/store/synthetic-store?');
      expect(scanEventsLostTotal()).toBe(1);
    } finally { await app.close(); }
  });
  it('app-open acknowledges a known code when analytics construction fails', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('SCAN_IP_SALT', '');
    const app = Fastify({ logger: false }); app.decorate('prisma', {} as PrismaClient);
    await app.register(qrPublicRoutes);
    try {
      const response = await app.inject({ method: 'POST', url: `/qr/${lookup.shortCode}/app-open` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, data: { recorded: true } });
      expect(scanEventsLostTotal()).toBe(1);
    } finally { await app.close(); }
  });
  it('Android install intent keeps its valid destination when telemetry construction fails', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('SCAN_IP_SALT', '');
    const service = new AttributionService({} as PrismaClient);
    expect(await service.intent(lookup.shortCode, { ip: '198.51.100.1', ua: 'android', isIos: false }))
      .toEqual({ created: false, destinationPath: '/store/synthetic-store' });
    expect(scanEventsLostTotal()).toBe(1);
  });
});

describe('documented QR retention configuration', () => {
  it('defaults to the documented 90 days and accepts a positive integer', () => {
    expect(scanRawRetentionDays({})).toBe(90);
    expect(scanRawRetentionDays({ SCAN_RAW_RETENTION_DAYS: '30' })).toBe(30);
  });
  it.each(['', ' ', '0', '-1', 'NaN', 'Infinity', '1.5', '1e2', '9007199254740992'])('refuses invalid retention %s at boot', value => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'test', SCAN_RAW_RETENTION_DAYS: value })).toThrow(/SCAN_RAW_RETENTION_DAYS/);
  });
});
