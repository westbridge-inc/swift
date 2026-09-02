import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import {
  IncidentService,
  assertNotSafetySuspended,
} from '../modules/safety/incident.service';
import { syntheticLocationOwner } from './helpers/online-mover';

// Incident Management M6a (safety spec §8) — the case machine. Severity is
// auto-suggested from category, SLA clocks stamp at intake, S0/S1 auto-apply
// the §8.3 interim suspension (due process: category only, never the
// reporter), the §8.4 on-intake pattern hook escalates repeat subjects, and
// the machine enforces OPEN→TRIAGED→INVESTIGATING→DECIDED→CLOSED with
// escalate-police as a parallel legalHold flag.

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
const caseIds: string[] = [];
let seq = 0;
const phoneBase = 592_770_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Inc', lastName: `U${seq}`,
      roles, activeRole: roles[0]!,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(roles.includes('ADMIN') && { admin: { create: { permissions: ['*'] } } }),
      ...extra,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), ...(roles.some((role) => role === 'ADMIN' || role === 'SUPER_ADMIN') && { authMethod: 'OTP' as const }), deviceId: 'inc', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

async function makeDriver() {
  const u = await makeUser(['MOVER']);
  const driver = await app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `INC ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      isOnline: true, isAvailable: true, locationSessionId: syntheticLocationOwner('sfty-inc'),
    },
  });
  return { ...u, driver };
}

async function makeRide(driverId: string, customerId: string, status: string, createdAt?: Date) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `INC-${nanoid(8)}`,
      orderType: 'TAXI', customerId, driverId,
      status: status as never, fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: 'B', deliveryLat: 6.82, deliveryLng: -58.13,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0,
      totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH',
      ...(createdAt ? { createdAt } : {}),
    },
  });
  orderIds.push(order.id);
  return order;
}

const svc = () => new IncidentService(app.prisma, app.io);
const track = <T extends { id: string }>(k: T): T => { caseIds.push(k.id); return k };

/** [REPORT-007] Queue membership must not be conflated with "on the default
 *  first page": severity-first ordering legitimately ranks this suite's S2/S3
 *  fixtures below older S0/S1 rows retained in the shared test DB. Scan pages
 *  until the row is found or the queue ends. */
async function findQueuedIncident<T>(
  token: string,
  status: 'open' | 'breached',
  matches: (row: T) => boolean,
): Promise<T | undefined> {
  const limit = 50;
  for (let page = 1; ; page += 1) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/safety/incidents?status=${status}&page=${page}&limit=${limit}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const rows = response.json().data as T[];
    const found = rows.find(matches);
    if (found || rows.length < limit) return found;
  }
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.legalHold.deleteMany({ where: { case: { OR: [{ id: { in: caseIds } }, { subjectUserId: { in: userIds } }] } } }).catch(() => {}); // [S-09] a held case's hold row RESTRICTs its case
  await app.prisma.incidentCase.deleteMany({ where: { OR: [{ id: { in: caseIds } }, { subjectUserId: { in: userIds } }] } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('canonical request role authority', () => {
  it('[F-026-14] a non-ops caller cannot claim OPS_MANUAL to skip grace or forge provenance', async () => {
    // OPS_MANUAL both skips the reconsider window AND asserts "ops raised this
    // on the person's behalf" on the highest-stakes record the system keeps.
    // A client asserting it would bypass the barrier and write a false origin.
    const actor = await makeUser(['CUSTOMER']);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/safety/sos',
      payload: { source: 'OPS_MANUAL', clientIdempotencyKey: `ops-claim-${nanoid(12)}` },
      headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(200);
    const alertId = response.json().data.id as string;
    const alert = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: alertId } });
    // Downgraded to a BUTTON press: honest provenance, and the grace barrier holds.
    expect(alert.triggerSource).toBe('BUTTON');
    expect(alert.status).toBe('TRIGGER_PENDING');
    expect(alert.graceEndsAt).not.toBeNull();
    await app.prisma.sosAlert.delete({ where: { id: alertId } });
  });

  it('records SOS under the live activeRole instead of the stale JWT claim', async () => {
    const actor = await makeUser(['SUPER_ADMIN', 'CUSTOMER']);
    await app.prisma.user.update({
      where: { id: actor.userId },
      data: { activeRole: 'CUSTOMER' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/safety/sos',
      payload: { clientIdempotencyKey: `role-authority-${nanoid(12)}` },
      headers: {
        authorization: `Bearer ${actor.token}`,
        'content-type': 'application/json',
      },
    });
    expect(response.statusCode).toBe(200);
    const alertId = response.json().data.id as string;
    const alert = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: alertId } });
    expect(alert.actorRole).toBe('CUSTOMER');
    await app.prisma.sosAlert.delete({ where: { id: alertId } });
  });
});

describe('intake — severity, SLA clocks, §8.3 interim suspension', () => {
  it('an S1 report auto-suspends the mover subject and tells them the CATEGORY, never the reporter', async () => {
    const admin = await makeUser(['ADMIN']);
    const reporter = await makeUser(['CUSTOMER']);
    const d = await makeDriver();

    const kase = track(await svc().intake({
      category: 'IDENTITY_MISMATCH', // → S1 by the table
      intake: 'IN_TRIP_REPORT',
      subjectUserId: d.userId,
      reporterUserId: reporter.userId,
      summary: 'Person driving does not match the profile photo',
    }));
    expect(kase.severity).toBe('S1');
    expect(kase.interimAction).toBe('SUSPENDED_PENDING_REVIEW');
    // SLA clocks: S1 = ack 1h / decide 48h from intake.
    expect(Math.round((kase.slaAckBy.getTime() - kase.createdAt.getTime()) / 60_000)).toBe(60);
    expect(Math.round((kase.slaDecideBy.getTime() - kase.createdAt.getTime()) / 3_600_000)).toBe(48);

    const driver = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } });
    expect(driver.safetySuspendedAt).not.toBeNull();
    expect(driver.isOnline).toBe(false); // invisible to dispatch instantly
    expect(() => assertNotSafetySuspended(driver)).toThrow(/contact support/i);

    // Due process without reporter leakage (§8.5).
    const subjectNote = await app.prisma.notification.findFirst({ where: { userId: d.userId, title: 'Account suspended pending review' } });
    expect(subjectNote).not.toBeNull();
    expect(subjectNote!.body).not.toContain(reporter.userId);
    expect(JSON.stringify(subjectNote!.data)).not.toContain(reporter.userId);
    expect(await app.prisma.notification.findFirst({ where: { userId: admin.userId, title: { contains: kase.caseNumber } } })).not.toBeNull();
  });

  it('lower severities do not auto-suspend; S4 quality clocks are the slow lane', async () => {
    const d = await makeDriver();
    const kase = track(await svc().intake({
      category: 'SERVICE_QUALITY',
      intake: 'RATING_FLAG',
      subjectUserId: d.userId,
      summary: 'Car was untidy',
    }));
    expect(kase.severity).toBe('S4');
    expect(kase.interimAction).toBe('NONE');
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } })).safetySuspendedAt).toBeNull();
  });

  it('rolls back the case, dispatch lock, interim action, and due-process notice on a staged fault', async () => {
    const d = await makeDriver();
    const summary = `atomic-intake-fault-${nanoid(10)}`;
    const originalStage = IncidentService.prototype.stageIncidentIntake;
    const stage = vi.spyOn(IncidentService.prototype, 'stageIncidentIntake')
      .mockImplementationOnce(async function (this: IncidentService, tx, input, severity, now) {
        await originalStage.call(this, tx, input, severity, now);
        throw new Error('deterministic failure after every intake authority write');
      });
    try {
      await expect(svc().intake({
        category: 'SAFETY_THREAT',
        intake: 'OPS_CREATED',
        subjectUserId: d.userId,
        summary,
      })).rejects.toThrow('deterministic failure');
    } finally {
      stage.mockRestore();
    }

    const [caseCount, driver, noticeCount] = await Promise.all([
      app.prisma.incidentCase.count({ where: { subjectUserId: d.userId, summary } }),
      app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } }),
      app.prisma.notification.count({
        where: { userId: d.userId, title: 'Account suspended pending review' },
      }),
    ]);
    expect(caseCount).toBe(0);
    expect(driver.safetySuspendedAt).toBeNull();
    expect(driver.isOnline).toBe(true);
    expect(driver.isAvailable).toBe(true);
    expect(noticeCount).toBe(0);
  });
});

describe('the case machine (§8.2)', () => {
  it('walks OPEN→TRIAGED→INVESTIGATING→DECIDED→CLOSED; a DISMISSED decision lifts the suspension', async () => {
    const ops = await makeUser(['ADMIN']);
    const d = await makeDriver();
    const kase = track(await svc().intake({
      category: 'SAFETY_THREAT', intake: 'OPS_CREATED', subjectUserId: d.userId, summary: 'Threatening message reported by phone',
    }));
    expect(kase.interimAction).toBe('SUSPENDED_PENDING_REVIEW');

    // Illegal move first: cannot close an un-decided case.
    await expect(svc().close(kase.id, ops.userId)).rejects.toThrow(/Cannot move/i);

    await svc().ack(kase.id, ops.userId);
    await svc().investigate(kase.id, ops.userId);
    const decided = await svc().decide(kase.id, ops.userId, 'DISMISSED', 'Misunderstanding — voice note was a joke between friends');
    expect(decided.interimAction).toBe('NONE'); // dismissed must not leave anyone suspended
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } })).safetySuspendedAt).toBeNull();
    expect(await app.prisma.notification.findFirst({ where: { userId: d.userId, title: 'Suspension lifted' } })).not.toBeNull();

    const closed = await svc().close(kase.id, ops.userId);
    expect(closed.status).toBe('CLOSED');
  });

  it('does not clear subject safety authority while another active suspension remains', async () => {
    const ops = await makeUser(['ADMIN']);
    const d = await makeDriver();
    const first = track(await svc().intake({
      category: 'SAFETY_THREAT',
      intake: 'OPS_CREATED',
      subjectUserId: d.userId,
      summary: 'First independently reviewed threat report',
    }));
    const second = track(await svc().intake({
      category: 'IDENTITY_MISMATCH',
      intake: 'OPS_CREATED',
      subjectUserId: d.userId,
      summary: 'Separate identity mismatch report still under review',
    }));
    const third = track(await svc().intake({
      category: 'SERVICE_QUALITY',
      intake: 'OPS_CREATED',
      subjectUserId: d.userId,
      summary: 'Separate lower-severity review using a shadow restriction',
    }));
    await svc().shadowRestrict(third.id, ops.userId);
    expect(first.interimAction).toBe('SUSPENDED_PENDING_REVIEW');
    expect(second.interimAction).toBe('SUSPENDED_PENDING_REVIEW');

    await svc().ack(first.id, ops.userId);
    await svc().investigate(first.id, ops.userId);
    const dismissed = await svc().decide(first.id, ops.userId, 'DISMISSED', 'First report cleared');
    const [driverWhileSecondCaseRemains, secondCase, notice] = await Promise.all([
      app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } }),
      app.prisma.incidentCase.findUniqueOrThrow({ where: { id: second.id } }),
      app.prisma.notification.findFirst({
        where: { userId: d.userId, title: 'Safety review updated' },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    expect(dismissed.interimAction).toBe('NONE');
    expect(secondCase.interimAction).toBe('SUSPENDED_PENDING_REVIEW');
    expect(driverWhileSecondCaseRemains.safetySuspendedAt).not.toBeNull();
    expect(driverWhileSecondCaseRemains.safetyShadowRestrictedAt).not.toBeNull();
    expect(() => assertNotSafetySuspended(driverWhileSecondCaseRemains)).toThrow(/contact support/i);
    expect(notice?.body).toContain('Another safety review remains active');
    expect(notice?.body).not.toContain('go back online');

    await svc().ack(second.id, ops.userId);
    await svc().investigate(second.id, ops.userId);
    await svc().decide(second.id, ops.userId, 'DISMISSED', 'Second report cleared independently');
    const shadowOnly = await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } });
    expect(shadowOnly.safetySuspendedAt).toBeNull();
    expect(shadowOnly.safetyShadowRestrictedAt).not.toBeNull();
    await svc().liftInterim(third.id, ops.userId);
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } })).safetyShadowRestrictedAt).toBeNull();
  });

  it('serializes a lift behind concurrent generic S0/S1 intake for the same subject', async () => {
    const ops = await makeUser(['ADMIN']);
    const d = await makeDriver();
    const first = track(await svc().intake({
      category: 'SAFETY_THREAT',
      intake: 'OPS_CREATED',
      subjectUserId: d.userId,
      summary: 'Existing case selected for dismissal',
    }));
    await svc().ack(first.id, ops.userId);
    await svc().investigate(first.id, ops.userId);
    let intakeStaged!: () => void;
    let releaseIntake!: () => void;
    const atIntakeStage = new Promise<void>((resolve) => { intakeStaged = resolve; });
    const holdIntakeCommit = new Promise<void>((resolve) => { releaseIntake = resolve; });
    const originalStage = IncidentService.prototype.stageIncidentIntake;
    const stage = vi.spyOn(IncidentService.prototype, 'stageIncidentIntake')
      .mockImplementationOnce(async function (this: IncidentService, tx, input, severity, now) {
        const staged = await originalStage.call(this, tx, input, severity, now);
        intakeStaged();
        await holdIntakeCommit;
        return staged;
      });
    let second!: Awaited<ReturnType<IncidentService['intake']>>;
    let lifted!: Awaited<ReturnType<IncidentService['decide']>>;
    try {
      const intakePending = svc().intake({
        category: 'IDENTITY_MISMATCH',
        intake: 'OPS_CREATED',
        subjectUserId: d.userId,
        summary: 'Concurrent independent high-severity review',
      });
      await atIntakeStage;

      let liftSettled = false;
      const liftPending = svc().decide(first.id, ops.userId, 'DISMISSED', 'Existing report cleared')
        .finally(() => { liftSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(liftSettled).toBe(false);
      releaseIntake();
      [second, lifted] = await Promise.all([intakePending, liftPending]);
      track(second);
    } finally {
      releaseIntake();
      stage.mockRestore();
    }

    expect(lifted.interimAction).toBe('NONE');
    expect(second.interimAction).toBe('SUSPENDED_PENDING_REVIEW');
    const [driver, persistedSecond] = await Promise.all([
      app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } }),
      app.prisma.incidentCase.findUniqueOrThrow({ where: { id: second.id } }),
    ]);
    expect(driver.safetySuspendedAt).not.toBeNull();
    expect(persistedSecond.interimAction).toBe('SUSPENDED_PENDING_REVIEW');
    expect(await app.prisma.notification.count({
      where: {
        userId: d.userId,
        data: { path: ['caseId'], equals: second.id },
      },
    })).toBe(1);
  });

  it('escalate-police is a parallel flag: any live status, sets legalHold, idempotent', async () => {
    const ops = await makeUser(['ADMIN']);
    const d = await makeDriver();
    const kase = track(await svc().intake({
      category: 'SAFETY_ASSAULT', intake: 'SOS_RESOLUTION', subjectUserId: d.userId, summary: 'Assault reported at SOS resolution',
    }));
    const flagged = await svc().escalatePolice(kase.id, ops.userId);
    expect(flagged.legalHold).toBe(true);
    expect(flagged.escalatedPoliceAt).not.toBeNull();
    expect(flagged.status).toBe('OPEN'); // the machine keeps its own state
    const again = await svc().escalatePolice(kase.id, ops.userId);
    expect(again.escalatedPoliceAt?.getTime()).toBe(flagged.escalatedPoliceAt?.getTime());
  });
});

describe('§8.4 on-intake pattern hook', () => {
  it('a second S2+ case on the same subject inside 180 days escalates one band with a PATTERN stamp', async () => {
    const d = await makeDriver();
    track(await svc().intake({ category: 'SAFETY_HARASSMENT', intake: 'POST_TRIP_REPORT', subjectUserId: d.userId, summary: 'First report' }));
    const second = track(await svc().intake({ category: 'SAFETY_HARASSMENT', intake: 'POST_TRIP_REPORT', subjectUserId: d.userId, summary: 'Second report, different week' }));
    expect(second.severity).toBe('S1'); // S2 bumped one band
    expect(second.patternFlaggedAt).not.toBeNull();
    // The bump makes it S1 → interim applies via severity at intake time only
    // (the hook runs after) — the NEXT S2+ case on this subject starts S1.
  });
});

describe('§8.2/§8.4 sweeps — SLA watch, cross-reporter pattern, weekly digest', () => {
  it('slaWatch surfaces blown ack/decide clocks and ignores healthy or CLOSED cases', async () => {
    const ops = await makeUser(['ADMIN']);
    const d = await makeDriver();
    const kase = track(await svc().intake({ category: 'CASH_DISPUTE', intake: 'OPS_CREATED', subjectUserId: d.userId, summary: 'Fare dispute for SLA test' }));

    expect((await svc().slaWatch()).find((b) => b.id === kase.id)).toBeFalsy(); // healthy clocks

    await app.prisma.incidentCase.update({ where: { id: kase.id }, data: { slaAckBy: new Date(Date.now() - 60_000) } });
    const ackBreach = (await svc().slaWatch()).filter((b) => b.id === kase.id);
    expect(ackBreach).toHaveLength(1);
    expect(ackBreach[0]!.kind).toBe('ACK');

    await svc().ack(kase.id, ops.userId); // acked — ACK breach clears
    await app.prisma.incidentCase.update({ where: { id: kase.id }, data: { slaDecideBy: new Date(Date.now() - 60_000) } });
    const decideBreach = (await svc().slaWatch()).filter((b) => b.id === kase.id);
    expect(decideBreach).toHaveLength(1);
    expect(decideBreach[0]!.kind).toBe('DECIDE');

    await svc().decide(kase.id, ops.userId, 'RESOLVED_OTHER');
    await svc().close(kase.id, ops.userId);
    expect((await svc().slaWatch()).find((b) => b.id === kase.id)).toBeFalsy(); // closed = out of the queue
  });

  it('three DISTINCT reporters in 365d flag the subject once — severity-agnostic, idempotent nightly', async () => {
    const d = await makeDriver();
    const reporters = [await makeUser(['CUSTOMER']), await makeUser(['CUSTOMER']), await makeUser(['CUSTOMER'])];
    for (const r of reporters) {
      track(await svc().intake({
        category: 'SERVICE_QUALITY', // S4 — the rule counts reports, not severity
        intake: 'POST_TRIP_REPORT',
        subjectUserId: d.userId,
        reporterUserId: r.userId,
        summary: 'Made me uncomfortable',
      }));
    }
    const flagged = await svc().crossReporterScan();
    const mine = flagged.find((f) => f.subjectUserId === d.userId);
    expect(mine).toBeTruthy();
    expect(mine!.distinctReporters).toBe(3);
    expect(await app.prisma.incidentCase.count({ where: { subjectUserId: d.userId, patternFlaggedAt: { not: null } } })).toBe(1);

    // Second night: the subject is already a known pattern — no re-flag.
    const again = await svc().crossReporterScan();
    expect(again.find((f) => f.subjectUserId === d.userId)).toBeFalsy();
    expect(await app.prisma.incidentCase.count({ where: { subjectUserId: d.userId, patternFlaggedAt: { not: null } } })).toBe(1);
  });

  it('two reporters is not a pattern; the same reporter three times is not a pattern', async () => {
    const d = await makeDriver();
    const one = await makeUser(['CUSTOMER']);
    for (let i = 0; i < 3; i += 1) {
      track(await svc().intake({ category: 'SERVICE_QUALITY', intake: 'POST_TRIP_REPORT', subjectUserId: d.userId, reporterUserId: one.userId, summary: `Same reporter ${i}` }));
    }
    expect((await svc().crossReporterScan()).find((f) => f.subjectUserId === d.userId)).toBeFalsy();
  });

  it('the weekly digest carries the load numbers the founder needs', async () => {
    const digest = await svc().weeklyDigest();
    expect(digest.lines).toHaveLength(4);
    expect(digest.open).toBeGreaterThan(0); // fixtures from this file are open
    expect(digest.lines[0]).toContain('Open cases');
    expect(digest.lines[1]).toContain('SLA breaches');
  });
});

describe('§8.1 system auto-intakes', () => {
  it('an SOS ops-coded as ABUSE opens a case against the counterparty', async () => {
    const ops = await makeUser(['ADMIN']);
    const victim = await makeUser(['CUSTOMER']);
    const d = await makeDriver();
    const { SosService } = await import('../modules/safety/sos.service');
    const sos = new SosService(app.prisma, app.io);
    const alert = await sos.create({
      actorUserId: victim.userId, actorRole: 'CUSTOMER', counterpartyUserId: d.userId,
      triggerSource: 'BUTTON', immediate: true,
    });
    await sos.ack(alert.id, ops.userId);
    await sos.resolve(alert.id, ops.userId, 'ABUSE', 'Verbal threats confirmed on callback');

    const kase = await app.prisma.incidentCase.findFirst({ where: { sosAlertId: alert.id } });
    expect(kase).not.toBeNull();
    caseIds.push(kase!.id);
    expect(kase!.category).toBe('SAFETY_THREAT'); // ABUSE → S1 lane
    expect(kase!.intake).toBe('SOS_RESOLUTION');
    expect(kase!.subjectUserId).toBe(d.userId);
    expect(kase!.reporterUserId).toBe(victim.userId);
    // S1 auto-suspend engaged off the SOS trail too.
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: d.driver.id } })).safetySuspendedAt).not.toBeNull();
    await app.prisma.sosAlert.delete({ where: { id: alert.id } });
  });
});

describe('report + ops routes', () => {
  it('a participant reports the other party; window enforced; ops queue sees it; strangers/non-ops do not', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const stranger = await makeUser(['CUSTOMER']);
    const admin = await makeUser(['ADMIN']);
    const d = await makeDriver();
    const ride = await makeRide(d.driver.id, passenger.userId, 'COMPLETED');

    const res = await app.inject({
      method: 'POST', url: '/api/v1/safety/incidents',
      payload: { orderId: ride.id, category: 'DRIVING_DANGEROUS', summary: 'Ran two red lights on Vlissengen Road' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${passenger.token}` },
    });
    expect(res.statusCode).toBe(200);
    const { caseNumber } = res.json().data;
    const kase = await app.prisma.incidentCase.findUniqueOrThrow({ where: { caseNumber } });
    caseIds.push(kase.id);
    expect(kase.subjectUserId).toBe(d.userId); // the OTHER party, inferred server-side
    expect(kase.reporterUserId).toBe(passenger.userId);
    expect(kase.intake).toBe('POST_TRIP_REPORT');

    // Window: a 31-day-old trip is closed for self-serve reports.
    const old = await makeRide(d.driver.id, passenger.userId, 'COMPLETED', new Date(Date.now() - 31 * 86_400_000));
    const late = await app.inject({
      method: 'POST', url: '/api/v1/safety/incidents',
      payload: { orderId: old.id, category: 'OTHER', summary: 'Very late report' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${passenger.token}` },
    });
    expect(late.statusCode).toBe(410);

    // A stranger is not a participant — the order does not exist for them.
    const nosy = await app.inject({
      method: 'POST', url: '/api/v1/safety/incidents',
      payload: { orderId: ride.id, category: 'OTHER', summary: 'I heard about this trip' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${stranger.token}` },
    });
    expect(nosy.statusCode).toBe(404);

    expect(await findQueuedIncident<{ caseNumber: string }>(
      admin.token, 'open', (c) => c.caseNumber === caseNumber,
    )).toBeTruthy();
    const forbidden = await app.inject({ method: 'GET', url: '/api/v1/safety/incidents', headers: { authorization: `Bearer ${passenger.token}` } });
    expect(forbidden.statusCode).toBe(403);
  });

  it('the breached queue reads blown SLA clocks', async () => {
    const admin = await makeUser(['ADMIN']);
    const d = await makeDriver();
    const kase = track(await svc().intake({ category: 'CASH_DISPUTE', intake: 'OPS_CREATED', subjectUserId: d.userId, summary: 'Fare dispute' }));
    expect(await findQueuedIncident<{ id: string }>(
      admin.token, 'breached', (c) => c.id === kase.id,
    )).toBeFalsy();

    await app.prisma.incidentCase.update({ where: { id: kase.id }, data: { slaAckBy: new Date(Date.now() - 60_000) } });
    expect(await findQueuedIncident<{ id: string }>(
      admin.token, 'breached', (c) => c.id === kase.id,
    )).toBeTruthy();
  });

  it('a low-severity case buried beyond the first page is still reachable [REPORT-007 pagination]', async () => {
    const admin = await makeUser(['ADMIN']);
    const d = await makeDriver();
    // Bury the queue: 55 S0 assault cases rank ahead of ANY S3, guaranteeing
    // the dispute lands past the default 50-row first page whatever the shared
    // DB already holds. Before pagination this row was API-unreachable.
    for (let i = 0; i < 55; i += 1) {
      track(await svc().intake({ category: 'SAFETY_ASSAULT', intake: 'OPS_CREATED', subjectUserId: d.userId, summary: `burial ${i}` }));
    }
    const kase = track(await svc().intake({ category: 'CASH_DISPUTE', intake: 'OPS_CREATED', subjectUserId: d.userId, summary: 'Buried fare dispute' }));
    const firstPage = await app.inject({ method: 'GET', url: '/api/v1/safety/incidents?status=open', headers: { authorization: `Bearer ${admin.token}` } });
    expect((firstPage.json().data as Array<{ id: string }>).find((c) => c.id === kase.id)).toBeFalsy();
    expect(await findQueuedIncident<{ id: string }>(
      admin.token, 'open', (c) => c.id === kase.id,
    )).toBeTruthy();
  });
});
