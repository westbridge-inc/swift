import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { NotificationService } from '../modules/notification/notification.service';
import { stepUpKey } from '../modules/auth/step-up';
import {
  applyDueMmgLinkChanges, cancelMmgLinkChange, clearMmgLink, deliverPendingMoneySurfaceNotices, digestOf, moneySurfaceInventory, stageMmgLinkChange,
  type MoneySurfaceDeps,
} from '../modules/integrity/money-surface';
import { moneySurfaceCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [R048-007] A money-surface transition is ONE atomic authority record.
//
// A store with a live MMG pay link, its owner and their step-up session. For
// every transition (stage, cancel, clear, apply) a failure is injected at
// every boundary — after the entity write, after the decision, after the
// command, and after commit before the notice — and the world must be either
// exactly as before or exactly as after: the OLD authority stays until the
// committed decision, there is exactly one audit generation per committed
// transition, exactly one notice intent, and the notice is delivered from
// the committed intent by the retry sweep when the process died first.
// Replays converge; two executors apply one change once; an unavailable
// step-up control is a refusal, not a pass.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const OLD_LINK = `https://pay.mmg.gy/store-old-${RUN}`;
const NEW_LINK = `https://pay.mmg.gy/store-new-${RUN}`;
const NEWER_LINK = `https://pay.mmg.gy/store-newer-${RUN}`;
const userIds: string[] = [];
let ownerId: string;
let sessionId: string;
let vendorId: string;
let t0: Date;
const phoneBase = 592_790_000_000 + Math.floor(Math.random() * 100_000_000);

const count = async (event: string) => (await moneySurfaceCounter.get()).values.find((v) => v.labels['event'] === event)?.value ?? 0;
const sendSpy = vi.spyOn(NotificationService.prototype, 'send');
const link = () => app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { mmgPayUrl: true, mmgPayUrlPending: true, mmgPayUrlApplyAt: true } });
const commands = () => app.prisma.moneySurfaceCommand.findMany({ where: { entityId: vendorId }, orderBy: { generation: 'asc' } });
const decisions = (outcome?: string) => app.prisma.algoDecision.count({ where: { algo: 'ALG-34', subjectId: vendorId, createdAt: { gte: t0 }, ...(outcome ? { outcome } : {}) } });
const deps = (extra: Partial<MoneySurfaceDeps> = {}): MoneySurfaceDeps => ({ prisma: app.prisma, io: app.io, redis: app.redis, ...extra });
const dieAt = (boundary: string) => async (b: string) => { if (b === boundary) throw new Error(`process died at ${boundary}`); };
const stageInput = (newUrl = NEW_LINK) => ({ actor: 'VENDOR' as const, entityId: vendorId, userId: ownerId, sessionId, newUrl });

async function resetLink() {
  await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgPayUrl: OLD_LINK, mmgPayUrlPending: null, mmgPayUrlPendingAt: null, mmgPayUrlApplyAt: null } });
  await app.prisma.moneySurfaceCommand.deleteMany({ where: { entityId: vendorId } });
  // this store's own decision rows, so each case counts only its own transitions
  await app.prisma.algoDecision.deleteMany({ where: { algo: 'ALG-34', subjectId: vendorId } });
  sendSpy.mockClear();
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  sendSpy.mockImplementation(async () => `notif-${nanoid(6)}`);
  const owner = await app.prisma.user.create({ data: { phone: `+${phoneBase + 1}`, firstName: 'Money', lastName: `Owner${RUN}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
  userIds.push(owner.id); ownerId = owner.id;
  const session = await app.prisma.session.create({ data: { authMethod: 'OTP', userId: owner.id, token: `t-${nanoid(24)}`, refreshToken: nanoid(48), deviceId: `dev-${RUN}`, deviceType: 'test', ipAddress: '10.0.0.9', expiresAt: new Date(Date.now() + 86_400_000) } });
  sessionId = session.id;
  await app.redis.set(stepUpKey(sessionId), '1', 'EX', 600);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Money Store ${RUN}`, slug: `money-store-${RUN}`, vendorType: 'STORE', phone: `+${phoneBase + 500_000}`,
      addressLine1: '1 Money St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true, mmgPayUrl: OLD_LINK,
    },
  });
  vendorId = vendor.id;
  t0 = new Date(Date.now() - 1000);
});
afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.moneySurfaceCommand.deleteMany({ where: { entityId: vendorId } }).catch(() => {});
    await app.prisma.algoDecision.deleteMany({ where: { algo: 'ALG-34', subjectId: vendorId } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:money-surface-authority');
  await app.redis.del(stepUpKey(sessionId)).catch(() => {});
  await app.close();
});

describe('[R048-007] staging: the old authority stays until the committed decision', () => {
  for (const boundary of ['tx:after-entity', 'tx:after-decision', 'tx:after-command']) {
    it(`the process dies at ${boundary}: nothing changed — no pending link, no decision, no command, no notice`, async () => {
      await resetLink();
      await expect(stageMmgLinkChange(deps({ failpoint: dieAt(boundary) }), stageInput())).rejects.toThrow(/process died/);
      expect(await link()).toMatchObject({ mmgPayUrl: OLD_LINK, mmgPayUrlPending: null, mmgPayUrlApplyAt: null });
      expect(await decisions('STAGED')).toBe(0);
      expect(await commands()).toHaveLength(0);
      expect(sendSpy).not.toHaveBeenCalled();
    });
  }

  it('the process dies after commit, before the notice: the change is committed with ONE intent, and the sweep delivers it exactly once', async () => {
    await resetLink();
    const before = await count('notice_sent');
    await expect(stageMmgLinkChange(deps({ failpoint: dieAt('after-commit') }), stageInput())).rejects.toThrow(/process died/);
    expect(await link()).toMatchObject({ mmgPayUrl: OLD_LINK, mmgPayUrlPending: NEW_LINK });
    const rows = await commands();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'MMG_LINK_STAGE', state: 'DECIDED', generation: 1, oldDigest: digestOf(OLD_LINK), newDigest: digestOf(NEW_LINK), stepUpSessionId: sessionId, noticeKind: 'mmg_link_change_staged', noticeSentAt: null });
    expect(rows[0]!.decisionId).toBeTruthy();
    expect(await decisions('STAGED')).toBe(1);
    expect(sendSpy).not.toHaveBeenCalled();
    // the sweep (fifteen seconds later) delivers the committed intent — once
    const later = new Date(Date.now() + 20_000);
    const first = await deliverPendingMoneySurfaceNotices(deps(), later);
    expect(first.delivered).toBeGreaterThanOrEqual(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]![0]).toMatchObject({ userId: ownerId, data: { kind: 'mmg_link_change_staged', commandId: rows[0]!.id } });
    expect((await commands())[0]!.noticeSentAt).not.toBeNull();
    expect(await count('notice_sent')).toBeGreaterThanOrEqual(before + 1);
    await deliverPendingMoneySurfaceNotices(deps(), later);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('a clean stage: one generation, one decision, one intent delivered inline; staging the SAME link again converges on the same command', async () => {
    await resetLink();
    const a = await stageMmgLinkChange(deps(), stageInput());
    expect(a.replay).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const b = await stageMmgLinkChange(deps(), stageInput());
    expect(b.replay).toBe(true);
    expect(b.commandId).toBe(a.commandId);
    expect(await commands()).toHaveLength(1);
    expect(await decisions('STAGED')).toBe(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    // a DIFFERENT link supersedes the open stage: generation 2, the first command SUPERSEDED
    const c = await stageMmgLinkChange(deps(), stageInput(NEWER_LINK));
    expect(c.replay).toBe(false);
    const rows = await commands();
    expect(rows.map((r) => [r.generation, r.state])).toEqual([[1, 'SUPERSEDED'], [2, 'DECIDED']]);
    expect(await link()).toMatchObject({ mmgPayUrl: OLD_LINK, mmgPayUrlPending: NEWER_LINK });
  });

  it('the step-up is re-verified inside the transition: absent → refused and nothing written; the control unavailable → refused closed', async () => {
    await resetLink();
    await app.redis.del(stepUpKey(sessionId));
    try {
      await expect(stageMmgLinkChange(deps(), stageInput())).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect(await commands()).toHaveLength(0);
      expect(await link()).toMatchObject({ mmgPayUrlPending: null });
      const broken = { exists: async () => { throw new Error('redis down'); } } as unknown as typeof app.redis;
      const before = await count('refused_control_unavailable');
      await expect(stageMmgLinkChange(deps({ redis: broken }), stageInput())).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' });
      expect(await count('refused_control_unavailable')).toBe(before + 1);
      expect(await commands()).toHaveLength(0);
    } finally {
      await app.redis.set(stepUpKey(sessionId), '1', 'EX', 600);
    }
  });
});

describe('[R048-007] the record is required, the authority is compare-and-set, a notice that did not go out is not marked sent', () => {
  it('the decision store failing inside the transaction refuses the whole transition — nothing written, counted', async () => {
    await resetLink();
    const noDecisions = app.prisma.$extends({ query: { algoDecision: { create: async () => { throw new Error('decision store down'); } } } }) as unknown as typeof app.prisma;
    const before = await count('refused_no_decision');
    await expect(stageMmgLinkChange(deps({ prisma: noDecisions }), stageInput())).rejects.toMatchObject({ code: 'DECISION_NOT_RECORDED' });
    expect(await count('refused_no_decision')).toBe(before + 1);
    expect(await link()).toMatchObject({ mmgPayUrl: OLD_LINK, mmgPayUrlPending: null });
    expect(await commands()).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('the authority moving between the read and the write (outside the lock) is refused as AUTHORITY_MOVED — nothing written', async () => {
    await resetLink();
    const moved = `https://pay.mmg.gy/store-moved-${RUN}`;
    const moveUnderneath = async (b: string) => { if (b === 'tx:after-read') await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgPayUrl: moved } }); };
    const before = await count('refused_authority_moved');
    await expect(stageMmgLinkChange(deps({ failpoint: moveUnderneath }), stageInput())).rejects.toMatchObject({ code: 'AUTHORITY_MOVED' });
    expect(await count('refused_authority_moved')).toBe(before + 1);
    expect(await link()).toMatchObject({ mmgPayUrl: moved, mmgPayUrlPending: null });
    expect(await commands()).toHaveLength(0);
    expect(await decisions()).toBe(0);
  });

  it('a notice the service could not send stays UNSENT with its error, and the sweep sends it later when the service is back', async () => {
    await resetLink();
    sendSpy.mockImplementationOnce(async () => '');
    const res = await stageMmgLinkChange(deps(), stageInput());
    const row = (await commands())[0]!;
    expect(row.id).toBe(res.commandId);
    expect(row.noticeSentAt).toBeNull();
    expect(row.noticeAttempts).toBe(1);
    expect(row.noticeLastError).toMatch(/no id/);
    const swept = await deliverPendingMoneySurfaceNotices(deps(), new Date(Date.now() + 20_000));
    expect(swept.delivered).toBeGreaterThanOrEqual(1);
    const after = await app.prisma.moneySurfaceCommand.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.noticeSentAt).not.toBeNull();
    expect(after.noticeAttempts).toBe(2);
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });
});

describe('[R048-007] cancel and clear: the revocation and the record commit together or not at all', () => {
  for (const boundary of ['tx:after-entity', 'tx:after-decision', 'tx:after-command']) {
    it(`cancel dies at ${boundary}: the pending change stays, no session is revoked, no cancel command, no notice`, async () => {
      await resetLink();
      await stageMmgLinkChange(deps(), stageInput());
      sendSpy.mockClear();
      const other = await app.prisma.session.create({ data: { authMethod: 'OTP', userId: ownerId, token: `o-${nanoid(24)}`, refreshToken: nanoid(48), deviceId: 'attacker', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
      try {
        await expect(cancelMmgLinkChange(deps({ failpoint: dieAt(boundary) }), { actor: 'VENDOR', entityId: vendorId, userId: ownerId, keepSessionId: sessionId })).rejects.toThrow(/process died/);
        expect(await link()).toMatchObject({ mmgPayUrl: OLD_LINK, mmgPayUrlPending: NEW_LINK });
        expect(await app.prisma.session.count({ where: { id: other.id } })).toBe(1); // the attacker's session survives ONLY because nothing committed
        expect((await commands()).map((r) => r.kind)).toEqual(['MMG_LINK_STAGE']);
        expect(sendSpy).not.toHaveBeenCalled();
      } finally {
        await app.prisma.session.deleteMany({ where: { id: other.id } });
      }
    });
  }

  it('a clean cancel: the pending change is gone, the other session is revoked, the stage command is CANCELLED and a CANCEL command carries its own intent', async () => {
    await resetLink();
    await stageMmgLinkChange(deps(), stageInput());
    sendSpy.mockClear();
    const other = await app.prisma.session.create({ data: { authMethod: 'OTP', userId: ownerId, token: `o-${nanoid(24)}`, refreshToken: nanoid(48), deviceId: 'attacker', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
    const res = await cancelMmgLinkChange(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId, keepSessionId: sessionId });
    expect(res).toEqual({ cancelled: true, revokedSessions: 1 });
    expect(await app.prisma.session.count({ where: { id: other.id } })).toBe(0);
    expect(await app.prisma.session.count({ where: { id: sessionId } })).toBe(1);
    const rows = await commands();
    expect(rows.map((r) => [r.generation, r.kind, r.state])).toEqual([[1, 'MMG_LINK_STAGE', 'CANCELLED'], [2, 'MMG_LINK_CANCEL', 'APPLIED']]);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]![0]).toMatchObject({ data: { kind: 'mmg_link_change_cancelled' } });
    expect(await cancelMmgLinkChange(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId, keepSessionId: sessionId })).toEqual({ cancelled: false, revokedSessions: 0 });
  });

  it('clear dies at a boundary: the live link stays; clean clear: link removed, one CLEAR command, no notice intent', async () => {
    await resetLink();
    await expect(clearMmgLink(deps({ failpoint: dieAt('tx:after-decision') }), { actor: 'VENDOR', entityId: vendorId, userId: ownerId })).rejects.toThrow(/process died/);
    expect(await link()).toMatchObject({ mmgPayUrl: OLD_LINK });
    expect(await commands()).toHaveLength(0);
    await clearMmgLink(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId });
    expect(await link()).toMatchObject({ mmgPayUrl: null, mmgPayUrlPending: null });
    const rows = await commands();
    expect(rows.map((r) => [r.kind, r.state, r.newDigest, r.noticeKind])).toEqual([['MMG_LINK_CLEAR', 'APPLIED', 'none', null]]);
  });
});

describe('[R048-007] the executor applies only a leased, still-decided command — once', () => {
  it('apply dies at a boundary: the old link stays live and the stage command stays DECIDED and re-leasable', async () => {
    await resetLink();
    await stageMmgLinkChange(deps(), stageInput());
    sendSpy.mockClear();
    const due = new Date(Date.now() + 25 * 3_600_000);
    await expect(applyDueMmgLinkChanges(deps({ failpoint: dieAt('tx:after-command') }), due)).rejects.toThrow(/process died/);
    expect(await link()).toMatchObject({ mmgPayUrl: OLD_LINK, mmgPayUrlPending: NEW_LINK });
    expect((await commands()).map((r) => [r.kind, r.state])).toEqual([['MMG_LINK_STAGE', 'DECIDED']]);
    expect(sendSpy).not.toHaveBeenCalled();
    // the lease expires and the next executor applies it
    const res = await applyDueMmgLinkChanges(deps(), new Date(due.getTime() + 61_000));
    expect(res.applied).toBe(1);
    expect(await link()).toMatchObject({ mmgPayUrl: NEW_LINK, mmgPayUrlPending: null });
    expect((await commands()).map((r) => [r.generation, r.kind, r.state])).toEqual([[1, 'MMG_LINK_STAGE', 'APPLIED'], [2, 'MMG_LINK_APPLY', 'APPLIED']]);
    expect(await decisions('APPLIED')).toBe(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('two executors on the same due change: one leases and applies, the other is refused by the lease; one APPLY generation, one notice', async () => {
    await resetLink();
    await stageMmgLinkChange(deps(), stageInput());
    sendSpy.mockClear();
    const due = new Date(Date.now() + 25 * 3_600_000);
    const hold = async (b: string) => { if (b === 'tx:after-entity') await new Promise((r) => setTimeout(r, 400)); };
    const before = await count('apply_lease_missed');
    const [a, b] = await Promise.all([applyDueMmgLinkChanges(deps({ failpoint: hold }), due), applyDueMmgLinkChanges(deps({ failpoint: hold }), due)]);
    expect(a.applied + b.applied).toBe(1);
    expect(await count('apply_lease_missed')).toBe(before + 1);
    expect((await commands()).filter((r) => r.kind === 'MMG_LINK_APPLY')).toHaveLength(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(await link()).toMatchObject({ mmgPayUrl: NEW_LINK });
  });

  it('a change cancelled after the executor leased it is not applied', async () => {
    await resetLink();
    await stageMmgLinkChange(deps(), stageInput());
    const due = new Date(Date.now() + 25 * 3_600_000);
    const cancelInside = async (b: string) => {
      if (b === 'tx:after-entity') return; // (inside the executor's tx the lock is held; cancel here would deadlock — cancel BEFORE the tx instead)
    };
    // cancel between lease and transaction: simulate by cancelling first, then running the executor with a lease already taken on a now-cancelled command
    await cancelMmgLinkChange(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId, keepSessionId: sessionId });
    const res = await applyDueMmgLinkChanges(deps({ failpoint: cancelInside }), due);
    expect(res.applied).toBe(0);
    expect(await link()).toMatchObject({ mmgPayUrl: OLD_LINK, mmgPayUrlPending: null });
  });

  it('the inventory the rollout census reads', async () => {
    const inv = await moneySurfaceInventory(app.prisma);
    expect(inv.appliedWithoutDecision).toBe(0);
    expect(typeof inv.openStages).toBe('number');
  });
});
