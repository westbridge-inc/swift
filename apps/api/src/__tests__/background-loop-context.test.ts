import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { PrismaClient } from '@prisma/client';
import { scopedPrisma } from '../plugins/prisma';
import { getTenantContext, runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { enqueueScanEvent, flushScanLog, resetScanLogForTests, startScanLog, stopScanLog } from '../modules/qr/scan-log';

// ---------------------------------------------------------------------------
// [L01 · tenant wall · job PR-3] The background loops that are not queue jobs
// and write across tenants run as NAMED system work, never unbound:
//  - the QR scan-log flush (writes every tenant's scan events),
//  - the boot seeding of platform registries and the default taxonomy.
// The socket authority fallback recheck is NOT system work: it reads each
// tenant's sessions bound to that tenant, one tenant at a time (the sign-in
// under the wall change, preauth-identity-posture.test.ts), so it needs no
// bypass login at all.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const prisma = scopedPrisma as unknown as PrismaClient;
const TENANT_B = `scan-b-${nanoid(6)}`;
const tag = `bg-${nanoid(8)}`;

beforeAll(async () => {
  await runWithoutTenant(() => prisma.tenant.create({ data: { id: TENANT_B, name: 'Scan B', slug: TENANT_B, isActive: false } }));
});
afterAll(async () => {
  await stopScanLog();
  await runWithoutTenant(async () => {
    await prisma.scanEvent.deleteMany({ where: { template: tag } });
    await prisma.tenant.deleteMany({ where: { id: TENANT_B } });
  });
});

const event = (tenantId: string) => ({
  tenantId, qrCodeId: null, occurredAt: new Date(), decision: 'APP_OPEN_ASSUMED' as const, src: 'qr', template: tag,
  osFamily: null, deviceClass: null, uaHash: null, ipHash: null, country: null,
}) as unknown as Parameters<typeof enqueueScanEvent>[0];

describe('[L01 · PR-3] background loops run as named system work', () => {
  it('the scan-log flush writes as named system work, and every event keeps ITS OWN tenant — even when flushed from another tenant’s context', async () => {
    resetScanLogForTests();
    startScanLog(prisma);
    const seen: Array<ReturnType<typeof getTenantContext>> = [];
    const real = prisma.scanEvent.createMany.bind(prisma.scanEvent);
    const spy = vi.spyOn(prisma.scanEvent, 'createMany').mockImplementation(((args: never) => { seen.push(getTenantContext()); return real(args); }) as never);
    try {
      enqueueScanEvent(event('swift-default'));
      enqueueScanEvent(event(TENANT_B));
      await runWithTenant('swift-default', () => flushScanLog());
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([{ tenantId: null, mode: 'system', capability: 'qr:scan-log-flush' }]);
    const rows = await runWithoutTenant(() => prisma.scanEvent.findMany({ where: { template: tag }, select: { tenantId: true } }));
    expect(rows.map((r) => r.tenantId).sort()).toEqual(['swift-default', TENANT_B].sort());
  });

  it('the boot seeding runs as named system work', () => {
    const server = strip(readFileSync(join(SRC, 'server.ts'), 'utf8'));
    const at = server.indexOf("void runAsSystem('boot:seed-registries', async () => {");
    expect(at).toBeGreaterThan(-1);
    expect(server.indexOf('seedDiscoveryTaxonomy(app.prisma)')).toBeGreaterThan(at);
    expect(server.indexOf('markBootContractsComplete()')).toBeGreaterThan(at);
  });
});
