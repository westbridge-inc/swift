import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient, type UserRole } from '@prisma/client';
import { nanoid } from 'nanoid';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { applySeedPlan, buildSeedPlan, planApprovalRequest, planRequestFacts, type DesiredConfig, type RequestContext } from '../modules/ops/seed-plan';
import { approvalRequest, canonicalRequest, parseRequest, SOLO_COOLING_OFF_MS, type RequestFacts, type SignedApproval } from '../modules/ops/approver-signatures';

// This suite pins the deployment identity singleton for the whole file and restores it after.
grantSuiteCapability('unscoped-mutation');

// ---------------------------------------------------------------------------
// [OWNER EMAIL] Opus money review 14 Oct, S2-L. The app's solo approval emails
// the owner and refuses an admin with no email (SOLO_NO_EMAIL), and no shipped
// client can add an admin email (until build 10). So the production seed takes
// the owner's email (seed-production.sh, hidden prompt) and writes it on the
// first SUPER_ADMIN's account, inside the signed plan's transaction:
//   - the approver reads it, masked, and the signature binds its digest;
//   - it is written only where the account has none; a different address is
//     never overwritten, and an address another account uses is never taken
//     (users.email is unique); either refusal writes nothing and spends no
//     approval;
//   - emailChangedAt is never written: the first address is not a change, so
//     solo approval waits only its own 12 hours.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
const URL_ = process.env['DATABASE_URL'] ?? 'postgresql://swift:swift@localhost:5434/swift_test';
const KEYDIR = mkdtempSync(join(tmpdir(), 'seed-email-approvers-'));
const makeKey = (name: string) => {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(KEYDIR, name), '-C', name]);
  return readFileSync(join(KEYDIR, `${name}.pub`), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
};
const OWNER_ONLY = `owner ${makeKey('owner')}\n`;
const APPROVE = join(process.cwd(), '../../deploy/seed-approve.sh');
const yesFor = (request: string) => ({ SEED_APPROVE_YES: /^nonce: ([0-9a-f]+)$/m.exec(request)?.[1] ?? 'missing-nonce' });
/** seed-approve.sh as the owner, confirming `typed` as the admin email he expects
 *  (SEED_APPROVE_EMAIL stands in for his hidden prompt without a terminal). */
const approve = (request: string, typed: string | null = EMAIL) => spawnSync('bash', [APPROVE, 'owner', join(KEYDIR, 'owner')], {
  input: request, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...yesFor(request), ...(typed === null ? {} : { SEED_APPROVE_EMAIL: typed }) },
});
function sign(request: string): SignedApproval {
  const r = approve(request);
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim()) as SignedApproval;
}

const HOUR = 60 * 60 * 1000;
const RUN = nanoid(6).toLowerCase();
const KEY = `owner_email_${RUN}`;
const PHONE = `+5920478${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
const EMAIL = `owner.${RUN}@example.invalid`;
const userIds: string[] = [];
let priorIdentity: { deploymentId: string; environment: string; note: string | null } | null = null;
let supers: Array<{ id: string; roles: UserRole[]; activeRole: UserRole }> = [];

const setIdentity = (environment: string) => prisma.deploymentIdentity.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', deploymentId: 'dep-test', environment }, update: { deploymentId: 'dep-test', environment } });
const desiredFor = (value: number): DesiredConfig => ({ version: `owner-email-${value}`, platformConfig: [{ key: KEY, value }], countries: [], zones: [], algoConfig: [], zoneFares: [] });
const superCount = () => prisma.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } });
const keyValue = async () => (await prisma.platformConfig.findUnique({ where: { key: KEY } }))?.value ?? null;
const consumedFor = (request: string) => prisma.privilegedChangeAudit.count({ where: { action: 'SEED_APPROVAL_CONSUMED', detail: { path: ['nonce'], equals: /^nonce: (.+)$/m.exec(request)![1]! } } });
async function noSuperAdmin(): Promise<void> {
  for (const u of await prisma.user.findMany({ where: { roles: { has: 'SUPER_ADMIN' } }, select: { id: true, roles: true, activeRole: true } })) {
    if (!supers.some((s) => s.id === u.id)) supers.push(u);
    const rest = u.roles.filter((r) => r !== 'SUPER_ADMIN');
    const roles: UserRole[] = rest.length > 0 ? rest : ['CUSTOMER'];
    await prisma.user.update({ where: { id: u.id }, data: { roles: { set: roles }, activeRole: roles.includes(u.activeRole) ? u.activeRole : roles[0]! } });
  }
  expect(await superCount()).toBe(0);
}
async function cleanUp(): Promise<void> {
  const ids = [...userIds, ...(await prisma.user.findMany({ where: { OR: [{ phone: PHONE }, { email: { contains: RUN } }] }, select: { id: true } })).map((u) => u.id)];
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.admin.deleteMany({ where: { userId: { in: ids } } });
  await prisma.customer.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  for (const u of supers) await prisma.user.update({ where: { id: u.id }, data: { roles: { set: u.roles }, activeRole: u.activeRole } });
  await prisma.platformConfig.deleteMany({ where: { key: KEY } });
}
/** A production plan with one real change, and a solo request for it signed 12 hours ago. */
async function emailCase(value: number, adminEmail: string | null) {
  await prisma.platformConfig.deleteMany({ where: { key: KEY } });
  const desired = desiredFor(value);
  const plan = await buildSeedPlan(prisma, URL_, desired);
  const ctx: RequestContext = { fxGydPerUsd: 209, adminPhone: PHONE, ...(adminEmail ? { adminEmail } : {}), solo: true };
  const request = planApprovalRequest(plan, ctx, new Date(Date.now() - SOLO_COOLING_OFF_MS - HOUR));
  return { desired, plan, ctx, request };
}

beforeAll(async () => {
  await prisma.$connect();
  priorIdentity = await prisma.deploymentIdentity.findUnique({ where: { id: 'singleton' } });
  await setIdentity('production');
});
afterAll(async () => {
  rmSync(KEYDIR, { recursive: true, force: true });
  await cleanUp().catch(() => {});
  if (priorIdentity) await prisma.deploymentIdentity.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...priorIdentity }, update: priorIdentity });
  else await prisma.deploymentIdentity.deleteMany({ where: { id: 'singleton' } }).catch(() => {});
  await prisma.$disconnect();
});

describe('[OWNER EMAIL] the approver reads the owner email, masked, and signs its digest', () => {
  it('the request shows the first letter, the domain and a digest, never the whole address', async () => {
    const { request } = await emailCase(1, EMAIL);
    const line = request.split('\n').find((l) => l.startsWith('admin email: '));
    // [SECREVIEW 14 Oct] The whole address is bound by its FULL sha256 (not a
    // 64-bit prefix), so no other address can be signed in its place.
    expect(line).toBe(`admin email: o…@example.invalid (sha256 ${createHash('sha256').update(EMAIL).digest('hex')}) is set on that account if it has no email`);
    expect(request).not.toContain(EMAIL);
    // Without an email the words are exactly as before: no email line at all.
    expect((await emailCase(1, null)).request).not.toContain('admin email:');
  });

  it('an address that is not an email, or an email with no admin to carry it, is refused before any request', async () => {
    const plan = await buildSeedPlan(prisma, URL_, desiredFor(2));
    for (const bad of ['owner', 'owner@', '@example.invalid', 'owner@example', 'own er@example.invalid', `${'a'.repeat(250)}@example.invalid`]) {
      expect(() => planRequestFacts(plan, { fxGydPerUsd: 209, adminPhone: PHONE, adminEmail: bad, solo: true }), bad).toThrow(/EMAIL_INVALID/);
    }
    expect(() => planRequestFacts(plan, { fxGydPerUsd: 209, adminPhone: null, adminEmail: EMAIL })).toThrow(/EMAIL_WITHOUT_ADMIN/);
  });

  it('a request signed with one email never applies with another, or with none', async () => {
    await noSuperAdmin();
    try {
      const { desired, plan, ctx, request } = await emailCase(3, EMAIL);
      const line = sign(request);
      for (const other of [{ ...ctx, adminEmail: `other.${RUN}@example.invalid` }, { ...ctx, adminEmail: null }]) {
        await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: [line], approverKeys: OWNER_ONLY, request: other, actor: 'owner' })).rejects.toThrow();
      }
      expect(await keyValue()).toBeNull();
      expect(await superCount()).toBe(0);
      expect(await consumedFor(request)).toBe(0);
    } finally {
      await cleanUp();
    }
  });
});

describe('[SECREVIEW 14 Oct] what the approver reads is the address the seed writes', () => {
  it('an address with a character outside plain ASCII is refused: nothing invisible, right-to-left or look-alike can show as another domain', async () => {
    const plan = await buildSeedPlan(prisma, URL_, desiredFor(8));
    for (const bad of [
      'owner@exa\u200bmple.invalid',   // zero-width space: shows as example.invalid
      'owner@\u202ednalavni.elpmaxe',  // right-to-left override: shows reversed
      'owner@ex\u0430mple.invalid',    // Cyrillic a: looks like example.invalid
      'own\u00e9r@example.invalid',    // a non-ASCII letter in the hidden local part
      'owner@example.invalid\u2060',   // word joiner at the end
    ]) {
      expect(() => planRequestFacts(plan, { fxGydPerUsd: 209, adminPhone: PHONE, adminEmail: bad, solo: true }), JSON.stringify(bad)).toThrow(/EMAIL_INVALID/);
    }
    // Plain addresses still pass.
    for (const good of [EMAIL, 'o.brien+swift_1%x@mail-1.example.invalid', 'O.Wner@Example.Invalid']) {
      expect(planRequestFacts(plan, { fxGydPerUsd: 209, adminPhone: PHONE, adminEmail: good, solo: true }).shows.some((l) => l.startsWith('admin email: '))).toBe(true);
    }
  });

  it('deploy/seed-approve.sh signs only when the approver types the same address (hidden), and never prints it', async () => {
    const { request } = await emailCase(9, EMAIL);
    const wrong = approve(request, `other.${RUN}@example.invalid`);
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain('the admin email in this request is not the address you typed; nothing signed');
    expect(wrong.stdout).toBe('');
    expect(wrong.stderr).not.toContain(`other.${RUN}`);
    // Same first letter and domain, so the masked words alone could not tell them apart.
    expect(approve(request, `o.${RUN}@example.invalid`).status).not.toBe(0);
    expect(approve(request, EMAIL.toUpperCase()).status).not.toBe(0);
    const right = approve(request, EMAIL);
    expect(right.status, right.stderr).toBe(0);
    expect(right.stdout.trim()).toMatch(/^\{"approver":"owner","request":"[A-Za-z0-9+/=]+","signature":"[A-Za-z0-9+/=]+"\}$/);
    expect(right.stdout + right.stderr).not.toContain(EMAIL);
  });

  it('deploy/seed-approve.sh refuses an admin email line that does not carry the full digest', async () => {
    const { request } = await emailCase(10, EMAIL);
    const cut = request.replace(/\(sha256 ([0-9a-f]{16})[0-9a-f]*\)/, '(sha256 $1)');
    expect(cut).not.toBe(request);
    const r = approve(cut, EMAIL);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('[SECREVIEW S4 · 14 Oct] no line an approver reads can hide or reorder text', () => {
  // Unicode format characters (category Cf): right-to-left override and
  // isolate, zero-width space, byte-order mark, soft hyphen, right-to-left mark.
  const FORMAT = ['\u202e', '\u200b', '\u2066', '\ufeff', '\u00ad', '\u200f'];
  const facts = (extra: string): RequestFacts => ({ change: 'plan', target: 'a'.repeat(64), subject: 'b'.repeat(64), admin: 'none',
    shows: [`database: swift${extra} on postgres, deployment dep-x (production)`, 'config: v1 (0123456789abcdef), 0 changes, FX 209 GYD per USD', 'admin phone: none'] });
  const forged = (extra: string, nonce: string) => canonicalRequest({ ...facts(extra), issued: new Date().toISOString(), expires: new Date(Date.now() + HOUR).toISOString(), nonce });

  it('the server never prints a request holding one, and never accepts one', () => {
    for (const ch of FORMAT) {
      expect(() => approvalRequest(facts(ch)), JSON.stringify(ch)).toThrow(/invisible or direction-changing/);
      expect(() => parseRequest(forged(ch, 'c'.repeat(32))), JSON.stringify(ch)).toThrow(/line by line/);
    }
    // Ordinary text outside ASCII still reads: an ellipsis and an accented letter.
    expect(parseRequest(approvalRequest(facts('…é'))).shows[0]).toContain('swift…é on');
  });

  it('deploy/seed-approve.sh refuses a request holding one and signs nothing', () => {
    for (const ch of FORMAT) {
      const r = approve(forged(ch, 'd'.repeat(32)), null);
      expect(r.status, JSON.stringify(ch)).not.toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('invisible or direction-changing');
    }
    expect(approve(forged('…é', 'e'.repeat(32)), null).status).toBe(0);
  });
});

describe('[OWNER EMAIL] the seed writes it on the first SUPER_ADMIN, and only there', () => {
  it('a new first admin gets the email, undated, with the mint; the audit says it was set, never what', async () => {
    await noSuperAdmin();
    try {
      const { desired, plan, ctx, request } = await emailCase(4, EMAIL);
      const res = await applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign(request)], approverKeys: OWNER_ONLY, request: ctx, actor: 'owner' });
      expect(res.firstAdmin).not.toBeNull();
      userIds.push(res.firstAdmin!.userId);
      const admin = await prisma.user.findUniqueOrThrow({ where: { id: res.firstAdmin!.userId } });
      expect(admin.email).toBe(EMAIL);
      expect(admin.roles).toContain('SUPER_ADMIN');
      // The first address is not a change: no change date, so no extra pause on solo approval.
      expect((admin as Record<string, unknown>)['emailChangedAt'] ?? null).toBeNull();
      const promoted = await prisma.privilegedChangeAudit.findFirstOrThrow({ where: { action: 'PROMOTE_SUPER_ADMIN', detail: { path: ['userId'], equals: res.firstAdmin!.userId } } });
      expect(promoted.detail).toMatchObject({ mode: 'signed-plan', solo: true, emailSet: true });
      expect(JSON.stringify(promoted)).not.toContain(EMAIL);
    } finally {
      await cleanUp();
    }
  });

  it('an existing account with the phone and no email gets it', async () => {
    await noSuperAdmin();
    try {
      const existing = await prisma.user.create({ data: { phone: PHONE, firstName: 'Own', lastName: 'Er', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE', isPhoneVerified: true } });
      userIds.push(existing.id);
      const { desired, plan, ctx, request } = await emailCase(5, EMAIL);
      const res = await applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign(request)], approverKeys: OWNER_ONLY, request: ctx, actor: 'owner' });
      expect(res.firstAdmin?.userId).toBe(existing.id);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: existing.id } })).email).toBe(EMAIL);
    } finally {
      await cleanUp();
    }
  });

  it('a different email already on that account is never overwritten: refused, nothing written, the approval not spent', async () => {
    await noSuperAdmin();
    try {
      const theirs = `kept.${RUN}@example.invalid`;
      const existing = await prisma.user.create({ data: { phone: PHONE, email: theirs, firstName: 'Own', lastName: 'Er', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE', isPhoneVerified: true } });
      userIds.push(existing.id);
      const { desired, plan, ctx, request } = await emailCase(6, EMAIL);
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign(request)], approverKeys: OWNER_ONLY, request: ctx, actor: 'owner' })).rejects.toMatchObject({ code: 'ADMIN_EMAIL_DIFFERS' });
      const after = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
      expect(after.email).toBe(theirs);
      expect(after.roles).not.toContain('SUPER_ADMIN');
      expect(await keyValue()).toBeNull();
      expect(await consumedFor(request)).toBe(0);
    } finally {
      await cleanUp();
    }
  });

  it('an email another account uses (in any case) is never taken: refused, nothing written, the approval not spent', async () => {
    await noSuperAdmin();
    try {
      const other = await prisma.user.create({ data: { phone: `+5920479${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`, email: EMAIL.toUpperCase(), firstName: 'Some', lastName: 'One', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE' } });
      userIds.push(other.id);
      const { desired, plan, ctx, request } = await emailCase(7, EMAIL);
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign(request)], approverKeys: OWNER_ONLY, request: ctx, actor: 'owner' })).rejects.toMatchObject({ code: 'ADMIN_EMAIL_TAKEN' });
      expect(await prisma.user.count({ where: { phone: PHONE } })).toBe(0);
      expect(await superCount()).toBe(0);
      expect(await keyValue()).toBeNull();
      expect(await consumedFor(request)).toBe(0);
    } finally {
      await cleanUp();
    }
  });
});
