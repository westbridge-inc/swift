/**
 * [DGP-1 · CONFLICT-DOC-2] A PERSONAL document type may be processed externally only under a
 * RECORDED decision. The database CHECK, the recording service and the runtime gate read the
 * same row, so the residency rule cannot be flipped by a stray update or a hopeful client.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { runWithoutTenant } from '../plugins/tenant-context';
import { seedDocRegistry } from '../modules/verification/doc-registry';
import { recordExternalProcessingDecision, DECISION_REF_REQUIRED } from '../modules/verification/external-processing';
import { assertExternalProcessingPermitted } from '../modules/legal/processor-register';

const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'external-processing-decision-test');
const DIDIT = { name: 'didit', version: 'v3', external: true, processorRef: 'DIDIT' };
const CONTRACTED = { PROCESSOR_CONTRACT_DIDIT: 'DPA-2026-001' };
let app: FastifyInstance;
const audits: Array<Record<string, unknown>> = [];
const audit = async (_tx: unknown, facts: Record<string, unknown>) => { audits.push(facts); };
let PERSONAL = '';
let nonPersonal = '';

beforeAll(async () => {
  app = Fastify({ logger: false }); await app.register(prismaPlugin); await app.ready();
  await system(() => seedDocRegistry(app.prisma));
  const row = await system(() => app.prisma.docType.findFirst({ where: { bucket: { not: 'PERSONAL' } }, select: { code: true, bucket: true } }));
  nonPersonal = row!.code;
  const personal = await system(() => app.prisma.docType.findFirst({ where: { bucket: 'PERSONAL' }, orderBy: { code: 'asc' }, select: { code: true } }));
  PERSONAL = personal!.code;
  expect(PERSONAL).toBeTruthy();
});
afterAll(async () => {
  await system(() => app.prisma.docType.updateMany({ where: { code: { in: [PERSONAL, nonPersonal] } }, data: { externalProcessingAllowed: false, externalProcessingDecisionRef: null, externalProcessingDecidedAt: null } }));
  await app.close();
});

describe('[CONFLICT-DOC-2] the residency rule opens only under a recorded decision', () => {
  it('test_personal_type_needs_decision_ref: the database refuses allowed=true on a PERSONAL type with no reference, and so does the service', async () => {
    await expect(system(() => app.prisma.docType.update({ where: { code: PERSONAL }, data: { externalProcessingAllowed: true } }))).rejects.toThrow(/personal_external_needs_decision/);
    await expect(recordExternalProcessingDecision(app.prisma, { code: PERSONAL, allowed: true, reason: 'launch KYC via Didit' }, audit)).rejects.toMatchObject({ code: DECISION_REF_REQUIRED });
    await expect(recordExternalProcessingDecision(app.prisma, { code: PERSONAL, allowed: true, decisionRef: '   ', reason: 'launch KYC via Didit' }, audit)).rejects.toMatchObject({ code: DECISION_REF_REQUIRED });
    const row = await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code: PERSONAL }, select: { externalProcessingAllowed: true } }));
    expect(row.externalProcessingAllowed).toBe(false);
    expect(audits).toEqual([]);
  });

  it('test_recorded_decision_opens_the_gate: with the reference the row flips, the audit line carries the facts, and the send gate passes for a contracted processor', async () => {
    const r = await system(() => recordExternalProcessingDecision(app.prisma, { code: PERSONAL, allowed: true, decisionRef: 'FD-DOC-3b 2026-09-07', reason: 'Founder: identity documents may go to Didit under its DPA' }, audit));
    expect(r.before.externalProcessingAllowed).toBe(false);
    expect(r.after).toMatchObject({ externalProcessingAllowed: true, externalProcessingDecisionRef: 'FD-DOC-3b 2026-09-07' });
    expect(r.after.externalProcessingDecidedAt).toBeInstanceOf(Date);
    expect(audits.at(-1)).toMatchObject({ docType: PERSONAL, bucket: 'PERSONAL', allowedBefore: false, allowedAfter: true, decisionRef: 'FD-DOC-3b 2026-09-07' });
    const row = await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code: PERSONAL }, select: { code: true, externalProcessingAllowed: true } }));
    expect(() => assertExternalProcessingPermitted(row, DIDIT, CONTRACTED)).not.toThrow();
    // the decision opens the TYPE; the processor still needs its contract
    expect(() => assertExternalProcessingPermitted(row, DIDIT, {})).toThrow(/externally/);
  });

  it('test_revoke_closes_the_gate: allowed=false clears the reference and the send gate refuses again', async () => {
    const r = await system(() => recordExternalProcessingDecision(app.prisma, { code: PERSONAL, allowed: false, reason: 'Founder: back on shore' }, audit));
    expect(r.after).toMatchObject({ externalProcessingAllowed: false, externalProcessingDecisionRef: null });
    const row = await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code: PERSONAL }, select: { code: true, externalProcessingAllowed: true } }));
    expect(() => assertExternalProcessingPermitted(row, DIDIT, CONTRACTED)).toThrow(/externally/);
  });

  it('a non-PERSONAL type may be allowed without a reference (the residency rule is about PERSONAL images)', async () => {
    const r = await system(() => recordExternalProcessingDecision(app.prisma, { code: nonPersonal, allowed: true, reason: 'vehicle papers via OCR' }, audit));
    expect(r.after.externalProcessingAllowed).toBe(true);
    expect(r.after.externalProcessingDecisionRef).toBeNull();
  });

  it('the audit and the row commit together: an audit failure leaves the row unchanged', async () => {
    const failing = async () => { throw new Error('audit sink down'); };
    await expect(system(() => recordExternalProcessingDecision(app.prisma, { code: PERSONAL, allowed: true, decisionRef: 'FD-DOC-3b 2026-09-07', reason: 'x' }, failing))).rejects.toThrow(/audit sink down/);
    const row = await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code: PERSONAL }, select: { externalProcessingAllowed: true, externalProcessingDecisionRef: true } }));
    expect(row).toEqual({ externalProcessingAllowed: false, externalProcessingDecisionRef: null });
  });
});
