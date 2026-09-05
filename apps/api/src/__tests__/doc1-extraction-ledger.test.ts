/**
 * [DOC-1 §4.4 · P4-4] test_unknown_fields_dropped — the extraction ledger.
 *
 * A processor result lands as ROWS, never in a log line: one extraction_run per
 * call, one extracted_field per DECLARED field of the document type (value
 * envelope-encrypted under a per-run DEK wrapped by the master KEK, blind index
 * when declared, ABSENT when not returned), one validation_result per verdict.
 * A key the registry does not declare is dropped and counted — never a row, never
 * a log line (DOC-INV-6). A blocking validator FAIL forbids auto-approval (§0.5).
 * Without a KEK no value is stored at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { loggerRedactConfig } from '../utils/logger-config';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { seedDocRegistry, registryCode } from '../modules/verification/doc-registry';
import { unpackAndDecrypt, V_ALL_REQUIRED_PRESENT, V_SHA_COLLISION } from '../modules/verification/extraction-ledger';
import { getKeyProvider, resetKeyProviderForTests } from '../providers/storage/envelope';
import { hashSignal, normalizeDocNumber } from '../modules/integrity/normalize';
import type { KycEngine, KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
/** A PERSONAL type on the RESTAURANT checklist; this suite declares its fields for the run and removes them after. */
const DECLARED_TYPE = 'food_handler_cert';
const DECLARED_CODE = registryCode('GY', DECLARED_TYPE);
const KEK = crypto.randomBytes(32).toString('base64');
const prevKek = process.env['MASTER_KEK'];

let app: FastifyInstance;
let service: VerificationService;
let logOut = '';
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-extraction-ledger-test');

class SpyKyc implements KycProvider {
  readonly engine: KycEngine = { name: 'spy', version: 'test', external: false };
  verdict: KycVerificationResult['status'] = 'pending_manual';
  extracted: Record<string, unknown> | undefined;
  private result(): KycVerificationResult {
    return { status: this.verdict, referenceToken: `spy_${nanoid(6)}`, extracted: this.extracted as KycVerificationResult['extracted'] };
  }
  async verifyIdentity(): Promise<KycVerificationResult> { return this.result(); }
  async verifyDocument(): Promise<KycVerificationResult> { return this.result(); }
  async getStatus(): Promise<'pending_manual'> { return 'pending_manual'; }
}
const kyc = new SpyKyc();

async function owner(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59271${NUM}${n}`, firstName: 'Led', lastName: `Ger${n}`, activeRole: 'VENDOR_OWNER', countryCode: 'GY',
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  return u.id;
}
const submit = (userId: string, docType: string) =>
  runWithTenant('swift-default', () => service.submitDocument(userId, 'RESTAURANT', docType, `/uploads/verification/${RUN}/${nanoid(5)}.enc`, 'v1'));
const ledger = (docId: string) => system(async () => ({
  run: await app.prisma.extractionRun.findFirst({ where: { submissionId: docId }, include: { fields: { orderBy: { fieldCode: 'asc' } } } }),
  validations: await app.prisma.validationResult.findMany({ where: { submissionId: docId }, orderBy: { validatorCode: 'asc' } }),
}));
/** Plaintext anywhere in the ledger's ciphertext column — the raw-bytes question, asked of the database. */
const plaintextRows = (needle: string) => system(() => app.prisma.$queryRaw<{ n: bigint }[]>`
  SELECT count(*)::bigint AS n FROM extracted_field WHERE "valueCt" IS NOT NULL AND position(convert_to(${needle}, 'UTF8') in "valueCt") > 0`)
  .then((r) => Number(r[0]!.n));
const declareFields = () => system(async () => {
  await app.prisma.docField.deleteMany({ where: { docTypeCode: DECLARED_CODE, fieldCode: { in: ['doc_number', 'expiry_date'] } } });
  await app.prisma.docField.createMany({ data: [
    { docTypeCode: DECLARED_CODE, fieldCode: 'doc_number', dataType: 'text', isRequired: true, isPii: true, isBlindIndexed: true, displayOrder: 1 },
    { docTypeCode: DECLARED_CODE, fieldCode: 'expiry_date', dataType: 'date', isRequired: false, isPii: false, isBlindIndexed: false, displayOrder: 2 },
  ] });
});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['MASTER_KEK'] = KEK;
  resetKeyProviderForTests();
  const sink = new Writable({ write(chunk, _enc, cb) { logOut += chunk.toString(); cb(); } });
  app = Fastify({ logger: { level: 'trace', redact: loggerRedactConfig, stream: sink } });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), kyc);
  await system(() => seedDocRegistry(app.prisma));
  await declareFields();
});

afterAll(async () => {
  await system(async () => {
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } }); // runs, fields, verdicts cascade
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.prisma.docField.deleteMany({ where: { docTypeCode: DECLARED_CODE, fieldCode: { in: ['doc_number', 'expiry_date'] } } });
  });
  if (prevKek === undefined) delete process.env['MASTER_KEK']; else process.env['MASTER_KEK'] = prevKek;
  resetKeyProviderForTests();
  await app.close();
});

describe('[DOC-1 P4-4] the extraction ledger', () => {
  it('test_unknown_fields_dropped: a key the registry does not declare is counted and dropped — never a row, never a log line; the run and the verdicts are recorded', async () => {
    const u = await owner(1);
    kyc.verdict = 'pending_manual';
    kyc.extracted = { documentNumber: `BR-${RUN}-SECRET1`, fooBar: `SECRET2-${RUN}` };
    const doc = await submit(u, 'business_registration'); // the registry declares no fields for this type
    const { run, validations } = await ledger(doc.id);
    expect(run).not.toBeNull();
    expect(run).toMatchObject({ engineName: 'spy', engineVersion: 'test', ranExternally: false, processorRef: null, profileCode: 'UNPROFILED', outcome: 'OK', schemaViolations: 2, wrappedDek: null, tenantId: 'swift-default' });
    expect(run!.fields).toHaveLength(0);
    expect(run!.durationMs).toBeGreaterThanOrEqual(0);
    expect(validations.map((v) => [v.validatorCode, v.status, v.detailCode, v.isBlocking])).toEqual([
      [V_ALL_REQUIRED_PRESENT, 'SKIP', 'NO_DECLARED_FIELDS', true],
      [V_SHA_COLLISION, 'PASS', null, false],
    ]);
    // DB-wide: neither value exists in any ciphertext column, and no row names the unknown key.
    expect(await plaintextRows('SECRET1')).toBe(0);
    expect(await plaintextRows(`SECRET2-${RUN}`)).toBe(0);
    expect(await system(() => app.prisma.extractedField.count({ where: { fieldCode: { in: ['fooBar', 'foo_bar', 'documentNumber'] } } }))).toBe(0);
    expect(logOut).not.toMatch(/SECRET1|SECRET2|fooBar/);
  });

  it('a declared required field the processor did not return: ABSENT row, V_ALL_REQUIRED_PRESENT FAILs, and the auto-approval is refused (§0.5) — the human gets the case', async () => {
    const u = await owner(2);
    kyc.verdict = 'approved';
    kyc.extracted = undefined;
    const doc = await submit(u, DECLARED_TYPE);
    expect(doc.status).toBe('PENDING');
    const { run, validations } = await ledger(doc.id);
    expect(run).toMatchObject({ outcome: 'FAILED', errorClass: 'NO_REQUIRED_FIELDS', wrappedDek: null });
    expect(run!.fields.map((f) => [f.fieldCode, f.valueCt, f.valueBlind, f.isIllegible])).toEqual([
      ['doc_number', null, null, false], ['expiry_date', null, null, false],
    ]);
    expect(validations.find((v) => v.validatorCode === V_ALL_REQUIRED_PRESENT)).toMatchObject({ status: 'FAIL', detailCode: 'UNREADABLE_CAPTURE', isBlocking: true }); // the registry's §8.5 code for a field that could not be read
    expect(await system(() => app.prisma.reviewCase.count({ where: { submissionId: doc.id, closedAt: null, queue: 'STANDARD' } }))).toBe(1);
  });

  it('a declared field lands encrypted under the run DEK with its blind index; the optional field is ABSENT; every required field present → PASS and the approval stands', async () => {
    const u = await owner(3);
    const plain = `FH ${RUN}-77`;
    kyc.verdict = 'approved';
    kyc.extracted = { documentNumber: plain };
    const doc = await submit(u, DECLARED_TYPE);
    expect(doc.status).toBe('APPROVED');
    const { run, validations } = await ledger(doc.id);
    expect(run).toMatchObject({ outcome: 'OK', errorClass: null, schemaViolations: 0 });
    expect(run!.wrappedDek).not.toBeNull();
    const [num, exp] = run!.fields;
    expect([num!.fieldCode, num!.source, num!.isIllegible, num!.tenantId]).toEqual(['doc_number', 'PROVIDER', false, 'swift-default']);
    expect(num!.valueCt).not.toBeNull();
    expect(Buffer.from(num!.valueCt!).includes(Buffer.from(plain, 'utf8'))).toBe(false);
    const dek = await getKeyProvider()!.unwrapDek(Buffer.from(run!.wrappedDek!));
    expect(unpackAndDecrypt(Buffer.from(num!.valueCt!), dek).toString('utf8')).toBe(plain);
    expect(num!.valueBlind).toBe(hashSignal(normalizeDocNumber(plain)));
    expect([exp!.fieldCode, exp!.valueCt, exp!.valueBlind]).toEqual(['expiry_date', null, null]);
    expect(validations.find((v) => v.validatorCode === V_ALL_REQUIRED_PRESENT)).toMatchObject({ status: 'PASS', detailCode: null, isBlocking: true });
    expect(await plaintextRows(plain)).toBe(0);
  });

  it('without a KEK no value is stored at all: ABSENT row, blind index kept, run PARTIAL with NO_KEK — and nothing in the clear anywhere', async () => {
    const u = await owner(4);
    const plain = `FH-${RUN}-NOKEK-SECRET3`;
    delete process.env['MASTER_KEK'];
    resetKeyProviderForTests();
    try {
      kyc.verdict = 'approved';
      kyc.extracted = { documentNumber: plain };
      const doc = await submit(u, DECLARED_TYPE);
      const { run } = await ledger(doc.id);
      expect(run).toMatchObject({ outcome: 'PARTIAL', errorClass: 'NO_KEK', wrappedDek: null });
      const num = run!.fields.find((f) => f.fieldCode === 'doc_number')!;
      expect(num.valueCt).toBeNull();
      expect(num.valueBlind).toBe(hashSignal(normalizeDocNumber(plain)));
      expect(await plaintextRows('SECRET3')).toBe(0);
      expect(logOut).not.toMatch(/SECRET3/);
    } finally {
      process.env['MASTER_KEK'] = KEK;
      resetKeyProviderForTests();
    }
  });
});
