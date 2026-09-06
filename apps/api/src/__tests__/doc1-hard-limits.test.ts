/**
 * [DOC-1 §0.5] test_doc1_hard_limits — one test per hard limit, each red when
 * the limit is violated.
 *
 * Two limits are violated today BY DECISION (CONFLICT-DOC-2, founder-inputs
 * FD-DOC-3/4): PERSONAL images persist until the retention clock, and they go
 * to a third-party KYC processor without a code-level processor register.
 * Those two are pinned with `it.fails`: they pass while the violation stands
 * and go red the day the code changes — at which point they flip to `it`.
 * Nothing here is skipped, and nothing here pretends.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { recordExternalProcessingDecision } from '../modules/verification/external-processing';
import { assertExternalProcessingPermitted } from '../modules/legal/processor-register';
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
import type { KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';
import { biometricFaceMatchEnabled } from '../lib/biometric-guard';
import { loggerRedactConfig } from '../utils/logger-config';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const API_SRC = join(__dirname, '..');
const REPO_APPS = join(__dirname, '..', '..', '..');
let app: FastifyInstance;
let userId = '';

/** A provider that records which leg was called and answers as told. */
class SpyKyc implements KycProvider {
  calls: string[] = [];
  verdict: KycVerificationResult['status'] = 'pending_manual';
  async verifyIdentity(): Promise<KycVerificationResult> { this.calls.push('verifyIdentity'); return { status: this.verdict, referenceToken: `spy_${nanoid(6)}` }; }
  async verifyDocument(): Promise<KycVerificationResult> { this.calls.push('verifyDocument'); return { status: this.verdict, referenceToken: `spy_${nanoid(6)}` }; }
  async getStatus(): Promise<'pending_manual'> { return 'pending_manual'; }
}

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
});

afterAll(async () => {
  await runWithTenant('swift-default', async () => {
    await app.prisma.verificationDocument.deleteMany({ where: { userId } });
    await app.prisma.user.deleteMany({ where: { id: userId } });
  });
  delete process.env['FEATURE_BIOMETRIC_FACE_MATCH'];
  await app.close();
});

const service = (kyc: KycProvider) => new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), kyc);
const submitOwnerId = (kyc: KycProvider, tag: string) =>
  runWithTenant('swift-default', () => service(kyc).submitDocument(userId, 'RESTAURANT', 'owner_national_id', `documents/${RUN}/${tag}.jpg`, 'v1'));

describe('[DOC-1 §0.5] hard limits', () => {
  it.fails('[1] PERSONAL bytes are not persisted beyond the IDV-1 transient intake TTL — VIOLATED BY DECISION (CONFLICT-DOC-2): images persist to the retention clock', () => {
    const models = Prisma.dmmf.datamodel.models.filter((m) => ['VerificationDocument', 'EncryptedObject'].includes(m.name));
    const ttlFields = models.flatMap((m) => m.fields.filter((f) => /intake.*(ttl|expires)|transient/i.test(f.name)).map((f) => `${m.name}.${f.name}`));
    expect(ttlFields.length).toBeGreaterThan(0);
  });

  it('[2] PERSONAL images reach an external processor only if allowed, registered and covered by a transfer basis — the DGP-1 register exists and the gate is fail-closed (CONFLICT-DOC-2 is now a recorded decision, not a leak)', () => {
    expect(existsSync(join(API_SRC, 'modules', 'legal', 'processor-register.ts'))).toBe(true);
    const external = { name: 'didit', version: 'v3', external: true, processorRef: 'DIDIT' };
    expect(() => assertExternalProcessingPermitted({ code: 'owner_national_id', externalProcessingAllowed: false }, external, { PROCESSOR_CONTRACT_DIDIT: 'x' })).toThrow(/PROCESSOR_NOT_PERMITTED|externally/);
    expect(() => assertExternalProcessingPermitted({ code: 'owner_national_id', externalProcessingAllowed: true }, external, {})).toThrow(/PROCESSOR_NO_TRANSFER_BASIS|externally/);
    expect(() => assertExternalProcessingPermitted({ code: 'owner_national_id', externalProcessingAllowed: true }, external, { PROCESSOR_CONTRACT_DIDIT: 'DPA-ref' })).not.toThrow();
  });

  it('[2b] the gate is live in the submission path: an EXTERNAL engine is refused for a PERSONAL type until the decision is recorded and the processor is contracted — then the document goes, document-only', async () => {
    class ExternalSpyKyc extends SpyKyc { readonly engine = { name: 'didit', version: 'v3', external: true, processorRef: 'DIDIT' }; }
    const cleanup = () => runWithTenant('swift-default', () => app.prisma.verificationDocument.deleteMany({ where: { userId } }));
    const row = { where: { countryCode_legacyCode: { countryCode: 'GY', legacyCode: 'owner_national_id' } } };
    process.env['FEATURE_BIOMETRIC_FACE_MATCH'] = '0';
    try {
      // 1. registry forbids (default) → refused before the adapter is called
      const closed = new ExternalSpyKyc();
      await expect(submitOwnerId(closed, 'ext-closed')).rejects.toMatchObject({ statusCode: 503, code: 'PROCESSOR_NOT_PERMITTED' });
      expect(closed.calls).toEqual([]);
      // 2. decision recorded, but no contract reference for the processor → still refused
      await runWithoutTenant(() => recordExternalProcessingDecision(app.prisma, { code: 'GY.owner_national_id', allowed: true, decisionRef: 'FD-DOC-3b test', reason: 'test' }, async () => undefined), 'hard-limits-test');
      delete process.env['PROCESSOR_CONTRACT_DIDIT'];
      const uncontracted = new ExternalSpyKyc();
      await expect(submitOwnerId(uncontracted, 'ext-nocontract')).rejects.toMatchObject({ statusCode: 503, code: 'PROCESSOR_NO_TRANSFER_BASIS' });
      expect(uncontracted.calls).toEqual([]);
      // 3. decision + contract → the document goes to the external engine, document-only (biometrics off)
      process.env['PROCESSOR_CONTRACT_DIDIT'] = 'DPA-test';
      const open = new ExternalSpyKyc();
      await submitOwnerId(open, 'ext-open');
      expect(open.calls).toEqual(['verifyDocument']);
    } finally {
      delete process.env['FEATURE_BIOMETRIC_FACE_MATCH']; delete process.env['PROCESSOR_CONTRACT_DIDIT'];
      await runWithoutTenant(() => app.prisma.docType.update({ ...row, data: { externalProcessingAllowed: false, externalProcessingDecisionRef: null, externalProcessingDecidedAt: null } }), 'hard-limits-test');
      await cleanup();
    }
  });

  it('[3] no biometric operation without the recorded decision: the kill switch exists, defaults OFF (FD-D5 not approved), and only an explicit 1 sends the selfie', async () => {
    expect(biometricFaceMatchEnabled({})).toBe(false);
    expect(biometricFaceMatchEnabled({ FEATURE_BIOMETRIC_FACE_MATCH: '1' })).toBe(true);
    expect(biometricFaceMatchEnabled({ FEATURE_BIOMETRIC_FACE_MATCH: '0' })).toBe(false);
    const on = new SpyKyc();
    process.env['FEATURE_BIOMETRIC_FACE_MATCH'] = '1';
    await submitOwnerId(on, 'on');
    expect(on.calls).toEqual(['verifyIdentity']);
    await runWithTenant('swift-default', () => app.prisma.verificationDocument.deleteMany({ where: { userId } }));
    const off = new SpyKyc();
    delete process.env['FEATURE_BIOMETRIC_FACE_MATCH'];
    try {
      await submitOwnerId(off, 'off');
      expect(off.calls).toEqual(['verifyDocument']);
    } finally {
      delete process.env['FEATURE_BIOMETRIC_FACE_MATCH'];
      await runWithTenant('swift-default', () => app.prisma.verificationDocument.deleteMany({ where: { userId } }));
    }
    // The shift-selfie liveness check is a face-match too: it must consult the same switch.
    expect(readFileSync(join(API_SRC, 'modules', 'safety', 'liveness.service.ts'), 'utf8')).toMatch(/biometricFaceMatchEnabled\(\)/);
  });

  it('[4] a document that failed the processor is never auto-approved, whatever the confidence', async () => {
    const kyc = new SpyKyc();
    kyc.verdict = 'rejected';
    await submitOwnerId(kyc, 'rejected');
    const doc = await runWithTenant('swift-default', () => app.prisma.verificationDocument.findFirst({ where: { userId, docType: 'owner_national_id' }, orderBy: { createdAt: 'desc' } }));
    expect(doc?.status).toBe('REJECTED');
    await runWithTenant('swift-default', () => app.prisma.verificationDocument.deleteMany({ where: { userId } }));
  });

  it('[5] no extracted field is written that the contract does not declare — the contract declares exactly documentNumber, and the service reads nothing else', () => {
    const contract = readFileSync(join(API_SRC, 'providers', 'kyc', 'kyc-provider.ts'), 'utf8');
    expect(contract).toMatch(/extracted\?: \{ documentNumber\?: string \};/);
    const service = readFileSync(join(API_SRC, 'modules', 'verification', 'verification.service.ts'), 'utf8');
    const reads = [...service.matchAll(/extracted\??\.(\w+)/g)].map((m) => m[1]);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set(['documentNumber']));
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

  it('[7] one document system: the upload entry points are the registered ones, and VerificationDocument rows are written by the verification service alone', () => {
    const files = walk(API_SRC);
    const uploaders = files.filter((f) => /request\.file\(|req\.file\(|\.parts\(\)/.test(readFileSync(f, 'utf8'))).map((f) => relative(API_SRC, f)).sort();
    expect(uploaders).toEqual([
      'modules/ads/ads.routes.ts', 'modules/auth/auth.routes.ts', 'modules/chat/chat.routes.ts', 'modules/courier/courier.routes.ts',
      'modules/driver/driver.routes.ts', 'modules/rider/rider.routes.ts', 'modules/safety/safety.routes.ts', 'modules/vendor/vendor.routes.ts',
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
