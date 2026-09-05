/**
 * [DOC-1 §20.1 · P20-1] test_audit_chain_is_append_only · test_chain_verifier_detects_tampering — DOC-INV-35.
 *
 * Every audit-bearing write (an admin audit row, a review decision, a
 * deletion receipt) is chained by the database into one append-only
 * sequence: a digest of the event, never the body, and
 * entry_hash = sha256(prev_hash || seq || occurred_at || payload_digest).
 * UPDATE, DELETE and TRUNCATE are refused. The verifier recomputes every
 * link and alarms on a break; the anchor writes the head to its own
 * append-only table and tells the admins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { installDdl } from './helpers/install-ddl';
import { auditChainDdl, entryHashOf, verifyAuditChain, verifyAuditChainAndAlarm, anchorAuditChain, AUDIT_CHAIN_GENESIS } from '../lib/audit-chain';
import { NotificationService } from '../modules/notification/notification.service';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
let app: FastifyInstance;
let adminId = '';
let subjectId = '';
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-audit-chain-test');
const entries = (where: Record<string, unknown>) => system(() => app.prisma.auditChainEntry.findMany({ where, orderBy: { seq: 'asc' } }));
const tail = (n: number) => system(() => app.prisma.auditChainEntry.findMany({ orderBy: { seq: 'desc' }, take: n })).then((r) => r.reverse());

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin);
  await app.ready();
  // The DDL under test is the TS source of truth (the migration mirrors it): install it so a mutation here is what these tests grade.
  await installDdl(app.prisma, auditChainDdl());
  const admin = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59276${NUM}1`, firstName: 'Chain', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true } }));
  const subject = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59276${NUM}2`, firstName: 'Chain', lastName: `Subject${RUN}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true } }));
  adminId = admin.id; subjectId = subject.id;
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.notification.deleteMany({ where: { userId: adminId } });
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: subjectId }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: subjectId } });
    await app.prisma.user.deleteMany({ where: { id: { in: [adminId, subjectId] } } });
  });
  await app.close();
});

describe('[DOC-1 P20-1] the tamper-evident audit chain', () => {
  it('an admin audit row is chained by the database: digest only, prev links to the previous head, entry_hash recomputes from the stored fields', async () => {
    const before = await tail(1);
    const marker = `SECRET-PII-${RUN}`;
    const row = await system(() => app.prisma.auditLog.create({ data: { userId: adminId, action: `CHAIN_PROBE_${RUN}`, entity: 'VerificationDocument', entityId: `doc-${RUN}`, changes: { note: marker } } }));
    const [e] = await entries({ eventType: `CHAIN_PROBE_${RUN}` });
    expect(e).toBeDefined();
    expect([e!.actorId, e!.actorRole, e!.subjectRef, e!.submissionRef]).toEqual([adminId, 'ADMIN', row.entityId, row.entityId]);
    expect(Buffer.from(e!.payloadDigest)).toHaveLength(32);
    expect(Buffer.from(e!.prevHash).equals(before[0] ? Buffer.from(before[0].entryHash) : AUDIT_CHAIN_GENESIS)).toBe(true);
    expect(entryHashOf(e!.prevHash, e!.seq, e!.occurredAt, e!.payloadDigest).equals(Buffer.from(e!.entryHash))).toBe(true);
    // never the body: no chain column carries the marker
    const leaked = await system(() => app.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM audit_chain WHERE row_to_json(audit_chain)::text LIKE ${'%' + marker + '%'}`);
    expect(Number(leaked[0]!.n)).toBe(0);
  });

  it('a review decision and a deletion receipt are chained too, with the submission they concern', async () => {
    const doc = await runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: { userId: subjectId, role: 'VENDOR_OWNER', docType: 'business_registration', fileUrl: '', status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1' } }));
    const kase = await runWithTenant('swift-default', () => app.prisma.reviewCase.create({ data: { submissionId: doc.id, slaDueAt: new Date(Date.now() + 86_400_000) } }));
    await runWithTenant('swift-default', () => app.prisma.reviewDecision.create({ data: { caseId: kase.id, reviewerId: adminId, outcome: 'APPROVE', reasonCode: 'APPROVED', actorFacingCategory: 'APPROVED' } }));
    await runWithTenant('swift-default', () => app.prisma.deletionReceipt.create({ data: { submissionId: doc.id, subjectId, docTypeCode: 'business_registration', bytesDeleted: 0n, deletedBy: 'reaper', storeLocations: [], verificationProbeResult: 'CONFIRMED_ABSENT' } }));
    const chained = await entries({ submissionRef: doc.id });
    expect(chained.map((e) => [e.eventType, e.actorRole, e.actorId])).toEqual([['REVIEW_DECISION_APPROVE', 'REVIEWER', adminId], ['DELETION_RECEIPT', 'REAPER', 'reaper']]);
  });

  it('test_audit_chain_is_append_only: UPDATE, DELETE and TRUNCATE are refused; the anchor table too', async () => {
    const [e] = await tail(1);
    await expect(system(() => app.prisma.$executeRaw`UPDATE audit_chain SET "actorRole" = 'X' WHERE seq = ${e!.seq}`)).rejects.toThrow(/append-only/);
    await expect(system(() => app.prisma.$executeRaw`DELETE FROM audit_chain WHERE seq = ${e!.seq}`)).rejects.toThrow(/append-only/);
    await expect(system(() => app.prisma.$executeRawUnsafe(`TRUNCATE audit_chain`))).rejects.toThrow(/append-only/);
    const anchor = await system(() => app.prisma.auditChainAnchor.create({ data: { headSeq: e!.seq, headHash: e!.entryHash, verified: true } }));
    await expect(system(() => app.prisma.$executeRaw`DELETE FROM audit_chain_anchor WHERE id = ${anchor.id}`)).rejects.toThrow(/append-only/);
  });

  it('the verifier walks the whole chain green, and the anchor writes the head and tells the admins', async () => {
    const verdict = await verifyAuditChain(app.prisma);
    expect(verdict.ok).toBe(true);
    expect(verdict.entries).toBeGreaterThanOrEqual(3);
    const [head] = await tail(1);
    expect(verdict.headSeq).toBe(head!.seq);
    expect(verdict.headHash!.equals(Buffer.from(head!.entryHash))).toBe(true);
    const anchor = await anchorAuditChain(app.prisma, new NotificationService(app.prisma, app.io));
    expect(anchor).toMatchObject({ headSeq: head!.seq, verified: true });
    const notes = await system(() => app.prisma.notification.findMany({ where: { userId: adminId } }));
    expect(notes.some((n) => (n.data as { kind?: string } | null)?.kind === 'audit_chain_anchor')).toBe(true);
  });

  it('test_chain_verifier_detects_tampering: an altered digest (behind a disabled guard) breaks verification at that entry, and the alarm fires', async () => {
    const [target] = await tail(1);
    await system(() => app.prisma.$executeRawUnsafe(`ALTER TABLE audit_chain DISABLE TRIGGER audit_chain_no_mutation`));
    try {
      await system(() => app.prisma.$executeRaw`UPDATE audit_chain SET "payloadDigest" = sha256('tampered'::bytea) WHERE seq = ${target!.seq}`);
      const verdict = await verifyAuditChainAndAlarm(app.prisma, new NotificationService(app.prisma, app.io));
      expect(verdict.ok).toBe(false);
      expect(verdict.breakAt).toBe(target!.seq);
      expect(verdict.reason).toBe('HASH');
      const notes = await system(() => app.prisma.notification.findMany({ where: { userId: adminId } }));
      expect(notes.some((n) => (n.data as { kind?: string } | null)?.kind === 'audit_chain_broken')).toBe(true);
    } finally {
      // Restore the truth (the original digest) and the guard, so the chain is whole again for everyone after us.
      await system(() => app.prisma.$executeRaw`UPDATE audit_chain SET "payloadDigest" = ${target!.payloadDigest} WHERE seq = ${target!.seq}`);
      await system(() => app.prisma.$executeRawUnsafe(`ALTER TABLE audit_chain ENABLE TRIGGER audit_chain_no_mutation`));
    }
    expect((await verifyAuditChain(app.prisma)).ok).toBe(true);
  });

  it('a removed entry (behind a disabled guard) is a LINK break at the next entry', async () => {
    const before = await tail(2);
    await system(() => app.prisma.$executeRawUnsafe(`ALTER TABLE audit_chain DISABLE TRIGGER audit_chain_no_mutation`));
    try {
      await system(() => app.prisma.$executeRaw`DELETE FROM audit_chain WHERE seq = ${before[0]!.seq}`);
      const verdict = await verifyAuditChain(app.prisma);
      expect(verdict.ok).toBe(false);
      expect(verdict.breakAt).toBe(before[1]!.seq);
      expect(verdict.reason).toBe('LINK');
    } finally {
      const r = before[0]!;
      await system(() => app.prisma.$executeRaw`INSERT INTO audit_chain (seq, "occurredAt", "actorId", "actorRole", "eventType", "subjectRef", "submissionRef", "payloadDigest", "prevHash", "entryHash")
        VALUES (${r.seq}, ${r.occurredAt}, ${r.actorId}, ${r.actorRole}, ${r.eventType}, ${r.subjectRef}, ${r.submissionRef}, ${r.payloadDigest}, ${r.prevHash}, ${r.entryHash})`);
      await system(() => app.prisma.$executeRawUnsafe(`ALTER TABLE audit_chain ENABLE TRIGGER audit_chain_no_mutation`));
    }
    expect((await verifyAuditChain(app.prisma)).ok).toBe(true);
  });
});
