import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { buildPlan, classify, executePlan, planDigest, signApproval, signBreakGlass, syntheticMarkersPresent, targetFingerprint, type BackupManifest, type PurgePlan } from '../modules/ops/purge-plan';

// ---------------------------------------------------------------------------
// [SCR-001 / SCR-002] The demo purge as a privileged change workflow.
//
// The register's red proof: production/staging/development/unknown targets are
// fixtures; every unknown or mismatched target fails before the first data
// query; a missing, stale, wrong-target or un-restored backup fails; two
// distinct approvers authorize the exact plan digest and changed counts
// invalidate it; a failpoint at every destructive boundary leaves an
// auditable, resumable state. SCR-002: no account is ever selected by a
// negative classification; holds quarantine; unclassified rows survive.
// ---------------------------------------------------------------------------

const URL_ = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const prisma = new PrismaClient({ datasources: { db: { url: URL_ } } });
const SECRET = `s-${nanoid(16)}`;
const RUN = `run-${nanoid(6)}`;
const userIds: string[] = []; const caseIds: string[] = [];
// [R048-001] every plan here is SCOPED to this suite's own phone range: the seed's customer and other suites' fixtures share the demo range, and an unscoped execution purged them (CI #1035).
const SCOPE_PREFIX = '+59260091';
const scope = () => ({ phonePrefix: SCOPE_PREFIX });
let priorIdentity: { deploymentId: string; environment: string; note: string | null } | null = null;
const deletedByCanonicalPath: string[] = [];
const deleteUser = async (id: string) => { deletedByCanonicalPath.push(id); await prisma.user.delete({ where: { id } }); };
// Eight random digits, not five: a 1e5 space collided with a parallel suite's row in CI (unique phone).
const phone = () => `${SCOPE_PREFIX}${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`; // inside this suite's own range; other suites' +5926009998/9999 fixtures are outside it
const otherPhone = () => `+5927${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const mk = (data: Record<string, unknown>) => prisma.user.create({ data: { firstName: 'P', lastName: 'U', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', ...data } as never }).then((u) => { userIds.push(u.id); return u; });
const setIdentity = (environment: string) => prisma.deploymentIdentity.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', deploymentId: 'dep-test', environment }, update: { deploymentId: 'dep-test', environment } });
const goodBackup = async (plan: PurgePlan): Promise<BackupManifest> => ({ targetDigest: plan.target.digest, takenAt: new Date(Date.now() - 60_000).toISOString(), restoreVerifiedAt: new Date().toISOString(), artifactDigest: 'a'.repeat(64) });
const redigest = (p: PurgePlan): PurgePlan => { const { digest: _d, ...body } = p; void _d; return { ...body, digest: planDigest(body) }; };
const twoApprovals = (plan: PurgePlan) => [signApproval(SECRET, 'alice', plan.digest), signApproval(SECRET, 'bob', plan.digest)];
const auditEvents = (digest: string) => prisma.privilegedChangeAudit.findMany({ where: { planDigest: digest }, orderBy: { createdAt: 'asc' } }).then((r) => r.map((a) => a.event));

beforeAll(async () => {
  await prisma.$connect();
  priorIdentity = await prisma.deploymentIdentity.findUnique({ where: { id: 'singleton' } });
  await setIdentity('test');
});
afterAll(async () => {
  await prisma.incidentCase.deleteMany({ where: { id: { in: caseIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  if (priorIdentity) await setIdentity(priorIdentity.environment); else await prisma.deploymentIdentity.deleteMany({ where: { id: 'singleton' } }).catch(() => {});
  await prisma.$disconnect();
});

describe('[SCR-002] the selection is positive, never a negative classification', () => {
  it('marked non-admin customers are the set; admins, unclassified and held accounts are never in it; partners are reported', async () => {
    const demo = await mk({ phone: phone(), syntheticRunId: RUN });
    const legacyRange = await mk({ phone: phone() }); // the seed's phone range, no run id
    const admin = await mk({ phone: phone(), roles: ['ADMIN', 'CUSTOMER'], activeRole: 'ADMIN' });
    const unclassified = await mk({ phone: otherPhone() });
    const partner = await mk({ phone: phone(), syntheticRunId: RUN, roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER' });
    const held = await mk({ phone: phone(), syntheticRunId: RUN });
    const kase = await prisma.incidentCase.create({ data: { caseNumber: `INC-${nanoid(8).toUpperCase()}`, severity: 'S1', category: 'SAFETY_THREAT', intake: 'OPS_CREATED', subjectUserId: held.id, summary: 'held', slaAckBy: new Date(), slaDecideBy: new Date(), legalHold: true } });
    caseIds.push(kase.id);
    const c = await classify(prisma, scope());
    expect(c.demoCustomerIds).toEqual(expect.arrayContaining([demo.id, legacyRange.id]));
    expect(c.demoCustomerIds).not.toContain(admin.id); expect(c.demoCustomerIds).not.toContain(unclassified.id); expect(c.demoCustomerIds).not.toContain(held.id); expect(c.demoCustomerIds).not.toContain(partner.id);
    expect(c.demoPartnerIds).toContain(partner.id);
    expect(c.quarantinedIds).toContain(held.id);
    expect(c.adminIds).toContain(admin.id);
    expect(await syntheticMarkersPresent(prisma)).toBeGreaterThanOrEqual(4);
  });
});

describe('[SCR-001] the register’s red proof', () => {
  it('the scope rides the digest — a plan approved for a subset cannot be widened to the rest', async () => {
    const mine = await mk({ phone: phone(), syntheticRunId: RUN });
    const outside = await mk({ phone: `+5926003${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, syntheticRunId: RUN }); // demo range, outside this suite's scope
    const plan = await buildPlan(prisma, URL_, undefined, scope());
    expect(plan.scope).toEqual({ phonePrefix: SCOPE_PREFIX });
    expect(plan.demoCustomerIds).toContain(mine.id);
    expect(plan.demoCustomerIds).not.toContain(outside.id);
    // a scope that is not inside the demo range is not a scope
    await expect(buildPlan(prisma, URL_, undefined, { phonePrefix: '+5927' })).rejects.toMatchObject({ code: 'SCOPE_INVALID' });
    const widened: PurgePlan = { ...plan, scope: { phonePrefix: '+592600' } };
    await expect(executePlan(prisma, URL_, widened, { secret: SECRET, approvals: twoApprovals(plan), backup: await goodBackup(plan), deleteUser })).rejects.toMatchObject({ code: 'PLAN_TAMPERED' });
    // honestly re-digested, the widened body is a different plan — one the approvals do not sign
    await expect(executePlan(prisma, URL_, redigest(widened), { secret: SECRET, approvals: twoApprovals(plan), backup: await goodBackup(plan), deleteUser })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    expect(deletedByCanonicalPath).toHaveLength(0);
  });

  it('an unknown or mismatched target fails before the first data query; unknown environments cannot be planned against', async () => {
    const plan = await buildPlan(prisma, URL_, undefined, scope());
    expect(plan.target).toMatchObject({ deploymentId: 'dep-test', environment: 'test' });
    // the plan binds its target: another database is refused before any data query
    // a plan whose body was edited under its carried digest is refused as tampered, before anything else
    await expect(executePlan(prisma, URL_, { ...plan, target: { ...plan.target, digest: 'f'.repeat(64) } }, { secret: SECRET, approvals: twoApprovals(plan), backup: await goodBackup(plan), deleteUser })).rejects.toMatchObject({ code: 'PLAN_TAMPERED' });
    const foreign: PurgePlan = redigest({ ...plan, target: { ...plan.target, digest: 'f'.repeat(64) } });
    await expect(executePlan(prisma, URL_, foreign, { secret: SECRET, approvals: twoApprovals(foreign), backup: await goodBackup(foreign), deleteUser })).rejects.toMatchObject({ code: 'TARGET_MISMATCH' });
    expect(deletedByCanonicalPath).toHaveLength(0);
    // a database that declares no identity is unknown, and unknown is refused
    await prisma.deploymentIdentity.delete({ where: { id: 'singleton' } });
    const unknown = await targetFingerprint(prisma, URL_);
    expect(unknown.environment).toBe('unknown');
    const unknownPlan = await buildPlan(prisma, URL_, undefined, scope());
    await expect(executePlan(prisma, URL_, unknownPlan, { secret: SECRET, approvals: twoApprovals(unknownPlan), backup: await goodBackup(unknownPlan), deleteUser })).rejects.toMatchObject({ code: 'TARGET_UNKNOWN' });
    await setIdentity('test');
  });

  it('a missing, wrong-target, stale or un-restored backup manifest fails; one approver, the same approver twice, or a wrong signature fails', async () => {
    const plan = await buildPlan(prisma, URL_, undefined, scope());
    const ok = await goodBackup(plan);
    const run = (over: Partial<{ backup: BackupManifest | null; approvals: ReturnType<typeof twoApprovals> }>) => executePlan(prisma, URL_, plan, { secret: SECRET, approvals: over.approvals ?? twoApprovals(plan), backup: over.backup === undefined ? ok : over.backup, deleteUser });
    await expect(run({ backup: null })).rejects.toMatchObject({ code: 'BACKUP_REQUIRED' });
    await expect(run({ backup: { ...ok, targetDigest: 'e'.repeat(64) } })).rejects.toMatchObject({ code: 'BACKUP_WRONG_TARGET' });
    await expect(run({ backup: { ...ok, takenAt: new Date(Date.now() - 30 * 3_600_000).toISOString() } })).rejects.toMatchObject({ code: 'BACKUP_STALE' });
    await expect(run({ backup: { ...ok, restoreVerifiedAt: new Date(Date.parse(ok.takenAt) - 1000).toISOString() } })).rejects.toMatchObject({ code: 'BACKUP_UNVERIFIED' });
    await expect(run({ approvals: [signApproval(SECRET, 'alice', plan.digest)] })).rejects.toMatchObject({ code: 'APPROVALS_REQUIRED' });
    await expect(run({ approvals: [signApproval(SECRET, 'alice', plan.digest), signApproval(SECRET, 'Alice ', plan.digest)] })).rejects.toMatchObject({ code: 'APPROVERS_NOT_DISTINCT' });
    await expect(run({ approvals: [signApproval(SECRET, 'alice', plan.digest), signApproval('other-secret', 'bob', plan.digest)] })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    expect(deletedByCanonicalPath).toHaveLength(0);
  });

  it('changed counts invalidate the approval; a failpoint after the first deletion leaves an auditable state a rerun resumes; nothing outside the set is touched', async () => {
    const plan = await buildPlan(prisma, URL_, undefined, scope());
    expect(await auditEvents(plan.digest)).toEqual(['PLANNED']);
    // drift: a new synthetic customer appears after approval
    await mk({ phone: phone(), syntheticRunId: RUN });
    await expect(executePlan(prisma, URL_, plan, { secret: SECRET, approvals: twoApprovals(plan), backup: await goodBackup(plan), deleteUser })).rejects.toMatchObject({ code: 'PLAN_DRIFT' });
    expect(await auditEvents(plan.digest)).toContain('REFUSED_DRIFT');
    // plan again; die after the first deletion
    const plan2 = await buildPlan(prisma, URL_, undefined, scope());
    const before = await classify(prisma, scope());
    let fails = 0;
    await expect(executePlan(prisma, URL_, plan2, { secret: SECRET, approvals: twoApprovals(plan2), backup: await goodBackup(plan2), deleteUser, failpoint: async (b) => { if (b === 'after-user' && fails === 0) { fails += 1; throw new Error('process died'); } } })).rejects.toThrow('process died');
    const events = await auditEvents(plan2.digest);
    expect(events.slice(0, 3)).toEqual(['PLANNED', 'STARTED', 'USER_DELETING']);
    expect(events).toContain('USER_DELETED'); expect(events[events.length - 1]).toBe('FAILED');
    expect(deletedByCanonicalPath).toHaveLength(1);
    // the audit is append-only
    const row = await prisma.privilegedChangeAudit.findFirst({ where: { planDigest: plan2.digest } });
    await expect(prisma.privilegedChangeAudit.update({ where: { id: row!.id }, data: { event: 'x' } })).rejects.toThrow(/append-only/);
    // the rerun resumes: skips the one already gone, finishes the rest, once each
    const res = await executePlan(prisma, URL_, plan2, { secret: SECRET, approvals: twoApprovals(plan2), backup: await goodBackup(plan2), deleteUser });
    expect(res.skippedAlreadyGone.length).toBeGreaterThanOrEqual(1);
    expect(new Set(deletedByCanonicalPath).size).toBe(deletedByCanonicalPath.length);
    expect(deletedByCanonicalPath.sort()).toEqual([...plan2.demoCustomerIds].sort());
    const after = await classify(prisma, scope());
    expect(after.demoCustomerIds).toHaveLength(0);
    expect(after.demoPartnerIds).toEqual(before.demoPartnerIds); // reported, never deleted here
    expect(after.quarantinedIds).toEqual(before.quarantinedIds); // held, never deleted
    expect(after.adminIds).toEqual(before.adminIds);
    expect(after.unclassified).toBe(before.unclassified);
    expect((await auditEvents(plan2.digest)).pop()).toBe('COMPLETED');
  });

  it('production is denied by default; a valid, unexpired break-glass approval over the plan digest opens it; an expired one does not', async () => {
    await setIdentity('production');
    const demo = await mk({ phone: phone(), syntheticRunId: RUN });
    const plan = await buildPlan(prisma, URL_, undefined, scope());
    expect(plan.demoCustomerIds).toContain(demo.id);
    const base = async () => ({ secret: SECRET, approvals: twoApprovals(plan), backup: await goodBackup(plan), deleteUser });
    await expect(executePlan(prisma, URL_, plan, await base())).rejects.toMatchObject({ code: 'PRODUCTION_DENIED' });
    await expect(executePlan(prisma, URL_, plan, { ...(await base()), breakGlass: signBreakGlass(SECRET, plan.digest, new Date(Date.now() - 1000)) })).rejects.toMatchObject({ code: 'BREAK_GLASS_EXPIRED' });
    await expect(executePlan(prisma, URL_, plan, { ...(await base()), breakGlass: { ...signBreakGlass(SECRET, plan.digest, new Date(Date.now() + 600_000)), signature: 'b'.repeat(64) } })).rejects.toMatchObject({ code: 'BREAK_GLASS_INVALID' });
    const res = await executePlan(prisma, URL_, plan, { ...(await base()), breakGlass: signBreakGlass(SECRET, plan.digest, new Date(Date.now() + 600_000)) });
    expect(res.deleted).toContain(demo.id);
    await setIdentity('test');
  });
});
