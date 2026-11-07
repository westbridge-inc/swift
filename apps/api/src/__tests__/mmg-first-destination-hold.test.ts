import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { NotificationService } from '../modules/notification/notification.service';
import { stepUpKey } from '../modules/auth/step-up';
import {
  DEFAULT_LINK_COOLOFF_HOURS, FIRST_DESTINATION_HOLD_HOURS, applyDueMmgLinkChanges, cancelMmgLinkChange, clearMmgLink, nextMoneySurfaceHoldHours,
  stageMmgLinkChange, type MoneySurfaceDeps,
} from '../modules/integrity/money-surface';
import { wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [owner 30 Oct 2026 via COORD · "do what's best for MMG"] A store's FIRST-EVER MMG number goes live after
// 1 hour; CHANGING one keeps the configured cool-off (money.linkCooloffHours, default 24 h). "First ever" means
// the very first number stage on record: no live number, no pending one, and no earlier number command of any kind.
// A number removed (live or still waiting) or cancelled and then added again waits the full cool-off, so neither a
// removal nor a cancel can shorten the hold on a takeover. A pay LINK keeps the cool-off even the first time.
// Step-up, signals, the decision record and the owner notice are exactly as for a change; the notice never says
// "customers pay your current number" when there is none.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = wordFreeTag(8);
const userIds: string[] = [];
let ownerId: string;
let sessionId: string;
let vendorId: string;
const phoneBase = 592_791_000_000 + Math.floor(Math.random() * 100_000_000);
const n4 = () => String(1000 + Math.floor(Math.random() * 9000));
const NUMBER_A = `+592600${n4()}`;
const NUMBER_B = `+592601${n4()}`;
const LINK_A = `https://pay.mmg.gy/first-${RUN}`;
const HOUR = 3_600_000;

const sendSpy = vi.spyOn(NotificationService.prototype, 'send');
const deps = (): MoneySurfaceDeps => ({ prisma: app.prisma, io: app.io, redis: app.redis });
const stageNumber = (newNumber: string, now: Date) =>
  stageMmgLinkChange(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId, sessionId, newNumber, field: 'NUMBER', now });
const row = () => app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { mmgNumber: true, mmgNumberPending: true, mmgNumberApplyAt: true, mmgPayUrl: true, mmgPayUrlApplyAt: true } });
const decisionInputs = async () => {
  const d = await app.prisma.algoDecision.findFirstOrThrow({ where: { algo: 'ALG-34', subjectId: vendorId, outcome: 'STAGED' }, orderBy: { createdAt: 'desc' } });
  return d.inputs as Record<string, unknown>;
};
const lastStageNotice = async (kind = 'MMG_NUMBER_STAGE') =>
  (await app.prisma.moneySurfaceCommand.findFirstOrThrow({ where: { entityId: vendorId, kind }, orderBy: { generation: 'desc' } })).noticePayload as { title: string; body: string; sms?: string };
const applyNow = async () => {
  await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgNumberApplyAt: new Date(Date.now() - 1000) } });
  return applyDueMmgLinkChanges(deps());
};

async function fresh(data: { mmgNumber?: string | null; mmgPayUrl?: string | null } = {}) {
  await app.prisma.moneySurfaceCommand.deleteMany({ where: { entityId: vendorId } });
  await app.prisma.algoDecision.deleteMany({ where: { algo: 'ALG-34', subjectId: vendorId } });
  await app.prisma.vendor.update({
    where: { id: vendorId },
    data: {
      mmgNumber: data.mmgNumber ?? null, mmgNumberPending: null, mmgNumberPendingAt: null, mmgNumberApplyAt: null,
      mmgPayUrl: data.mmgPayUrl ?? null, mmgPayUrlPending: null, mmgPayUrlPendingAt: null, mmgPayUrlApplyAt: null,
    },
  });
  sendSpy.mockClear();
}

beforeAll(async () => {
  vi.stubEnv('MMG_PAY_URL_ALLOWED_HOSTS', 'pay.mmg.gy');
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  sendSpy.mockImplementation(async () => `notif-${nanoid(6)}`);
  const owner = await app.prisma.user.create({ data: { phone: `+${phoneBase + 1}`, firstName: 'First', lastName: `Number${RUN}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
  userIds.push(owner.id); ownerId = owner.id;
  const session = await app.prisma.session.create({ data: { authMethod: 'OTP', userId: owner.id, token: `t-${nanoid(24)}`, refreshToken: nanoid(48), deviceId: `dev-${RUN}`, deviceType: 'test', ipAddress: '10.0.0.7', expiresAt: new Date(Date.now() + 86_400_000) } });
  sessionId = session.id;
  await app.redis.set(stepUpKey(sessionId), '1', 'EX', 3600);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  vendorId = (await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `First Number ${RUN}`, slug: `first-number-${RUN}`, vendorType: 'STORE', phone: `+${phoneBase + 500_000}`,
      addressLine1: '1 First St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
    },
  })).id;
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
  }, 'test-cleanup:mmg-first-destination-hold');
  await app.redis.del(stepUpKey(sessionId)).catch(() => {});
  await app.close();
  vi.unstubAllEnvs();
});

beforeEach(() => fresh());

describe('a store\'s first-ever MMG number goes live after 1 hour; a change keeps the cool-off', () => {
  it('the hours are 1 and the configured 24', () => {
    expect(FIRST_DESTINATION_HOLD_HOURS).toBe(1);
    expect(DEFAULT_LINK_COOLOFF_HOURS).toBe(24);
  });

  it('first ever: applyAt is 1 hour on, with the same step-up, decision, command and owner notice as a change', async () => {
    expect(await nextMoneySurfaceHoldHours(app.prisma, 'VENDOR', vendorId, 'NUMBER')).toBe(1);
    const now = new Date();
    const r = await stageNumber(NUMBER_A, now);
    expect(r.applyAt.getTime()).toBe(now.getTime() + HOUR);
    expect(r.cooloffHours).toBe(1);
    expect((await row()).mmgNumberApplyAt!.getTime()).toBe(now.getTime() + HOUR);
    expect(await decisionInputs()).toMatchObject({ field: 'NUMBER', hadNumber: false, firstDestination: true, holdHours: 1, cooloffHours: 24 });
    const cmd = await app.prisma.moneySurfaceCommand.findFirstOrThrow({ where: { entityId: vendorId, kind: 'MMG_NUMBER_STAGE' } });
    expect(cmd).toMatchObject({ state: 'DECIDED', stepUpSessionId: sessionId, noticeKind: 'mmg_number_change_staged' });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const notice = await lastStageNotice();
    // There is no current number: the notice never says customers keep paying one.
    expect(notice.body).not.toMatch(/current number/);
    expect(notice.body).toMatch(/^Your MMG number takes effect .+\. Until then customers cannot choose MMG for your store\. If this wasn’t you, open Account and cancel it now — that also signs out every other device\.$/);
  });

  it('the step-up is still required for a first number', async () => {
    await app.redis.del(stepUpKey(sessionId));
    try {
      await expect(stageNumber(NUMBER_A, new Date())).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect((await row()).mmgNumberPending).toBeNull();
    } finally {
      await app.redis.set(stepUpKey(sessionId), '1', 'EX', 3600);
    }
  });

  it('a change of a live number keeps the full cool-off, and the notice says customers keep paying the current one', async () => {
    await fresh({ mmgNumber: NUMBER_A });
    expect(await nextMoneySurfaceHoldHours(app.prisma, 'VENDOR', vendorId, 'NUMBER')).toBe(24);
    const now = new Date();
    const r = await stageNumber(NUMBER_B, now);
    expect(r.applyAt.getTime()).toBe(now.getTime() + 24 * HOUR);
    expect(await decisionInputs()).toMatchObject({ hadNumber: true, firstDestination: false, holdHours: 24 });
    expect((await lastStageNotice()).body).toMatch(/Until then customers pay your current number\./);
  });

  it('remove then add again: the number was live once, so the new one waits the full cool-off', async () => {
    await fresh({ mmgNumber: NUMBER_A });
    await clearMmgLink(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId, field: 'NUMBER' });
    expect((await row()).mmgNumber).toBeNull();
    expect(await nextMoneySurfaceHoldHours(app.prisma, 'VENDOR', vendorId, 'NUMBER')).toBe(24);
    const now = new Date();
    const r = await stageNumber(NUMBER_B, now);
    expect(r.applyAt.getTime()).toBe(now.getTime() + 24 * HOUR);
    expect(await decisionInputs()).toMatchObject({ hadNumber: false, firstDestination: false, holdHours: 24 });
  });

  it('a first number that went live and was then removed: the next one waits the full cool-off', async () => {
    await stageNumber(NUMBER_A, new Date());
    expect((await applyNow()).applied).toBe(1);
    expect((await row()).mmgNumber).toBe(NUMBER_A);
    await clearMmgLink(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId, field: 'NUMBER' });
    const now = new Date();
    expect((await stageNumber(NUMBER_B, now)).applyAt.getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it('a number that was live and was wiped outside the money surface still counts: its change was staged over it', async () => {
    // A live number (no command history) is changed: the stage records the old number's digest. Then the row is
    // wiped directly (as an account wind-down does) and the change cancelled: no live, no pending, but it WAS live.
    await fresh({ mmgNumber: NUMBER_A });
    await stageNumber(NUMBER_B, new Date());
    await cancelMmgLinkChange(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId, keepSessionId: sessionId, field: 'NUMBER' });
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgNumber: null } });
    await app.prisma.moneySurfaceCommand.deleteMany({ where: { entityId: vendorId, kind: 'MMG_NUMBER_CANCEL' } });
    const now = new Date();
    expect((await stageNumber(NUMBER_A, now)).applyAt.getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it('a first number that went live and was wiped outside the money surface (no removal recorded): still 24 hours', async () => {
    await stageNumber(NUMBER_A, new Date());
    expect((await applyNow()).applied).toBe(1);
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgNumber: null } });
    const now = new Date();
    expect((await stageNumber(NUMBER_B, now)).applyAt.getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it('only a cancel recorded while a number was live is left: it still counts (the cancel kept that live number)', async () => {
    await fresh({ mmgNumber: NUMBER_A });
    await stageNumber(NUMBER_B, new Date());
    await cancelMmgLinkChange(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId, keepSessionId: sessionId, field: 'NUMBER' });
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgNumber: null } });
    await app.prisma.moneySurfaceCommand.deleteMany({ where: { entityId: vendorId, kind: 'MMG_NUMBER_STAGE' } });
    const now = new Date();
    expect((await stageNumber(NUMBER_A, now)).applyAt.getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it('a number already waiting: staging another one is not "first ever" and waits the full cool-off', async () => {
    await stageNumber(NUMBER_A, new Date());
    const now = new Date();
    const r = await stageNumber(NUMBER_B, now);
    expect(r.applyAt.getTime()).toBe(now.getTime() + 24 * HOUR);
    expect(await nextMoneySurfaceHoldHours(app.prisma, 'VENDOR', vendorId, 'NUMBER')).toBe(24);
  });

  it('the 1 hour is for the very first stage only: a first number cancelled before it went live -> the next one waits the full cool-off', async () => {
    // Whoever cancels holds the owner's signed-in session; cancel-then-stage must never be shorter than staging over it.
    await stageNumber(NUMBER_A, new Date());
    await cancelMmgLinkChange(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId, keepSessionId: sessionId, field: 'NUMBER' });
    expect(await nextMoneySurfaceHoldHours(app.prisma, 'VENDOR', vendorId, 'NUMBER')).toBe(24);
    const now = new Date();
    expect((await stageNumber(NUMBER_B, now)).applyAt.getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it('the ruling names the NUMBER only: a first pay LINK keeps the full cool-off, and so does one removed and re-added', async () => {
    const now = new Date();
    const first = await stageMmgLinkChange(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId, sessionId, newUrl: LINK_A, now });
    expect(first.applyAt.getTime()).toBe(now.getTime() + 24 * HOUR);
    expect(first.cooloffHours).toBe(24);
    expect(await nextMoneySurfaceHoldHours(app.prisma, 'VENDOR', vendorId, 'LINK')).toBe(24);
    await fresh({ mmgPayUrl: LINK_A });
    await clearMmgLink(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId });
    const later = new Date();
    const again = await stageMmgLinkChange(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId, sessionId, newUrl: LINK_A, now: later });
    expect(again.applyAt.getTime()).toBe(later.getTime() + 24 * HOUR);
  });
});

describe('first-number rule hardened: removing a waiting number never turns a full hold into 1 hour', () => {
  const clearNumber = () => clearMmgLink(deps(), { actor: 'VENDOR', entityId: vendorId, userId: ownerId, field: 'NUMBER' });

  it('a never-live store: stage, remove while it waits, stage again -> the full cool-off (not 1 hour again)', async () => {
    expect((await stageNumber(NUMBER_A, new Date())).cooloffHours).toBe(1);
    await clearNumber();
    expect(await row()).toMatchObject({ mmgNumber: null, mmgNumberPending: null });
    expect(await nextMoneySurfaceHoldHours(app.prisma, 'VENDOR', vendorId, 'NUMBER')).toBe(24);
    const now = new Date();
    const r = await stageNumber(NUMBER_B, now);
    expect(r.applyAt.getTime()).toBe(now.getTime() + 24 * HOUR);
    expect(await decisionInputs()).toMatchObject({ firstDestination: false, holdHours: 24 });
  });

  it('a superseded stage: first (1 h), another over it (24 h), remove, stage again -> 24 h', async () => {
    await stageNumber(NUMBER_A, new Date());
    expect((await stageNumber(NUMBER_B, new Date())).cooloffHours).toBe(24);
    await clearNumber();
    const now = new Date();
    expect((await stageNumber(NUMBER_A, now)).applyAt.getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it('a number waiting from before this rule (24 h, no command on record) is removed: the next one still waits 24 h', async () => {
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgNumberPending: NUMBER_A, mmgNumberPendingAt: new Date(), mmgNumberApplyAt: new Date(Date.now() + 20 * HOUR) } });
    expect(await app.prisma.moneySurfaceCommand.count({ where: { entityId: vendorId } })).toBe(0);
    await clearNumber();
    expect(await nextMoneySurfaceHoldHours(app.prisma, 'VENDOR', vendorId, 'NUMBER')).toBe(24);
    const now = new Date();
    expect((await stageNumber(NUMBER_B, now)).applyAt.getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it('a number waiting from before this rule (no command on record), staged over: the screen says 24 h and the stage waits 24 h', async () => {
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgNumberPending: NUMBER_A, mmgNumberPendingAt: new Date(), mmgNumberApplyAt: new Date(Date.now() + 20 * HOUR) } });
    expect(await app.prisma.moneySurfaceCommand.count({ where: { entityId: vendorId } })).toBe(0);
    expect(await nextMoneySurfaceHoldHours(app.prisma, 'VENDOR', vendorId, 'NUMBER')).toBe(24);
    const now = new Date();
    expect((await stageNumber(NUMBER_B, now)).applyAt.getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it('removing a waiting number tells the owner (app + text), so a removal they did not make is seen', async () => {
    await stageNumber(NUMBER_A, new Date());
    sendSpy.mockClear();
    await clearNumber();
    const cmd = await app.prisma.moneySurfaceCommand.findFirstOrThrow({ where: { entityId: vendorId, kind: 'MMG_NUMBER_CLEAR' } });
    expect(cmd.noticeKind).toBe('mmg_number_pending_removed');
    expect(cmd.noticeSentAt).not.toBeNull();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]![0]).toMatchObject({ userId: ownerId, title: 'Your new MMG number was removed' });
    const payload = cmd.noticePayload as { title: string; body: string; sms?: string };
    expect(payload.body).toBe('The MMG number that was waiting to go live was removed, so it will not go live. Customers cannot choose MMG for your store until a new number clears its hold. If this wasn’t you, contact Swift support right away.');
    expect(payload.sms).toBe("Swift: the MMG number waiting to go live on your store account was removed. If this wasn't you, contact Swift support right away.");
  });

  it('removing when nothing is waiting sends no "waiting number removed" notice', async () => {
    await fresh({ mmgNumber: NUMBER_A });
    await clearNumber();
    const cmd = await app.prisma.moneySurfaceCommand.findFirstOrThrow({ where: { entityId: vendorId, kind: 'MMG_NUMBER_CLEAR' } });
    expect(cmd.noticeKind).toBeNull();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
