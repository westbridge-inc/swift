/**
 * [DOC-1 §3.7 · LEGAL-CONFLICT-1 · DOC-INV-44 · E2E-DOC-2 · P3-3] test_taxi_validators
 *
 * Only the corroborated plate rule is enforced: a taxi (a Driver profile) carries an H
 * mark. Every other prefix letter is a disputed fact and is never judged; delivery
 * movers (Rider profiles) are exempt from the H-plate rule. The
 * validators judge what was read and SKIP what was not (a SKIP is never a PASS); the
 * cross-match anchors on the plate the mover registered. At approval, a taxi's vehicle
 * document on a non-H plate is refused with WRONG_PLATE_CLASS; fixing the plate and
 * resubmitting approves (E2E-DOC-2).
 *
 * [Owner ruling 2026-10-01] A yellow car is NOT a requirement for a taxi — this overrides
 * DOC-1 §3.7 ("hire cars are Corporate Yellow"). The H plate stays required, exactly as
 * before. No rule judges the colour, the reviewer is no longer offered NOT_YELLOW, and the
 * decisions recorded under it before the ruling stay readable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VALIDATOR_IMPLEMENTATIONS, NO_CONTEXT, resolvesImpl, type ValidatorContext } from '../modules/verification/validators';
import { VALIDATOR_CATALOGUE, FIELD_CATALOGUE, seedDocRegistry, registryCode, registryCompletenessGaps } from '../modules/verification/doc-registry';
import { ACTOR_FACING_CATEGORY, REJECTION_REASON_CODES, RETIRED_REJECTION_REASON_CODES } from '../modules/verification/verification.service';
import { planExtraction, autoApproveEligible, type RoutingType } from '../modules/verification/extraction-ledger';
import { custodyNarrative } from '../modules/verification/custody';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const REASON = `Decision ${RUN}: taxi documents reviewed`;
const TAXI: ValidatorContext = { taxi: true, registrationMark: `HB${NUM}`, docType: 'vehicle_registration', bucket: 'VEHICLE' };
const DELIVERY: ValidatorContext = { taxi: false, registrationMark: `PAB${NUM}`, docType: 'vehicle_registration', bucket: 'VEHICLE' };

let app: FastifyInstance;
let adminApp: FastifyInstance;
let adminToken = '';
let adminId = '';
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-taxi-validators-test');

async function mover(n: number, kind: 'taxi' | 'delivery', plate: string, vehicleColor = 'Yellow') {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59270${NUM}${n}`, firstName: 'Taxi', lastName: `Val${n}`, activeRole: 'MOVER', roles: ['MOVER'], countryCode: 'GY', avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  if (kind === 'taxi') await system(() => app.prisma.driver.create({ data: { userId: u.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor, vehicleType: 'CAR', licensePlate: plate, driverLicenseUrl: `/uploads/test/${RUN}-dl.jpg`, vehicleInsuranceUrl: `/uploads/test/${RUN}-ins.jpg` } }));
  else await system(() => app.prisma.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'CAR', licensePlate: plate } }));
  return u.id;
}
const pending = (userId: string, docType = 'vehicle_registration') => system(() => app.prisma.verificationDocument.create({ data: { userId, role: 'MOVER', docType, fileUrl: `/uploads/verification/${RUN}/${nanoid(5)}.enc`, status: 'PENDING' } }));
const admin = (method: 'PUT', url: string, payload: Record<string, unknown>) => adminApp.inject({
  method, url: `/api/v1/admin${url}`, payload, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
});
const approve = (docId: string) => admin('PUT', `/verification/${docId}/approve`, { expiresAt: new Date(Date.now() + 100 * DAY).toISOString() });
const run = (impl: string, present: Record<string, string>, context: ValidatorContext = NO_CONTEXT) =>
  VALIDATOR_IMPLEMENTATIONS[`validators#${impl}`]!({ declared: [], present: new Map(Object.entries(present)), collided: false, context });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.ready();
  adminApp = Fastify({ logger: false });
  registerErrorHandler(adminApp); registerEmptyJsonBodyParser(adminApp);
  await adminApp.register(prismaPlugin); await adminApp.register(redisPlugin); await adminApp.register(authPlugin); await adminApp.register(socketPlugin);
  await adminApp.register(adminRoutes, { prefix: '/api/v1/admin' });
  await adminApp.ready();
  const a = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59270${NUM}0`, firstName: 'Taxi', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
  } }));
  adminId = a.id; users.push(adminId);
  adminToken = app.jwt.sign({ userId: a.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: a.id, token: adminToken, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `taxi-admin-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } });
});

afterAll(async () => {
  await system(async () => {
    // A decision is written under a case keyed by the document id (no FK), so cases and decisions go first, by id.
    const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } })).map((d) => d.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: adminId } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await adminApp.close(); await app.close();
});

describe('[DOC-1 P3-3] the taxi validators judge what was read, SKIP what was not, and only for taxis', () => {
  it('V_PLATE_CLASS: H passes for a taxi, any other letter fails (never judged for delivery, never judged unread)', () => {
    expect(run('V_PLATE_CLASS', { registration_mark: 'HB 1234' }, TAXI)).toEqual({ status: 'PASS' });
    expect(run('V_PLATE_CLASS', { registration_mark: 'hc-4321' }, TAXI)).toEqual({ status: 'PASS' });
    expect(run('V_PLATE_CLASS', { registration_mark: 'PAB 1234' }, TAXI)).toEqual({ status: 'FAIL' });
    expect(run('V_PLATE_CLASS', { registration_mark: 'GAA 1' }, TAXI)).toEqual({ status: 'FAIL' });
    expect(run('V_PLATE_CLASS', { registration_mark: 'PAB 1234' }, DELIVERY)).toEqual({ status: 'SKIP', detailCode: 'NOT_APPLICABLE' });
    expect(run('V_PLATE_CLASS', {}, TAXI)).toEqual({ status: 'SKIP', detailCode: 'UNDETERMINABLE' });
  });
  it('V_PLATE_CROSS_MATCH: the read mark must be the registered mark, compared normalised; no anchor or nothing read is a SKIP', () => {
    expect(run('V_PLATE_CROSS_MATCH', { registration_mark: `hb ${NUM}` }, TAXI)).toEqual({ status: 'PASS' });
    expect(run('V_PLATE_CROSS_MATCH', { registration_mark: 'HB 0000' }, TAXI)).toEqual({ status: 'FAIL' });
    expect(run('V_PLATE_CROSS_MATCH', { registration_mark: `PAB-${NUM}` }, DELIVERY)).toEqual({ status: 'PASS' });
    expect(run('V_PLATE_CROSS_MATCH', { registration_mark: 'HB 1' }, { ...TAXI, registrationMark: null })).toEqual({ status: 'SKIP', detailCode: 'UNDETERMINABLE' });
    expect(run('V_PLATE_CROSS_MATCH', { registration_mark: 'HB 1' }, { ...TAXI, bucket: 'PERSONAL', docType: 'national_id' })).toEqual({ status: 'SKIP', detailCode: 'NOT_APPLICABLE' });
    expect(run('V_PLATE_CROSS_MATCH', {}, TAXI)).toEqual({ status: 'SKIP', detailCode: 'UNDETERMINABLE' });
  });
  // [VERIFY-DOCS · owner ruling 8, 6 Oct 2026 — a DELIBERATE change] There is no "H class" rule on the
  // ordinary licence any more: the hire right is the person's Hire Car Driver's Licence, a separate
  // document on the taxi checklist. V_LICENCE_CLASS is retired the way V_VEHICLE_COLOUR was: declared,
  // never blocking, never implemented — a licence with no hire class is no longer failed for it.
  it('V_LICENCE_CLASS is retired: no implementation judges a licence class, and its row blocks nothing', () => {
    expect(VALIDATOR_IMPLEMENTATIONS['validators#V_LICENCE_CLASS']).toBeUndefined();
    expect(VALIDATOR_CATALOGUE.find((v) => v.code === 'V_LICENCE_CLASS')).toMatchObject({ isBlocking: false, detailCode: 'LICENCE_CLASS_MISMATCH', docTypeLegacy: 'drivers_licence' });
    expect(VALIDATOR_CATALOGUE.find((v) => v.code === 'V_LICENCE_CLASS')!.implRef).toBeUndefined();
  });
  it('the catalogue rows are blocking, carry the spec reasons, resolve to these implementations', () => {
    // (V_VEHICLE_COLOUR and V_LICENCE_CLASS are retired by the owner's rulings of 2026-10-01 and 2026-10-06.)
    for (const [code, detail] of [['V_PLATE_CLASS', 'WRONG_PLATE_CLASS'], ['V_PLATE_CROSS_MATCH', 'PLATE_CROSS_MISMATCH']] as const) {
      expect(VALIDATOR_CATALOGUE.find((v) => v.code === code), code).toMatchObject({ isBlocking: true, detailCode: detail, implRef: `validators#${code}` });
    }
    expect(REJECTION_REASON_CODES).toContain('WRONG_PLATE_CLASS');
    expect(ACTOR_FACING_CATEGORY['WRONG_PLATE_CLASS']).toBe('REQUIREMENT');
  });
});

describe('[DOC-1 P3-3 · E2E-DOC-2] a taxi on a P plate is blocked with WRONG_PLATE_CLASS; the corrected plate goes through', () => {
  it('approval of a taxi\'s vehicle document is refused on a non-H plate, allowed on H; a delivery car on a P plate is not gated', async () => {
    const taxi = await mover(1, 'taxi', `PAB ${NUM.slice(-4)}`);
    const d = await pending(taxi);
    const blocked = await approve(d.id);
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe('WRONG_PLATE_CLASS');
    const rejected = await admin('PUT', `/verification/${d.id}/reject`, { reason: 'Plate is not a hire mark', reasonCode: 'WRONG_PLATE_CLASS' });
    expect(rejected.statusCode).toBe(200);
    // the driver corrects the vehicle's registration mark and resubmits
    await system(() => app.prisma.driver.update({ where: { userId: taxi }, data: { licensePlate: `HB ${NUM.slice(-4)}` } }));
    const again = await pending(taxi);
    expect((await approve(again.id)).statusCode).toBe(200);
    const delivery = await mover(2, 'delivery', `PAB ${NUM.slice(-3)}9`);
    const dd = await pending(delivery);
    expect((await approve(dd.id)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// [Owner ruling 2026-10-01] "A yellow coloured car in the document area isn't a requirement."
// This overrides DOC-1 §3.7 ("hire cars are Corporate Yellow"). The H plate stays required:
// every plate rule above, and the approval guard, are unchanged and still graded here.
// ---------------------------------------------------------------------------
describe('[owner ruling 2026-10-01] a taxi may be any colour — the H plate stays required', () => {
  const COLOURS = ['Corporate Yellow', 'Yellow', 'White', 'Silver', 'Black'] as const;
  const verdicts = (present: Record<string, string>) => Object.fromEntries(Object.entries(VALIDATOR_IMPLEMENTATIONS)
    .map(([implRef, impl]) => [implRef, impl({ declared: [], present: new Map(Object.entries(present)), collided: false, context: TAXI })]));

  it('no rule judges the colour: a non-yellow taxi with a visible H plate passes, and every verdict is the same whatever the colour', () => {
    const unread = verdicts({ registration_mark: `HB ${NUM}` });
    for (const colour of COLOURS) {
      const got = verdicts({ registration_mark: `HB ${NUM}`, colour });
      expect(got, colour).toEqual(unread);
      expect(Object.entries(got).filter(([, v]) => v.status === 'FAIL'), colour).toEqual([]);
    }
    expect(unread['validators#V_PLATE_CLASS']).toEqual({ status: 'PASS' });
    expect(unread['validators#V_PLATE_CROSS_MATCH']).toEqual({ status: 'PASS' });
  });

  it('a missing H plate still fails, whatever the colour — a yellow car on a P plate included', () => {
    for (const colour of [...COLOURS, null]) {
      const present: Record<string, string> = colour ? { registration_mark: 'PAB 1234', colour } : { registration_mark: 'PAB 1234' };
      expect(run('V_PLATE_CLASS', present, TAXI), String(colour)).toEqual({ status: 'FAIL' });
    }
  });

  it('the registry keeps the colour rule only as a retired record — declared, blocking nothing, no implementation, no field names it — and a database seeded by the previous build is reconciled on the next boot with no gap', async () => {
    const row = VALIDATOR_CATALOGUE.find((v) => v.code === 'V_VEHICLE_COLOUR');
    expect(row).toMatchObject({ scope: 'FIELD', isBlocking: false, detailCode: 'VEHICLE_COLOUR_NON_COMPLIANT' });
    expect(row?.implRef).toBeUndefined();
    expect(Object.keys(VALIDATOR_IMPLEMENTATIONS)).not.toContain('validators#V_VEHICLE_COLOUR');
    for (const [type, fields] of Object.entries(FIELD_CATALOGUE)) for (const f of fields) expect(f.validatorRef, `${type}.${f.fieldCode}`).not.toBe('V_VEHICLE_COLOUR');
    // the colour is still read off the registration and recorded — just never judged
    expect(FIELD_CATALOGUE['vehicle_registration']!.find((f) => f.fieldCode === 'colour')).toEqual({ fieldCode: 'colour', dataType: 'text' });

    const REG = registryCode('GY', 'vehicle_registration');
    const colourField = { docTypeCode_fieldCode: { docTypeCode: REG, fieldCode: 'colour' } };
    await system(() => seedDocRegistry(app.prisma));
    // the rows exactly as the previous build left them …
    await system(async () => {
      await app.prisma.validator.update({ where: { code: 'V_VEHICLE_COLOUR' }, data: { isBlocking: true, implRef: 'validators#V_VEHICLE_COLOUR' } });
      await app.prisma.docField.update({ where: colourField, data: { validatorRef: 'V_VEHICLE_COLOUR' } });
    });
    // … and the next boot's seed
    await system(() => seedDocRegistry(app.prisma));
    expect(await system(() => app.prisma.validator.findUnique({ where: { code: 'V_VEHICLE_COLOUR' }, select: { isBlocking: true, implRef: true } }))).toEqual({ isBlocking: false, implRef: null });
    expect(await system(() => app.prisma.docField.findUnique({ where: colourField, select: { validatorRef: true } }))).toEqual({ validatorRef: null });
    expect(await system(() => app.prisma.docField.count({ where: { validatorRef: 'V_VEHICLE_COLOUR' } }))).toBe(0);
    // production refuses to boot on a registry gap — the retired rule leaves none
    const gaps = await system(() => registryCompletenessGaps(app.prisma, resolvesImpl));
    expect(gaps.filter((g) => `${g.docTypeCode} ${g.detail ?? ''}`.includes('V_VEHICLE_COLOUR'))).toEqual([]);
  });

  it('with the seeded registry, a taxi registration on an H plate passes every rule and may auto-approve once its type is active; on a P plate it is held (WRONG_PLATE_CLASS)', async () => {
    await system(() => seedDocRegistry(app.prisma));
    const REG = registryCode('GY', 'vehicle_registration');
    // exactly what planExtractionFor reads for a submission of this type
    const validators = await system(() => app.prisma.validator.findMany({ where: { OR: [{ docTypeCode: null }, { docTypeCode: REG }] }, select: { code: true, isBlocking: true, detailCode: true, implRef: true } }));
    const declared = await system(() => app.prisma.docField.findMany({ where: { docTypeCode: REG }, select: { fieldCode: true, isRequired: true, isBlindIndexed: true } }));
    const plan = (documentNumber: string) => planExtraction({
      validators, declared, legacyCode: 'vehicle_registration', context: TAXI, profileCode: 'TAXI_RULE_TEST',
      engine: { name: 'taxi-rule-test', version: '1', external: false }, extracted: { documentNumber }, confidence: 0.99,
      startedAt: new Date(), finishedAt: new Date(), collided: false,
    });
    // routing once the type's legal facts are verified — pure, so no registry row is activated here
    const ACTIVE: RoutingType = { isActive: true, bucket: 'VEHICLE', needsSpecimen: false, alwaysReview: false, minConfidenceAutoApprove: 0.9 };

    const onH = await plan(`HB ${NUM}`);
    expect(onH.validations.map((v) => v.validatorCode)).not.toContain('V_VEHICLE_COLOUR');
    expect(onH.validations).toContainEqual({ validatorCode: 'V_PLATE_CLASS', status: 'PASS', detailCode: null, isBlocking: true });
    expect(onH.validations.filter((v) => v.isBlocking && v.status !== 'PASS')).toEqual([]);
    expect(autoApproveEligible(onH, ACTIVE, false)).toEqual({ eligible: true, reason: null });

    const onP = await plan(`PAB ${NUM}`);
    expect(onP.validations).toContainEqual({ validatorCode: 'V_PLATE_CLASS', status: 'FAIL', detailCode: 'WRONG_PLATE_CLASS', isBlocking: true });
    expect(onP.blockingFail).toBe(true);
    expect(autoApproveEligible(onP, ACTIVE, false)).toEqual({ eligible: false, reason: 'BLOCKING_FAIL' });
  });

  it('the reviewer is no longer offered NOT_YELLOW, the H plate keeps its reason, and no rejection copy asks for a colour', () => {
    expect(REJECTION_REASON_CODES).not.toContain('NOT_YELLOW');
    expect(REJECTION_REASON_CODES).toContain('WRONG_PLATE_CLASS');
    const src = readFileSync(join(__dirname, '..', 'modules', 'verification', 'verification.service.ts'), 'utf8');
    const block = /const REJECTION_TEMPLATES: Record<RejectionReasonCode, string> = \{([\s\S]*?)\n\};/.exec(src);
    if (!block) throw new Error('REJECTION_TEMPLATES not found in verification.service.ts');
    // one opening line per code a reviewer may choose — a retired code has none, so it cannot be applied
    expect([...block[1]!.matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]!).sort()).toEqual([...REJECTION_REASON_CODES].sort());
    expect(block[1]).not.toMatch(/yellow|colou?r/i);
  });

  it('NOT_YELLOW is refused for a new decision — nothing is decided — and the white car on an H plate is then approved', async () => {
    const photo = await pending(await mover(3, 'taxi', `HD ${NUM.slice(-4)}`, 'White'), 'vehicle_exterior_photo');
    const refused = await admin('PUT', `/verification/${photo.id}/reject`, { reason: 'The car is white, not yellow', reasonCode: 'NOT_YELLOW' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('VALIDATION_ERROR');
    expect(await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: photo.id }, select: { status: true, reviewNote: true } }))).toEqual({ status: 'PENDING', reviewNote: null });
    expect(await system(() => app.prisma.reviewDecision.count({ where: { case: { submissionId: photo.id } } }))).toBe(0);
    expect((await approve(photo.id)).statusCode).toBe(200);
  });

  it('the exterior photo is judged on the plate, never the colour: a white taxi on an H plate is approved; on a P plate — white or yellow — the approval is refused (WRONG_PLATE_CLASS)', async () => {
    const whiteOnH = await pending(await mover(4, 'taxi', `HC ${NUM.slice(-4)}`, 'White'), 'vehicle_exterior_photo');
    expect((await approve(whiteOnH.id)).statusCode).toBe(200);
    for (const [n, colour, plate] of [[5, 'White', `PBC ${NUM.slice(-4)}`], [6, 'Yellow', `PCD ${NUM.slice(-4)}`]] as const) {
      const photo = await pending(await mover(n, 'taxi', plate, colour), 'vehicle_exterior_photo');
      const refused = await approve(photo.id);
      expect(refused.statusCode, colour).toBe(400);
      expect(refused.json().error.code, colour).toBe('WRONG_PLATE_CLASS');
    }
  });

  it('a decision recorded under NOT_YELLOW before the ruling stays readable: its code, its category and the old colour verdict are still reported', async () => {
    expect(RETIRED_REJECTION_REASON_CODES).toContain('NOT_YELLOW');
    expect(ACTOR_FACING_CATEGORY['NOT_YELLOW']).toBe('REQUIREMENT');
    const reg = await pending(await mover(7, 'taxi', `HE ${NUM.slice(-4)}`, 'White'));
    // the rows a pre-ruling decision left behind, written as that build wrote them
    await system(async () => {
      const kase = await app.prisma.reviewCase.create({ data: { submissionId: reg.id, queue: 'STANDARD', slaDueAt: new Date(), closedAt: new Date() } });
      await app.prisma.reviewDecision.create({ data: { caseId: kase.id, reviewerId: adminId, outcome: 'REJECT', reasonCode: 'NOT_YELLOW', actorFacingCategory: 'REQUIREMENT' } });
      await app.prisma.validationResult.create({ data: { submissionId: reg.id, validatorCode: 'V_VEHICLE_COLOUR', status: 'FAIL', detailCode: 'VEHICLE_COLOUR_NON_COMPLIANT', isBlocking: true } });
    });
    const n = await system(() => custodyNarrative(app.prisma, reg.id));
    expect(n.review.flatMap((c) => c.decisions)).toEqual([expect.objectContaining({ outcome: 'REJECT', reasonCode: 'NOT_YELLOW', actorFacingCategory: 'REQUIREMENT' })]);
    expect(n.validations).toEqual([expect.objectContaining({ code: 'V_VEHICLE_COLOUR', status: 'FAIL', detailCode: 'VEHICLE_COLOUR_NON_COMPLIANT', blocking: true })]);
    expect(n.timeline.map((e) => e.what)).toContain('DECIDED REJECT under NOT_YELLOW');
  });
});
