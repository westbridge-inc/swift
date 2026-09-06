/**
 * [DOC-1 §9.2 · P9-2] test_reaper_failure_alarms — silence is not success.
 *
 * The reaper records a heartbeat only after a completed sweep. The freshness
 * check calls it stale when there is no heartbeat at all, when it is
 * unreadable, or when it is older than two cycles — and the hourly job pages
 * the admins on stale; the sweep pages immediately when the reaper throws.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { checkReaperFreshness, recordReaperRun, LAST_REAPER_RUN_KEY, REAPER_CYCLE_HOURS, REAPER_MAX_LAG_CYCLES } from '../modules/ops/reaper-freshness';
import { JOB_RECOVERY } from '../jobs/recovery-policy';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const HOUR = 3_600_000;
let app: FastifyInstance;
let adminId = '';
let previous: unknown = undefined;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-reaper-alarm-test');
const setHeartbeat = (value: string) => system(() => app.prisma.platformConfig.upsert({ where: { key: LAST_REAPER_RUN_KEY }, create: { key: LAST_REAPER_RUN_KEY, value }, update: { value } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin);
  await app.ready();
  previous = (await system(() => app.prisma.platformConfig.findUnique({ where: { key: LAST_REAPER_RUN_KEY } })))?.value;
  const admin = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59281${NUM}1`, firstName: 'Reaper', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true } }));
  adminId = admin.id;
});

afterAll(async () => {
  await system(async () => {
    if (previous === undefined) await app.prisma.platformConfig.deleteMany({ where: { key: LAST_REAPER_RUN_KEY } });
    else await app.prisma.platformConfig.update({ where: { key: LAST_REAPER_RUN_KEY }, data: { value: previous as never } });
    await app.prisma.notification.deleteMany({ where: { userId: adminId } });
    await app.prisma.user.deleteMany({ where: { id: adminId } });
  });
  await app.close();
});

describe('[DOC-1 P9-2] reaper failure or lag alarms', () => {
  it('no heartbeat at all is stale — nothing has ever been purged on schedule', async () => {
    await system(() => app.prisma.platformConfig.deleteMany({ where: { key: LAST_REAPER_RUN_KEY } }));
    const f = await checkReaperFreshness(app.prisma);
    expect(f.stale).toBe(true);
    expect(f.ageHours).toBeNull();
    expect(f.reason).toMatch(/never completed/);
  });

  it('a completed sweep writes the heartbeat, and a fresh heartbeat is not stale; two cycles of silence is', async () => {
    const service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
    const before = new Date();
    await service.purgeExpiredDocuments();
    const row = await system(() => app.prisma.platformConfig.findUniqueOrThrow({ where: { key: LAST_REAPER_RUN_KEY } }));
    expect(new Date(String(row.value).replace(/^"|"$/g, '')).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect((await checkReaperFreshness(app.prisma)).stale).toBe(false);
    const limit = REAPER_CYCLE_HOURS * REAPER_MAX_LAG_CYCLES;
    await recordReaperRun(app.prisma, new Date(Date.now() - (limit - 1) * HOUR));
    expect((await checkReaperFreshness(app.prisma)).stale).toBe(false);
    await recordReaperRun(app.prisma, new Date(Date.now() - (limit + 1) * HOUR));
    const stale = await checkReaperFreshness(app.prisma);
    expect(stale.stale).toBe(true);
    expect(stale.ageHours).toBeGreaterThan(limit);
    expect(stale.reason).toMatch(/more than 2 cycles/);
    await setHeartbeat('not-a-date');
    expect((await checkReaperFreshness(app.prisma)).reason).toMatch(/unreadable/);
  });

  it('the hourly job pages on stale and the sweep pages on failure — both registered, both replay-safe, both kinds known to the app census', () => {
    const queue = readFileSync(join(__dirname, '..', 'jobs', 'queue.ts'), 'utf8');
    expect(queue).toMatch(/job\.name === 'reaper-lag'[\s\S]*?checkReaperFreshness\(ctx\.prisma\)[\s\S]*?opsPageOnce\(ctx, 'reaper-lag'[\s\S]*?kind: 'ops_reaper_stale'/);
    expect(queue).toMatch(/purged = await verification\.purgeExpiredDocuments\(\);\s*\} catch \(err\) \{[\s\S]*?opsPageOnce\(ctx, 'reaper-failure'[\s\S]*?kind: 'ops_reaper_failed'[\s\S]*?throw err;/);
    expect(queue).toMatch(/add\('reaper-lag', \{\}, \{\s*repeat: \{ pattern: '25 \* \* \* \*' \}/);
    expect(JOB_RECOVERY['reaper-lag']?.policy).toBe('SAFE_REPLAY');
    const census = readFileSync(join(__dirname, '..', '..', '..', 'mobile', 'src', 'services', 'notification-router.test.ts'), 'utf8');
    expect(census).toContain("k: 'ops_reaper_stale'");
    expect(census).toContain("k: 'ops_reaper_failed'");
  });

  it('the heartbeat has exactly one writer: the reaper, after a completed sweep', () => {
    const service = readFileSync(join(__dirname, '..', 'modules', 'verification', 'verification.service.ts'), 'utf8');
    const purge = service.slice(service.indexOf('async purgeExpiredDocuments()'), service.indexOf('async purgeDocumentNow('));
    expect((purge.match(/recordReaperRun\(this\.prisma, now\)/g) ?? []).length).toBe(2); // nothing due, and after the loop
    const others = service.replace(purge, '');
    expect(others).not.toContain('recordReaperRun(');
  });
});
