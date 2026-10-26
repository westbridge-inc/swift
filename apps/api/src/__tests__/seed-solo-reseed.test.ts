import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient, type UserRole } from '@prisma/client';
import { nanoid } from 'nanoid';
import { grantSuiteCapability } from '../lib/test-target-lock';
import {
  applySeedPlan, buildSeedPlan, cancelSoloReseeds, planApprovalRequest, planRequestFacts, soloNoticeChannelsReady, startSoloReseed,
  SOLO_RESEED_ACTION, SOLO_RESEED_MAX_WRONG_CODES, type DesiredConfig, type RequestContext,
} from '../modules/ops/seed-plan';
import {
  approvalRequest, SOLO_COOLING_OFF_MS, SOLO_DEFAULT_LIFETIME_MS, SOLO_RESEED_SHOW_LINE, SOLO_SHOW_LINE, type SignedApproval,
} from '../modules/ops/approver-signatures';
import { desiredPlatformConfig, spineRequestContext } from '../modules/ops/platform-config';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';
import { testPhone } from './helpers/fixture-ids';

// This suite pins the deployment identity singleton and the admin roster for the whole file and restores both after.
grantSuiteCapability('unscoped-mutation');

// ---------------------------------------------------------------------------
// [SOLO RE-SEED] Owner ruling 26 Oct 2026 (PROD-SESSION D1), under the 30 Sep
// ruling #13 SOLO MODE: there is no second person, so while the owner is the
// ONLY admin a LATER production settings re-seed may be approved by the owner
// alone — one pinned key over words that say so, a 12-hour wait that starts
// when the owner is emailed and texted and can be cancelled, a fresh sign-in
// code texted to the owner's phone at apply, the admins counted again at
// apply, everything in the append-only audit. The moment a second admin
// exists it is two people again. The two-person ceremony and the first-seed
// solo stay exactly as they were.
// ---------------------------------------------------------------------------

// The owner's notices leave through the real channels (the dev adapter here);
// a flag makes one of them fail, to prove a notice that cannot go stops it all.
const fail = vi.hoisted(() => ({ email: false, sms: false }));
vi.mock('../providers/notifications/channels', async (importOriginal) => {
  const real = await importOriginal<typeof import('../providers/notifications/channels')>();
  return {
    ...real,
    getChannels: () => {
      const channels = real.getChannels();
      return {
        ...channels,
        email: fail.email ? { sendEmail: async () => { throw new Error('mailbox down'); } } : channels.email,
        sms: fail.sms ? { sendSms: async () => { throw new Error('texts down'); } } : channels.sms,
      };
    },
  };
});

const prisma = new PrismaClient();
const URL_ = process.env['DATABASE_URL'] ?? 'postgresql://swift:swift@localhost:5434/swift_test';
const KEYDIR = mkdtempSync(join(tmpdir(), 'seed-reseed-approvers-'));
const makeKey = (name: string) => {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(KEYDIR, name), '-C', name]);
  return readFileSync(join(KEYDIR, `${name}.pub`), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
};
const PUB = { owner: makeKey('owner'), bob: makeKey('bob') };
const OWNER_ONLY = `owner ${PUB.owner}\n`;
const TWO_PINNED = `owner ${PUB.owner}\nbob ${PUB.bob}\n`;
const APPROVE = join(process.cwd(), '../../deploy/seed-approve.sh');

const HOUR = 60 * 60 * 1000;
const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const KEY = `reseed_${RUN}`;
const PHONE = testPhone();
const EMAIL = `owner.${RUN}@example.invalid`;
const userIds: string[] = [];
let ownerId = '';
let priorIdentity: { deploymentId: string; environment: string; note: string | null } | null = null;
const setAside: Array<{ id: string; roles: UserRole[]; activeRole: UserRole }> = [];

const yesFor = (request: string) => ({ SEED_APPROVE_YES: /^nonce: ([0-9a-f]+)$/m.exec(request)?.[1] ?? 'missing-nonce' });
/** seed-approve.sh as `name`, typing the owner's email when the request names one. */
function signWith(name: string, request: string): { line: SignedApproval; shown: string } {
  const r = spawnSync('bash', [APPROVE, name, join(KEYDIR, name)], { input: request, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...yesFor(request), SEED_APPROVE_EMAIL: EMAIL } });
  expect(r.status, r.stderr).toBe(0);
  return { line: JSON.parse(r.stdout.trim()) as SignedApproval, shown: r.stderr };
}
const sign = (name: string, request: string) => signWith(name, request).line;

const setIdentity = (environment: string) => prisma.deploymentIdentity.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', deploymentId: 'dep-test', environment }, update: { deploymentId: 'dep-test', environment } });
const desiredFor = (value: number): DesiredConfig => ({ version: `reseed-${value}`, platformConfig: [{ key: KEY, value }], countries: [], zones: [], algoConfig: [], zoneFares: [] });
const keyValue = async () => (await prisma.platformConfig.findUnique({ where: { key: KEY } }))?.value ?? null;
const ctxFor = (over: Partial<RequestContext> = {}): RequestContext => ({ fxGydPerUsd: 209, adminPhone: PHONE, adminEmail: EMAIL, soloReseed: true, ...over });
const nonceOf = (request: string) => /^nonce: (.+)$/m.exec(request)![1]!;
const consumedFor = (request: string) => prisma.privilegedChangeAudit.count({ where: { action: 'SEED_APPROVAL_CONSUMED', detail: { path: ['nonce'], equals: nonceOf(request) } } });
const reseedRows = (request: string) => prisma.privilegedChangeAudit.findMany({ where: { action: SOLO_RESEED_ACTION, detail: { path: ['nonce'], equals: nonceOf(request) } }, orderBy: { createdAt: 'asc' } });
const eventsFor = async (line: SignedApproval) => {
  // The rows of one wait share the approval's consumption key; the REQUESTED row carries the nonce.
  const requested = await prisma.privilegedChangeAudit.findFirst({ where: { action: SOLO_RESEED_ACTION, event: 'REQUESTED', detail: { path: ['nonce'], equals: nonceOf(Buffer.from(line.request, 'base64').toString('utf8')) } } });
  if (!requested) return [];
  return (await prisma.privilegedChangeAudit.findMany({ where: { action: SOLO_RESEED_ACTION, planDigest: requested.planDigest }, orderBy: { createdAt: 'asc' } })).map((r) => r.event);
};
const notices = (channel: 'email' | 'sms') => devChannelLog.filter((e) => e.channel === channel && e.to === (channel === 'email' ? EMAIL : PHONE));
const CODE = /confirmation code is (\d{6})/;
const codesTexted = () => notices('sms').filter((e) => CODE.test(e.body)).length;
/** The owner reading the code off their phone: the newest code texted to PHONE. */
const rightCode = async () => CODE.exec([...notices('sms')].reverse().find((e) => CODE.test(e.body))!.body)![1]!;
const wrongCode = async () => '000000';

/** A production plan with one real change, and a solo re-seed request for it issued `ago` before now. */
async function reseedCase(value: number, ago = 0) {
  await prisma.platformConfig.deleteMany({ where: { key: KEY } });
  const desired = desiredFor(value);
  const plan = await buildSeedPlan(prisma, URL_, desired);
  const ctx = ctxFor();
  const request = planApprovalRequest(plan, ctx, new Date(Date.now() - ago));
  return { desired, plan, ctx, request };
}
/** A signed solo re-seed whose 12-hour wait started 13 hours ago (so it may run now). */
async function startedCase(value: number) {
  const c = await reseedCase(value, 13 * HOUR + 60_000);
  const line = sign('owner', c.request);
  await startSoloReseed(prisma, URL_, c.desired, c.plan, { approvals: [line], approverKeys: OWNER_ONLY, request: c.ctx, actor: 'owner', now: new Date(Date.now() - 13 * HOUR) });
  return { ...c, line };
}
const applyWith = (c: Awaited<ReturnType<typeof reseedCase>>, line: SignedApproval, extra: Record<string, unknown> = {}) =>
  applySeedPlan(prisma, URL_, c.desired, c.plan, { approvals: [line], approverKeys: OWNER_ONLY, request: c.ctx, actor: 'owner', ...extra });

async function makeAdmin(role: UserRole = 'ADMIN'): Promise<string> {
  const u = await prisma.user.create({ data: { phone: testPhone(), firstName: 'Second', lastName: 'Admin', roles: [role, 'CUSTOMER'], activeRole: role, status: 'ACTIVE' }, select: { id: true } });
  userIds.push(u.id);
  return u.id;
}
const demote = (id: string) => prisma.user.update({ where: { id }, data: { roles: { set: ['CUSTOMER'] }, activeRole: 'CUSTOMER' } });

beforeAll(async () => {
  await prisma.$connect();
  priorIdentity = await prisma.deploymentIdentity.findUnique({ where: { id: 'singleton' } });
  await setIdentity('production');
  // The owner is the ONLY admin: every other admin account of the suite's database is set aside, then restored.
  const admins = await prisma.user.findMany({
    where: { OR: [{ roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] } }, { activeRole: { in: ['ADMIN', 'SUPER_ADMIN'] } }] },
    select: { id: true, roles: true, activeRole: true },
  });
  for (const u of admins) {
    setAside.push(u);
    const rest = u.roles.filter((r) => r !== 'ADMIN' && r !== 'SUPER_ADMIN');
    const roles: UserRole[] = rest.length > 0 ? rest : ['CUSTOMER'];
    await prisma.user.update({ where: { id: u.id }, data: { roles: { set: roles }, activeRole: roles.includes(u.activeRole) ? u.activeRole : roles[0]! } });
  }
  const owner = await prisma.user.create({ data: { phone: PHONE, email: EMAIL, firstName: 'Swift', lastName: 'Owner', roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true }, select: { id: true } });
  ownerId = owner.id;
  userIds.push(owner.id);
});
afterAll(async () => {
  rmSync(KEYDIR, { recursive: true, force: true });
  await prisma.platformConfig.deleteMany({ where: { key: KEY } }).catch(() => {});
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  for (const u of setAside) await prisma.user.update({ where: { id: u.id }, data: { roles: { set: u.roles }, activeRole: u.activeRole } }).catch(() => {});
  if (priorIdentity) await prisma.deploymentIdentity.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...priorIdentity }, update: priorIdentity });
  else await prisma.deploymentIdentity.deleteMany({ where: { id: 'singleton' } }).catch(() => {});
  await prisma.$disconnect();
});
beforeEach(() => {
  fail.email = false;
  fail.sms = false;
  resetDevChannelLog();
});

describe('[SOLO RE-SEED] the request says it is a solo re-seed, in its own words', () => {
  it('carries the solo re-seed line, the only admin\'s phone and email, and is valid 48 hours; the signer reads it', async () => {
    const { request } = await reseedCase(1);
    expect(request).toContain(`\n${SOLO_RESEED_SHOW_LINE}\n`);
    expect(request).not.toContain(SOLO_SHOW_LINE);
    expect(request).toContain(`\nadmin phone: ending ${PHONE.slice(-4)}, the only admin, gets the sign-in code and the notices\n`);
    expect(request).toMatch(/\nadmin email: o…@example\.invalid \(sha256 [0-9a-f]{64}\) is set on that account if it has no email\n/);
    expect(request).not.toContain(EMAIL);
    const issued = Date.parse(/^issued: (.+)$/m.exec(request)![1]!);
    const expires = Date.parse(/^expires: (.+)$/m.exec(request)![1]!);
    expect(expires - issued).toBe(SOLO_DEFAULT_LIFETIME_MS);
    expect(signWith('owner', request).shown).toContain(SOLO_RESEED_SHOW_LINE);
  });

  it('needs the only admin\'s phone and email, and is never also the first-seed solo', async () => {
    const { plan } = await reseedCase(2);
    expect(() => planRequestFacts(plan, ctxFor({ adminPhone: null, adminEmail: null }))).toThrow(/SOLO_NOT_ALLOWED/);
    expect(() => planRequestFacts(plan, ctxFor({ adminPhone: null }))).toThrow(/EMAIL_WITHOUT_ADMIN/);
    expect(() => planRequestFacts(plan, ctxFor({ adminEmail: null }))).toThrow(/SOLO_NOT_ALLOWED/);
    expect(() => planRequestFacts(plan, ctxFor({ solo: true }))).toThrow(/SOLO_MODE_AMBIGUOUS/);
  });
});

describe('[SOLO RE-SEED] starting the 12-hour wait: an audit row, an email and a text, all or nothing', () => {
  it('the signed line starts the wait, tells the owner by email and text, and changes nothing yet', async () => {
    const c = await reseedCase(3);
    const line = sign('owner', c.request);
    const before = Date.now();
    const started = await startSoloReseed(prisma, URL_, c.desired, c.plan, { approvals: [line], approverKeys: OWNER_ONLY, request: c.ctx, actor: 'owner' });
    expect(started.eligibleAt.getTime()).toBeGreaterThanOrEqual(before + SOLO_COOLING_OFF_MS);
    const rows = await reseedRows(c.request);
    expect(rows.map((r) => r.event)).toEqual(['REQUESTED']);
    expect(rows[0]!.detail).toMatchObject({ plan: c.plan.digest, configVersion: 'reseed-3', changes: 1, approver: 'owner', userId: ownerId, eligibleAt: started.eligibleAt.toISOString(), coolOffHours: 12 });
    expect(notices('email')).toHaveLength(1);
    expect(notices('email')[0]!.title).toContain('re-seed is waiting');
    expect(notices('email')[0]!.body).toContain('SEED_SOLO_CANCEL=1');
    expect(notices('sms')).toHaveLength(1);
    expect(notices('sms')[0]!.body).toContain('re-seed');
    expect(await keyValue()).toBeNull();
    expect(await consumedFor(c.request)).toBe(0);
    // Started once: the same line again is refused and starts nothing new.
    await expect(startSoloReseed(prisma, URL_, c.desired, c.plan, { approvals: [line], approverKeys: OWNER_ONLY, request: c.ctx })).rejects.toMatchObject({ code: 'SOLO_ALREADY_STARTED' });
    expect((await reseedRows(c.request)).length).toBe(1);
  });

  it('an email or a text that cannot go starts nothing', async () => {
    for (const down of ['email', 'sms'] as const) {
      const c = await reseedCase(down === 'email' ? 4 : 5);
      const line = sign('owner', c.request);
      fail[down] = true;
      const err = await startSoloReseed(prisma, URL_, c.desired, c.plan, { approvals: [line], approverKeys: OWNER_ONLY, request: c.ctx }).catch((e: unknown) => e);
      fail[down] = false;
      expect((err as { code?: string }).code, down).toBe(down === 'email' ? 'SOLO_EMAIL_UNAVAILABLE' : 'SOLO_SMS_UNAVAILABLE');
      expect(await reseedRows(c.request), down).toHaveLength(0);
      expect(await keyValue()).toBeNull();
    }
  });

  it('refused when it is not the owner alone: a second admin, another phone, another email, an email changed this week', async () => {
    const c = await reseedCase(6);
    const line = sign('owner', c.request);
    const start = (ctx: RequestContext, ln = line) => startSoloReseed(prisma, URL_, c.desired, c.plan, { approvals: [ln], approverKeys: OWNER_ONLY, request: ctx });
    const second = await makeAdmin();
    try {
      await expect(start(c.ctx)).rejects.toMatchObject({ code: 'SOLO_SECOND_ADMIN' });
    } finally {
      await demote(second);
    }
    // Another phone or address is other words: the line signed for the owner's does not match them.
    const otherPhone = ctxFor({ adminPhone: testPhone() });
    await expect(start(otherPhone, sign('owner', planApprovalRequest(c.plan, otherPhone)))).rejects.toMatchObject({ code: 'SOLO_NOT_OWNER' });
    const otherEmail = { ...ctxFor(), adminEmail: `other.${RUN}@example.invalid` };
    const otherEmailRequest = planApprovalRequest(c.plan, otherEmail);
    const otherEmailLine = JSON.parse(spawnSync('bash', [APPROVE, 'owner', join(KEYDIR, 'owner')], { input: otherEmailRequest, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...yesFor(otherEmailRequest), SEED_APPROVE_EMAIL: otherEmail.adminEmail } }).stdout.trim()) as SignedApproval;
    await expect(start(otherEmail, otherEmailLine)).rejects.toMatchObject({ code: 'SOLO_EMAIL_MISMATCH' });
    await prisma.user.update({ where: { id: ownerId }, data: { emailChangedAt: new Date(Date.now() - 2 * 24 * HOUR) } });
    try {
      await expect(start(c.ctx)).rejects.toMatchObject({ code: 'SOLO_EMAIL_RECENT' });
    } finally {
      await prisma.user.update({ where: { id: ownerId }, data: { emailChangedAt: null } });
    }
    expect(await reseedRows(c.request)).toHaveLength(0);
    expect(notices('email')).toHaveLength(0);
  });

  it('refused for a plan with nothing to change, and for a request that would expire before its wait ends', async () => {
    await prisma.platformConfig.upsert({ where: { key: KEY }, create: { key: KEY, value: 7 }, update: { value: 7 } });
    const desired = desiredFor(7);
    const empty = await buildSeedPlan(prisma, URL_, desired);
    expect(empty.changes).toHaveLength(0);
    const emptyRequest = planApprovalRequest(empty, ctxFor());
    await expect(startSoloReseed(prisma, URL_, desired, empty, { approvals: [sign('owner', emptyRequest)], approverKeys: OWNER_ONLY, request: ctxFor() })).rejects.toMatchObject({ code: 'SOLO_NOTHING_TO_CHANGE' });
    const old = await reseedCase(8, 40 * HOUR);
    await expect(startSoloReseed(prisma, URL_, old.desired, old.plan, { approvals: [sign('owner', old.request)], approverKeys: OWNER_ONLY, request: old.ctx })).rejects.toMatchObject({ code: 'SOLO_REQUEST_TOO_OLD' });
    expect(await reseedRows(old.request)).toHaveLength(0);
  });
});

describe('[SOLO RE-SEED] exactly ONE pinned key, the owner\'s, bound to the wait it started [security review M1]', () => {
  it('with two pinned keys (the two-person world) a solo re-seed neither starts nor applies', async () => {
    const c = await reseedCase(23);
    const line = sign('owner', c.request);
    await expect(startSoloReseed(prisma, URL_, c.desired, c.plan, { approvals: [line], approverKeys: TWO_PINNED, request: c.ctx })).rejects.toMatchObject({ code: 'SOLO_TWO_PINNED' });
    expect(await reseedRows(c.request)).toHaveLength(0);
    expect(notices('email')).toHaveLength(0);
    // Started with the owner's key alone; a second key pinned during the wait stops the apply before any code.
    const s = await startedCase(24);
    resetDevChannelLog();
    await expect(applySeedPlan(prisma, URL_, s.desired, s.plan, { approvals: [s.line], approverKeys: TWO_PINNED, request: s.ctx, readSignInCode: rightCode })).rejects.toMatchObject({ code: 'SOLO_TWO_PINNED' });
    expect(codesTexted()).toBe(0);
    expect(await keyValue()).toBeNull();
    expect(await consumedFor(s.request)).toBe(0);
  });

  it('the started row names the pinned key and the owner account; the same name re-pinned to another key never runs it', async () => {
    const s = await startedCase(25);
    const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(PUB.owner.split(' ')[1]!, 'base64')).digest('base64').replace(/=+$/, '')}`;
    expect((await reseedRows(s.request))[0]!.detail).toMatchObject({ approver: 'owner', fingerprint, userId: ownerId });
    resetDevChannelLog();
    await expect(applySeedPlan(prisma, URL_, s.desired, s.plan, { approvals: [s.line], approverKeys: `owner ${PUB.bob}\n`, request: s.ctx, readSignInCode: rightCode })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    expect(codesTexted()).toBe(0);
    expect(await keyValue()).toBeNull();
  });
});

describe('[SOLO RE-SEED] the wait: refused before it ends, cancellable during it', () => {
  it('[security review M2] a cancel through another form of the connection string still finds the waiting re-seed, lists it, and the apply stops', async () => {
    const s = await startedCase(26);
    const u = new URL(URL_);
    u.hostname = u.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    const other = u.toString();
    expect(other).not.toBe(URL_);
    const alt = new PrismaClient({ datasourceUrl: other });
    try {
      const cancelled = await cancelSoloReseeds(alt, other, { actor: 'owner' });
      expect(cancelled.find((x) => x.plan === s.plan.digest)).toMatchObject({ configVersion: 'reseed-26', changes: 1, approver: 'owner' });
    } finally {
      await alt.$disconnect();
    }
    expect(await eventsFor(s.line)).toEqual(['REQUESTED', 'CANCELLED']);
    resetDevChannelLog();
    await expect(applyWith(s, s.line, { readSignInCode: rightCode })).rejects.toMatchObject({ code: 'SOLO_CANCELLED' });
    expect(codesTexted()).toBe(0);
    expect(await keyValue()).toBeNull();
    expect(await consumedFor(s.request)).toBe(0);
  });

  it('not started: the signed line is refused at apply (starting the wait is its own step)', async () => {
    const c = await reseedCase(9);
    await expect(applyWith(c, sign('owner', c.request), { readSignInCode: rightCode })).rejects.toMatchObject({ code: 'SOLO_NOT_STARTED' });
    expect(codesTexted()).toBe(0);
    expect(await keyValue()).toBeNull();
  });

  it('before the 12 hours end it is refused and told when it may run; no code is texted and nothing changes', async () => {
    const c = await reseedCase(10);
    const line = sign('owner', c.request);
    const started = await startSoloReseed(prisma, URL_, c.desired, c.plan, { approvals: [line], approverKeys: OWNER_ONLY, request: c.ctx });
    const err = await applyWith(c, line, { readSignInCode: rightCode }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'COOLING_OFF' });
    expect(String((err as Error).message)).toContain(started.eligibleAt.toISOString());
    // Eleven hours later it still waits.
    await expect(applyWith(c, line, { readSignInCode: rightCode, now: new Date(Date.now() + 11 * HOUR) })).rejects.toMatchObject({ code: 'COOLING_OFF' });
    expect(codesTexted()).toBe(0);
    expect(await keyValue()).toBeNull();
    expect(await consumedFor(c.request)).toBe(0);
  });

  it('cancelled during the wait: it never runs, cannot be started again, and the cancel is in the audit', async () => {
    const c = await startedCase(11);
    expect((await cancelSoloReseeds(prisma, URL_, { actor: 'owner' })).length).toBeGreaterThanOrEqual(1);
    expect(await eventsFor(c.line)).toEqual(['REQUESTED', 'CANCELLED']);
    await expect(applyWith(c, c.line, { readSignInCode: rightCode })).rejects.toMatchObject({ code: 'SOLO_CANCELLED' });
    await expect(startSoloReseed(prisma, URL_, c.desired, c.plan, { approvals: [c.line], approverKeys: OWNER_ONLY, request: c.ctx })).rejects.toMatchObject({ code: 'SOLO_CANCELLED' });
    expect(codesTexted()).toBe(0);
    expect(await keyValue()).toBeNull();
    expect(await consumedFor(c.request)).toBe(0);
    // Nothing is left waiting.
    expect(await cancelSoloReseeds(prisma, URL_)).toEqual([]);
  });
});

describe('[SOLO RE-SEED] the fresh sign-in code (step-up) at apply', () => {
  it('without a way to type the code it is refused: no code texted, nothing changes, the approval is not spent', async () => {
    const c = await startedCase(12);
    await expect(applyWith(c, c.line)).rejects.toMatchObject({ code: 'SIGN_IN_CODE_REQUIRED' });
    expect(codesTexted()).toBe(0);
    expect(await keyValue()).toBeNull();
    expect(await consumedFor(c.request)).toBe(0);
  });

  it('a wrong code is refused and recorded; the third cancels the re-seed for good', async () => {
    const c = await startedCase(13);
    for (let i = 1; i < SOLO_RESEED_MAX_WRONG_CODES; i++) {
      await expect(applyWith(c, c.line, { readSignInCode: wrongCode })).rejects.toMatchObject({ code: 'SIGN_IN_CODE_WRONG' });
    }
    await expect(applyWith(c, c.line, { readSignInCode: async () => '' })).rejects.toMatchObject({ code: 'SOLO_CANCELLED' });
    expect(codesTexted()).toBe(SOLO_RESEED_MAX_WRONG_CODES);
    // The third refusal and the cancel share one transaction (one timestamp): compare as a set of rows.
    expect((await eventsFor(c.line)).sort()).toEqual(['REQUESTED', ...Array(SOLO_RESEED_MAX_WRONG_CODES).fill('CODE_REFUSED'), 'CANCELLED'].sort());
    // Even the right code cannot run it now.
    await expect(applyWith(c, c.line, { readSignInCode: rightCode })).rejects.toMatchObject({ code: 'SOLO_CANCELLED' });
    expect(await keyValue()).toBeNull();
    expect(await consumedFor(c.request)).toBe(0);
  });
});

describe('[SOLO RE-SEED] still the only admin, counted again at apply', () => {
  it('a second admin who appeared during the wait turns solo off before any code is texted', async () => {
    const c = await startedCase(14);
    const second = await makeAdmin('SUPER_ADMIN');
    try {
      await expect(applyWith(c, c.line, { readSignInCode: rightCode })).rejects.toMatchObject({ code: 'SOLO_SECOND_ADMIN' });
    } finally {
      await demote(second);
    }
    expect(codesTexted()).toBe(0);
    expect(await keyValue()).toBeNull();
    expect(await consumedFor(c.request)).toBe(0);
  });

  it('a second admin who appears inside the apply, after the code: nothing lands and the approval is not spent', async () => {
    const c = await startedCase(15);
    const second = await makeAdmin();
    await demote(second);
    const failpoint = async (boundary: string) => {
      if (boundary === 'after-drift-check') await prisma.user.update({ where: { id: second }, data: { roles: { set: ['ADMIN', 'CUSTOMER'] }, activeRole: 'ADMIN' } });
    };
    try {
      await expect(applyWith(c, c.line, { readSignInCode: rightCode, failpoint })).rejects.toMatchObject({ code: 'SOLO_SECOND_ADMIN' });
    } finally {
      await demote(second);
    }
    expect(await keyValue()).toBeNull();
    expect(await consumedFor(c.request)).toBe(0);
    expect(await eventsFor(c.line)).toEqual(['REQUESTED']);
  });
});

describe('[SOLO RE-SEED] after the wait, with the code: applied once, audited, emailed and texted', () => {
  it('applies the plan, keeps the signed record, writes the audit, emails and texts the owner; a replay is refused', async () => {
    const c = await startedCase(16);
    resetDevChannelLog();
    const res = await applyWith(c, c.line, { readSignInCode: rightCode });
    expect(res.applied).toBe(1);
    expect(res.firstAdmin).toBeNull();
    expect(await keyValue()).toBe(16);
    const applied = await prisma.privilegedChangeAudit.findFirstOrThrow({ where: { action: 'SEED_CONFIG', planDigest: c.plan.digest, event: 'APPLIED' } });
    expect(applied.detail).toMatchObject({ configVersion: 'reseed-16', approvers: ['owner'], solo: true, soloReseed: true, signInCode: true, firstAdmin: false });
    const consumed = await prisma.privilegedChangeAudit.findFirstOrThrow({ where: { action: 'SEED_APPROVAL_CONSUMED', detail: { path: ['nonce'], equals: nonceOf(c.request) } } });
    expect(consumed.detail).toMatchObject({ for: 'SEED_CONFIG', mode: 'solo', approver: 'owner', request: c.line.request, signature: c.line.signature });
    expect(await eventsFor(c.line)).toEqual(['REQUESTED', 'APPLIED']);
    expect(notices('email').map((e) => e.title)).toEqual(['Swift: production settings re-seed applied (solo approval)']);
    expect(notices('sms').map((e) => (CODE.test(e.body) ? 'code' : 'applied'))).toEqual(['code', 'applied']);
    expect(notices('sms')[1]!.body).not.toMatch(/\d{6}/);
    // Single use: roll the data back and run the same line again.
    await prisma.platformConfig.deleteMany({ where: { key: KEY } });
    await expect(applyWith(c, c.line, { readSignInCode: rightCode })).rejects.toMatchObject({ code: 'APPROVAL_REPLAYED' });
    expect(await keyValue()).toBeNull();
  });

  it('a closing email that cannot go rolls the whole re-seed back: nothing changed, the approval unspent', async () => {
    const c = await startedCase(17);
    // The code goes by text; only the closing email fails.
    const err = await applyWith(c, c.line, { readSignInCode: async () => { const code = await rightCode(); fail.email = true; return code; } }).catch((e: unknown) => e);
    fail.email = false;
    expect((err as { code?: string }).code).toBe('SOLO_EMAIL_UNAVAILABLE');
    expect(await keyValue()).toBeNull();
    expect(await consumedFor(c.request)).toBe(0);
    expect(await eventsFor(c.line)).toEqual(['REQUESTED']);
    expect(await prisma.privilegedChangeAudit.count({ where: { action: 'SEED_CONFIG', planDigest: c.plan.digest, event: 'APPLIED' } })).toBe(0);
  });
});

describe('[SOLO RE-SEED] the two-person ceremony and the first-seed solo are unchanged', () => {
  it('two pinned people still apply a re-seed, with the owner alone or beside a second admin, and no solo marks', async () => {
    for (const withSecond of [false, true]) {
      const value = withSecond ? 19 : 18;
      await prisma.platformConfig.deleteMany({ where: { key: KEY } });
      const desired = desiredFor(value);
      const plan = await buildSeedPlan(prisma, URL_, desired);
      const second = withSecond ? await makeAdmin() : null;
      try {
        const twoCtx = { fxGydPerUsd: 209, adminPhone: null };
        const two = planApprovalRequest(plan, twoCtx);
        expect(two).not.toContain('approval: one person');
        const res = await applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign('owner', two), sign('bob', two)], approverKeys: TWO_PINNED, request: twoCtx });
        expect(res.applied).toBe(1);
        const row = await prisma.privilegedChangeAudit.findFirstOrThrow({ where: { action: 'SEED_CONFIG', planDigest: plan.digest, event: 'APPLIED' } });
        expect(row.detail).toMatchObject({ approvers: ['owner', 'bob'] });
        expect(row.detail).not.toHaveProperty('solo');
        expect(row.detail).not.toHaveProperty('soloReseed');
        expect(await keyValue()).toBe(value);
      } finally {
        if (second) await demote(second);
      }
    }
    // Without approvals the two-person path still refuses.
    const c = await reseedCase(20);
    await expect(applySeedPlan(prisma, URL_, c.desired, c.plan, { request: { fxGydPerUsd: 209, adminPhone: null } })).rejects.toMatchObject({ code: 'APPROVALS_REQUIRED' });
  });

  it('words never cross: solo re-seed vs two-person vs first-seed solo, and one line only', async () => {
    const c = await startedCase(21);
    // The solo re-seed line used as one of two on the two-person path.
    const twoCtx = { fxGydPerUsd: 209, adminPhone: PHONE, adminEmail: EMAIL };
    await expect(applySeedPlan(prisma, URL_, c.desired, c.plan, { approvals: [c.line, sign('bob', c.request)], approverKeys: TWO_PINNED, request: twoCtx })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    // A two-person request, or a first-seed solo request, used as a solo re-seed.
    const twoPerson = approvalRequest(planRequestFacts(c.plan, twoCtx), new Date(Date.now() - 13 * HOUR));
    await expect(startSoloReseed(prisma, URL_, c.desired, c.plan, { approvals: [sign('owner', twoPerson)], approverKeys: OWNER_ONLY, request: c.ctx })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    const firstSeed = approvalRequest(planRequestFacts(c.plan, { ...twoCtx, solo: true }), new Date(Date.now() - 13 * HOUR), SOLO_DEFAULT_LIFETIME_MS);
    await expect(startSoloReseed(prisma, URL_, c.desired, c.plan, { approvals: [sign('owner', firstSeed)], approverKeys: OWNER_ONLY, request: c.ctx })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    // Two lines are never a solo re-seed (with one pinned key, or with two: the two-person world).
    await expect(applySeedPlan(prisma, URL_, c.desired, c.plan, { approvals: [c.line, sign('bob', c.request)], approverKeys: OWNER_ONLY, request: c.ctx, readSignInCode: rightCode })).rejects.toMatchObject({ code: 'SOLO_ONE_APPROVAL' });
    await expect(applySeedPlan(prisma, URL_, c.desired, c.plan, { approvals: [c.line, sign('bob', c.request)], approverKeys: TWO_PINNED, request: c.ctx, readSignInCode: rightCode })).rejects.toMatchObject({ code: 'SOLO_TWO_PINNED' });
    // The first-seed solo still refuses once a SUPER_ADMIN exists (unchanged).
    await expect(applySeedPlan(prisma, URL_, c.desired, c.plan, { request: { ...twoCtx, solo: true } })).rejects.toMatchObject({ code: 'SOLO_NOT_ALLOWED' });
    expect(await keyValue()).toBeNull();
    expect(codesTexted()).toBe(0);
  });

  it('with no admin at all there is no solo re-seed (the first seed has its own solo)', async () => {
    await demote(ownerId);
    try {
      const c = await reseedCase(22);
      await expect(startSoloReseed(prisma, URL_, c.desired, c.plan, { approvals: [sign('owner', c.request)], approverKeys: OWNER_ONLY, request: c.ctx })).rejects.toMatchObject({ code: 'SOLO_NO_ADMIN' });
      expect(await reseedRows(c.request)).toHaveLength(0);
    } finally {
      await prisma.user.update({ where: { id: ownerId }, data: { roles: { set: ['SUPER_ADMIN', 'CUSTOMER'] }, activeRole: 'SUPER_ADMIN' } });
    }
  });
});

describe('[SOLO RE-SEED] the owner\'s notices must be able to leave', () => {
  const SMTP = { EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'mail.example.invalid', SMTP_PORT: '465', SMTP_USER: 'owner', SMTP_PASS: 'not-a-real-password', EMAIL_FROM: 'Swift <noreply@example.invalid>' };
  const TWILIO = { NOTIFICATION_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`, TWILIO_API_KEY_SID: `SK${'0'.repeat(32)}`, TWILIO_API_KEY_SECRET: 'not-a-real-secret', TWILIO_MESSAGING_SERVICE_SID: `MG${'0'.repeat(32)}` };
  it('production needs real email (SMTP) and real texts (Twilio); a test run uses the dev adapters', () => {
    expect(soloNoticeChannelsReady({ NODE_ENV: 'production' })).toBe('email');
    expect(soloNoticeChannelsReady({ NODE_ENV: 'production', ...SMTP })).toBe('text');
    expect(soloNoticeChannelsReady({ NODE_ENV: 'production', ...SMTP, ...TWILIO, TWILIO_API_KEY_SECRET: '' })).toBe('text');
    expect(soloNoticeChannelsReady({ NODE_ENV: 'production', ...SMTP, ...TWILIO })).toBeNull();
    expect(soloNoticeChannelsReady({ NODE_ENV: 'test' })).toBeNull();
  });
});

describe('[SOLO RE-SEED] the real seed entry point', () => {
  const run = (extra: Record<string, string>, input = '') => spawnSync(join(process.cwd(), 'node_modules/.bin/tsx'), ['prisma/seed-production.ts'], {
    encoding: 'utf8',
    timeout: 120_000,
    input,
    env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test', DATABASE_URL: URL_, SEED_ADMIN_PHONE: PHONE, SEED_ADMIN_EMAIL: EMAIL, SEED_SOLO: '1', ...extra },
  });
  /** One real spine change, so the entry point's plan has something to re-seed. */
  async function withSpineChange<T>(fn: () => Promise<T>): Promise<T> {
    const first = desiredPlatformConfig().platformConfig[0]!;
    const prior = await prisma.platformConfig.findUnique({ where: { key: first.key } });
    await prisma.platformConfig.upsert({ where: { key: first.key }, create: { key: first.key, value: `reseed-test-${RUN}` }, update: { value: `reseed-test-${RUN}` } });
    try {
      return await fn();
    } finally {
      if (prior) await prisma.platformConfig.update({ where: { key: first.key }, data: { value: prior.value as never } });
      else await prisma.platformConfig.deleteMany({ where: { key: first.key } });
    }
  }

  it('SEED_SOLO=1 prints a solo re-seed request (2); its line starts the wait (4); again is too early; SEED_SOLO_CANCEL=1 cancels it', async () => {
    await cancelSoloReseeds(prisma, URL_); // the module tests above leave waits standing; start from none
    await withSpineChange(async () => {
      const first = run({});
      expect(first.status, first.stderr).toBe(2);
      expect(first.stdout).toContain(`\n${SOLO_RESEED_SHOW_LINE}\n`);
      expect(first.stderr).toContain('12-hour wait');
      const line = sign('owner', first.stdout);
      const env = { SEED_PLAN_APPROVALS: JSON.stringify([line]), SEED_APPROVER_KEYS: OWNER_ONLY };
      const started = run(env);
      expect(started.status, started.stderr).toBe(4);
      expect(started.stderr).toContain('Solo re-seed STARTED');
      expect(await eventsFor(line)).toEqual(['REQUESTED']);
      const early = run(env);
      expect(early.status).toBe(1);
      expect(early.stderr).toContain('COOLING_OFF');
      const cancel = run({ SEED_SOLO: '', SEED_SOLO_CANCEL: '1', SEED_ADMIN_PHONE: '', SEED_ADMIN_EMAIL: '' });
      expect(cancel.status, cancel.stderr).toBe(0);
      expect(cancel.stderr).toContain('Cancelled 1 waiting solo re-seed');
      expect(await eventsFor(line)).toEqual(['REQUESTED', 'CANCELLED']);
      const after = run(env);
      expect(after.status).toBe(1);
      expect(after.stderr).toContain('SOLO_CANCELLED');
    });
  }, 600_000);

  it('after the wait, the entry point texts a code and reads it from its terminal: a wrong or missing code changes nothing', async () => {
    await withSpineChange(async () => {
      const plan = await buildSeedPlan(prisma, URL_, desiredPlatformConfig());
      const ctx = spineRequestContext(PHONE, false, EMAIL, true);
      const request = planApprovalRequest(plan, ctx, new Date(Date.now() - 13 * HOUR - 60_000));
      const line = sign('owner', request);
      await startSoloReseed(prisma, URL_, desiredPlatformConfig(), plan, { approvals: [line], approverKeys: OWNER_ONLY, request: ctx, now: new Date(Date.now() - 13 * HOUR) });
      const env = { SEED_PLAN_APPROVALS: JSON.stringify([line]), SEED_APPROVER_KEYS: OWNER_ONLY };
      const wrong = run(env, '000000\n');
      expect(wrong.status).toBe(1);
      expect(wrong.stderr).toContain('A sign-in code was texted to the phone ending');
      expect(wrong.stderr).toContain('SIGN_IN_CODE_WRONG');
      const none = run(env, '');
      expect(none.status).toBe(1);
      expect(none.stderr).toContain('SIGN_IN_CODE_WRONG');
      expect(await eventsFor(line)).toEqual(['REQUESTED', 'CODE_REFUSED', 'CODE_REFUSED']);
      expect(await consumedFor(request)).toBe(0);
      expect((await cancelSoloReseeds(prisma, URL_)).length).toBeGreaterThanOrEqual(1);
    });
  }, 600_000);

  it('SEED_SOLO_CANCEL is exactly 1 or unset: anything else refuses before anything', () => {
    const r = run({ SEED_SOLO_CANCEL: 'yes' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SEED_SOLO_CANCEL must be exactly 1');
  });
});
