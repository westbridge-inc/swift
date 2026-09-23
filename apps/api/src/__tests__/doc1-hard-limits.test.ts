/**
 * [DOC-1 §0.5] test_doc1_hard_limits — one test per hard limit, each red when
 * the limit is violated.
 *
 * One limit is violated today BY DECISION (CONFLICT-DOC-2, founder-inputs
 * FD-DOC-3/4): PERSONAL images persist until the retention clock. It is pinned
 * with `it.fails`: it passes while the violation stands and goes red the day
 * the code changes — at which point it flips to `it`. Nothing here is skipped,
 * and nothing here pretends.
 *
 * [NO-AI · owner rule 2026-09-07] The second decided violation — PERSONAL images
 * going to a third-party processor — no longer exists: the model-backed identity
 * adapters are deleted, no register entry receives a personal image or a
 * biometric, and the send gate refuses ANY external identity engine as
 * unregistered. Limits [2], [3] and [4] now grade that absence.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';
import { recordExternalProcessingDecision } from '../modules/verification/external-processing';
import { assertExternalProcessingPermitted, PROCESSOR_REGISTER } from '../modules/legal/processor-register';
import { degradedProvider } from '../modules/verification/degradation';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Writable } from 'node:stream';
import { prismaPlugin } from '../plugins/prisma';
import { socketPlugin } from '../plugins/socket';
import { redisPlugin } from '../plugins/redis';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import type { KycEngine, KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';
import { loggerRedactConfig } from '../utils/logger-config';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const API_SRC = join(__dirname, '..');
const REPO_APPS = join(__dirname, '..', '..', '..');
let app: FastifyInstance;
let userId = '';

/** A local engine that records which leg was called and answers with whatever it is told to. */
class SpyKyc implements KycProvider {
  calls: string[] = [];
  /** Extra fields for the answer. A verdict here is an adapter written against the OLD contract: cast past the types, it must change nothing. */
  extra: Record<string, unknown> = {};
  readonly engine: KycEngine = { name: 'spy', version: 'test', external: false };
  async verifyDocument(): Promise<KycVerificationResult> {
    this.calls.push('verifyDocument');
    return { referenceToken: `spy_${nanoid(6)}`, ...this.extra } as KycVerificationResult;
  }
}
const codeOf = (fn: () => void) => { try { fn(); return null; } catch (e) { return (e as { code?: string; statusCode?: number }); } };

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!['node_modules', '__tests__', 'dist'].includes(name)) walk(p, out); continue; }
    if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
};
const codeLines = (file: string) => readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59275${NUM}9`, firstName: 'Doc', lastName: 'Limits', activeRole: 'VENDOR_OWNER', countryCode: 'GY',
    avatar: `avatars/${RUN}/selfie.jpg`, selfieCapturedAt: new Date(),
  } }));
  userId = u.id;
  await signupSelfieFixture(app.prisma, userId);
});

afterAll(async () => {
  await runWithTenant('swift-default', async () => {
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId } });
    await app.prisma.user.deleteMany({ where: { id: userId } });
  });
  await app.close();
});

const service = (kyc: KycProvider) => new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), kyc);
const submitOwnerId = (kyc: KycProvider, tag: string) =>
  runWithTenant('swift-default', async () => service(kyc).submitDocument(userId, 'RESTAURANT', 'owner_national_id', await ownedVerificationFixture(app.prisma, userId, tag), 'v1'));
const cleanupDocs = () => runWithTenant('swift-default', async () => {
  const docs = await app.prisma.verificationDocument.findMany({ where: { userId }, select: { id: true } });
  await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
  await app.prisma.verificationDocument.deleteMany({ where: { userId } });
});
const latestDoc = () => runWithTenant('swift-default', () => app.prisma.verificationDocument.findFirstOrThrow({ where: { userId, docType: 'owner_national_id' }, orderBy: { createdAt: 'desc' } }));

describe('[DOC-1 §0.5] hard limits', () => {
  it.fails('[1] PERSONAL bytes are not persisted beyond the IDV-1 transient intake TTL — VIOLATED BY DECISION (CONFLICT-DOC-2): images persist to the retention clock', () => {
    const models = Prisma.dmmf.datamodel.models.filter((m) => ['VerificationDocument', 'EncryptedObject'].includes(m.name));
    const ttlFields = models.flatMap((m) => m.fields.filter((f) => /intake.*(ttl|expires)|transient/i.test(f.name)).map((f) => `${m.name}.${f.name}`));
    expect(ttlFields.length).toBeGreaterThan(0);
  });

  it('[2] PERSONAL images never reach an external processor: no register entry receives one, and the send gate refuses any external identity engine — forbidden by the type, or unregistered even when the type allows and a contract reference is set', () => {
    expect(existsSync(join(API_SRC, 'modules', 'legal', 'processor-register.ts'))).toBe(true);
    expect(PROCESSOR_REGISTER.filter((p) => p.payload.includes('PERSONAL_DOC_IMAGE') || p.payload.includes('BIOMETRIC'))).toEqual([]);
    const outside = { name: 'outside-identity', version: '1', external: true, processorRef: 'OUTSIDE_IDENTITY' };
    expect(codeOf(() => assertExternalProcessingPermitted({ code: 'owner_national_id', externalProcessingAllowed: false }, outside, { PROCESSOR_CONTRACT_OUTSIDE_IDENTITY: 'x' }))).toMatchObject({ statusCode: 503, code: 'PROCESSOR_NOT_PERMITTED' });
    expect(codeOf(() => assertExternalProcessingPermitted({ code: 'owner_national_id', externalProcessingAllowed: true }, outside, { PROCESSOR_CONTRACT_OUTSIDE_IDENTITY: 'DPA-ref' }))).toMatchObject({ statusCode: 503, code: 'PROCESSOR_UNREGISTERED' });
  });

  it('[2b] the gate is live in the submission path: an EXTERNAL identity engine is refused before it is called — by the type by default, and as unregistered once a decision is recorded — so the document never leaves', async () => {
    class ExternalSpyKyc extends SpyKyc { override readonly engine: KycEngine = { name: 'outside-identity', version: '1', external: true, processorRef: 'OUTSIDE_IDENTITY' }; }
    const row = { where: { countryCode_legacyCode: { countryCode: 'GY', legacyCode: 'owner_national_id' } } };
    try {
      // 1. registry forbids (default) → refused before the adapter is called
      const closed = new ExternalSpyKyc();
      await expect(submitOwnerId(closed, 'ext-closed')).rejects.toMatchObject({ statusCode: 503, code: 'PROCESSOR_NOT_PERMITTED' });
      expect(closed.calls).toEqual([]);
      // 2. a decision recorded for the type, and even a contract reference in env: there is no
      //    register entry for an identity processor to be ACTIVE under → still refused, never called
      await runWithoutTenant(() => recordExternalProcessingDecision(app.prisma, { code: 'GY.owner_national_id', allowed: true, decisionRef: 'FD-DOC-3b test', reason: 'test' }, async () => undefined), 'hard-limits-test');
      process.env['PROCESSOR_CONTRACT_OUTSIDE_IDENTITY'] = 'DPA-test';
      const decided = new ExternalSpyKyc();
      await expect(submitOwnerId(decided, 'ext-decided')).rejects.toMatchObject({ statusCode: 503, code: 'PROCESSOR_UNREGISTERED' });
      expect(decided.calls).toEqual([]);
      expect(await runWithTenant('swift-default', () => app.prisma.verificationDocument.count({ where: { userId } }))).toBe(0);
    } finally {
      delete process.env['PROCESSOR_CONTRACT_OUTSIDE_IDENTITY'];
      await runWithoutTenant(() => app.prisma.docType.update({ ...row, data: { externalProcessingAllowed: false, externalProcessingDecisionRef: null, externalProcessingDecidedAt: null } }), 'hard-limits-test');
      await cleanupDocs();
    }
  });

  it('[3] no biometric operation exists: there is no kill switch to flip, an identity document is handed over document-only with or without a signup selfie, and the shift selfie check is gone', async () => {
    expect(existsSync(join(API_SRC, 'lib', 'biometric-guard.ts'))).toBe(false);
    const withSelfie = new SpyKyc();
    await submitOwnerId(withSelfie, 'doc-only');
    expect(withSelfie.calls).toEqual(['verifyDocument']);
    await cleanupDocs();
    // Without a profile selfie the document is still accepted: there is nothing to compare it against, so nothing is missing.
    await runWithTenant('swift-default', () => app.prisma.user.update({ where: { id: userId }, data: { avatar: null, selfieCapturedAt: null } }));
    try {
      const withoutSelfie = new SpyKyc();
      const doc = await submitOwnerId(withoutSelfie, 'doc-only-no-selfie');
      expect(withoutSelfie.calls).toEqual(['verifyDocument']);
      expect(doc.status).toBe('PENDING');
    } finally {
      await signupSelfieFixture(app.prisma, userId);
      await cleanupDocs();
    }
    const liveness = readFileSync(join(API_SRC, 'modules', 'safety', 'liveness.service.ts'), 'utf8');
    expect(liveness).not.toMatch(/midshift|selfieUrl|KycProvider/);
  });

  it('[4] no automatic adverse (or favourable) decision: whatever an adapter answers — a stray verdict, a full read at full confidence, or an outage — the row is PENDING in a queue for a person', async () => {
    const answers: Array<[string, KycProvider]> = [
      ['stray-reject', Object.assign(new SpyKyc(), { extra: { status: 'rejected', reason: 'Document failed authenticity checks' } })],
      ['stray-approve', Object.assign(new SpyKyc(), { extra: { status: 'approved' } })],
      ['full-read', Object.assign(new SpyKyc(), { extra: { extracted: { documentNumber: `ID-${RUN}` }, confidence: 1 } })],
      ['outage', degradedProvider(new SpyKyc(), 'throw')],
    ];
    for (const [tag, kyc] of answers) {
      const submitted = await submitOwnerId(kyc, tag);
      const doc = await latestDoc();
      expect(doc.id, tag).toBe(submitted.id);
      expect({ status: doc.status, state: doc.state, reviewedBy: doc.reviewedBy, reviewedAt: doc.reviewedAt, expiresAt: doc.expiresAt }, tag)
        .toEqual({ status: 'PENDING', state: 'REVIEW_QUEUED', reviewedBy: null, reviewedAt: null, expiresAt: null });
      expect(await runWithTenant('swift-default', () => app.prisma.reviewCase.count({ where: { submissionId: doc.id, closedAt: null } })), tag).toBe(1);
      await cleanupDocs();
    }
  });

  it('[5] nothing is read automatically: the contract declares exactly documentNumber and no verdict, the service reads no field of it, and the ledger maps only the declared key', () => {
    const contract = readFileSync(join(API_SRC, 'providers', 'kyc', 'kyc-provider.ts'), 'utf8');
    expect(contract).toMatch(/extracted\?: \{ documentNumber\?: string \};/);
    expect(contract).not.toMatch(/\bstatus\??:/);
    const service = readFileSync(join(API_SRC, 'modules', 'verification', 'verification.service.ts'), 'utf8');
    const reads = [...service.matchAll(/extracted\??\.(\w+)/g)].map((m) => m[1]);
    expect(reads).toEqual([]);
    const ledger = readFileSync(join(API_SRC, 'modules', 'verification', 'extraction-ledger.ts'), 'utf8');
    expect(ledger).toMatch(/PROVIDER_KEY_TO_FIELD_CODE[^\n]*= \{ documentNumber: 'doc_number' \}/);
  });

  it('[6] raw extracted PII and the signed URLs of PERSONAL images never reach a log line', async () => {
    for (const k of ['documentNumber', 'extracted', 'dateOfBirth', 'dob', 'idDocumentUrl', 'selfieUrl', 'fileUrl']) {
      expect(loggerRedactConfig.paths).toContain(k);
      expect(loggerRedactConfig.paths).toContain(`*.${k}`);
    }
    let out = '';
    const sink = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
    const logger = Fastify({ logger: { level: 'info', redact: loggerRedactConfig, stream: sink } });
    logger.log.info({ extracted: { documentNumber: 'PP-SECRET-1' }, documentNumber: 'PP-SECRET-2', fileUrl: 'https://signed/SECRET-3', dob: '1990-01-01', result: { extracted: { documentNumber: 'PP-SECRET-4' } } }, 'submitted');
    await new Promise((r) => setTimeout(r, 20));
    await logger.close();
    expect(out).not.toMatch(/SECRET-1|SECRET-2|SECRET-3|SECRET-4|1990-01-01/);
    expect(out).toContain('submitted');
  });

  it('[7] one document system: the upload entry points are the registered ones (the shift selfie upload is gone), and VerificationDocument rows are written by the verification service alone', () => {
    const files = walk(API_SRC);
    const uploaders = files.filter((f) => /request\.file\(|req\.file\(|\.parts\(\)/.test(readFileSync(f, 'utf8'))).map((f) => relative(API_SRC, f)).sort();
    expect(uploaders).toEqual([
      'modules/ads/ads.routes.ts', 'modules/auth/auth.routes.ts', 'modules/chat/chat.routes.ts', 'modules/courier/courier.routes.ts',
      'modules/driver/driver.routes.ts', 'modules/rider/rider.routes.ts', 'modules/vendor/vendor.routes.ts',
      'modules/verification/verification.routes.ts',
    ]);
    const writers = files.filter((f) => /verificationDocument\.create(Many)?\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(API_SRC, f)).sort();
    expect(writers).toEqual(['modules/verification/verification.service.ts']);
  });

  it('[8] Swift never tells a user it is "compliant" with a statute — no user-facing string says so', () => {
    const roots = [API_SRC, join(REPO_APPS, 'mobile', 'src'), join(REPO_APPS, 'web', 'src')].filter((d) => existsSync(d));
    const hits: string[] = [];
    for (const root of roots) {
      for (const f of walk(root)) {
        codeLines(f).forEach((l, i) => {
          if (/\bcompliant\b/i.test(l) && !/STILL_NON_COMPLIANT/.test(l)) hits.push(`${relative(REPO_APPS, f)}:${i + 1}: ${l.trim().slice(0, 100)}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
