import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { holdsValidDocument } from '../modules/verification/category-gate';
import { testPhone } from './helpers/fixture-ids';

// A category gate read the status alone, and a renewal's old copy keeps its status: SUPERSEDED, it still reads APPROVED.
// So a renewal that was revoked left the gate passing on the copy it had replaced, until that copy's old date.
//
// The rule (COORD): a copy a newer copy superseded never satisfies a gate. If the newest copy was REVOKED the gate
// fails until a new copy is approved. A REJECTED renewal never replaced the approved copy, so it takes nothing away.
//
// The trigger supersedes within one subject, so a legacy copy bound to no subject stays COMMITTED beside a renewal that
// names one. The same rule holds for it, and it may not tell the person a paper expired beside their valid new copy.
// Real triggers, the real daily sweep and the real reminder sender.

const TYPE = 'gei_electrical_licence';
const DAY = 86_400_000;
const soon = (days: number) => new Date(Date.now() + days * DAY);
const LAPSED = () => new Date(Date.now() - 60_000);
const RUN = nanoid(6).toLowerCase();

let app: FastifyInstance;
let service: VerificationService;
const userIds: string[] = [];

async function person() {
  const user = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Gate', lastName: `G${RUN}`, roles: ['VENDOR_OWNER', 'CUSTOMER'] as never[], activeRole: 'VENDOR_OWNER' as never, isPhoneVerified: true, countryCode: 'GY',
  } });
  userIds.push(user.id);
  return user.id;
}

const copy = (userId: string, expiresAt: Date | null, extra: Record<string, unknown> = {}) => app.prisma.verificationDocument.create({
  data: { userId, role: 'MOVER', docType: TYPE, fileUrl: `test/${RUN}/${nanoid(5)}`, status: 'APPROVED', expiresAt, ...extra } as never,
});
const revoke = (id: string) => app.prisma.verificationDocument.update({ where: { id }, data: { state: 'REVOKED' } as never });
const state = async (id: string) => (await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id } })).state;
const gate = (userId: string) => holdsValidDocument(app.prisma as never, userId, TYPE);
const subject = async (createdById: string) => (await app.prisma.subject.create({ data: { kind: 'VEHICLE', countryCode: 'GY', createdById } })).id;
const told = async (userId: string, kind: string) => (await app.prisma.notification.findMany({ where: { userId } }))
  .filter((row) => (row.data as { kind?: string } | null)?.kind === kind).length;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
});

afterAll(async () => {
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await app.close();
});

describe('a category gate never passes on a copy a newer one replaced', () => {
  it('a renewal revoked: the old unexpired copy does not carry the gate, until a new copy is approved', async () => {
    const owner = await person();
    const old = await copy(owner, soon(200));
    expect(await gate(owner)).toBe(true);

    const renewal = await copy(owner, soon(400));
    expect(await state(old.id)).toBe('SUPERSEDED');
    expect(await gate(owner)).toBe(true);

    await revoke(renewal.id);
    expect(await gate(owner)).toBe(false);

    await copy(owner, soon(400));
    expect(await gate(owner)).toBe(true);
  });

  it('the only copy revoked: the gate fails', async () => {
    const owner = await person();
    const only = await copy(owner, soon(200));
    await revoke(only.id);
    expect(await gate(owner)).toBe(false);
  });

  it('a rejected renewal never replaced the approved copy, and takes nothing away', async () => {
    const owner = await person();
    const old = await copy(owner, soon(200));
    await copy(owner, soon(400), { status: 'REJECTED', state: 'REJECTED' });
    expect(await state(old.id)).toBe('COMMITTED');
    expect(await gate(owner)).toBe(true);
  });

  it('a renewal still waiting for review takes nothing away', async () => {
    const owner = await person();
    await copy(owner, soon(200));
    await copy(owner, soon(400), { status: 'PENDING', state: 'REVIEW_QUEUED' });
    expect(await gate(owner)).toBe(true);
  });

  it('a purged copy is gone; a copy whose image alone was purged still counts', async () => {
    const gone = await person();
    const purged = await copy(gone, soon(200));
    await app.prisma.verificationDocument.update({ where: { id: purged.id }, data: { purgedAt: new Date(), fileUrl: '' } as never });
    expect(await gate(gone)).toBe(false);

    const kept = await person();
    const image = await copy(kept, soon(200));
    await app.prisma.verificationDocument.update({ where: { id: image.id }, data: { imagePurgedAt: new Date(), fileUrl: '' } as never });
    expect(await gate(kept)).toBe(true);
  });

  it('a lapsed copy still fails', async () => {
    const owner = await person();
    await copy(owner, new Date(Date.now() - 40 * DAY));
    expect(await gate(owner)).toBe(false);
  });
});

describe('a legacy copy bound to no subject', () => {
  it('the renewal that named a subject was revoked: the legacy copy does not carry the gate', async () => {
    const owner = await person();
    const legacy = await copy(owner, soon(200));
    const renewal = await copy(owner, soon(400), { subjectId: await subject(owner) });
    expect(await state(legacy.id)).toBe('COMMITTED');
    await revoke(renewal.id);
    expect(await gate(owner)).toBe(false);

    await copy(owner, soon(400), { subjectId: await subject(owner) });
    expect(await gate(owner)).toBe(true);
  });

  it('a rejected renewal on a subject takes nothing away from it', async () => {
    const owner = await person();
    await copy(owner, soon(200));
    await copy(owner, soon(400), { subjectId: await subject(owner), status: 'REJECTED', state: 'REJECTED' });
    expect(await gate(owner)).toBe(true);
  });

  it('a copy revoked BEFORE the legacy one was approved takes nothing away', async () => {
    const owner = await person();
    const earlier = await copy(owner, soon(100), { subjectId: await subject(owner) });
    await revoke(earlier.id);
    await copy(owner, soon(200));
    expect(await gate(owner)).toBe(true);
  });

  it('it lapses beside a valid new copy: it expires, and the person is told nothing false', async () => {
    const owner = await person();
    const legacy = await copy(owner, soon(5));
    await copy(owner, soon(400), { subjectId: await subject(owner) });
    await app.prisma.verificationDocument.update({ where: { id: legacy.id }, data: { expiresAt: LAPSED() } as never });

    await service.expireLapsedDocuments();
    expect(await state(legacy.id)).toBe('EXPIRED');
    expect(await told(owner, 'verification_expired')).toBe(0);
  });

  it('it lapses and the new copy was revoked: the person is told, they hold nothing', async () => {
    const owner = await person();
    const legacy = await copy(owner, soon(5));
    const renewal = await copy(owner, soon(400), { subjectId: await subject(owner) });
    await revoke(renewal.id);
    await app.prisma.verificationDocument.update({ where: { id: legacy.id }, data: { expiresAt: LAPSED() } as never });

    await service.expireLapsedDocuments();
    expect(await told(owner, 'verification_expired')).toBe(1);
  });

  it('it lapses alone: the person is told', async () => {
    const owner = await person();
    const legacy = await copy(owner, soon(5));
    await app.prisma.verificationDocument.update({ where: { id: legacy.id }, data: { expiresAt: LAPSED() } as never });

    await service.expireLapsedDocuments();
    expect(await told(owner, 'verification_expired')).toBe(1);
  });

  it('alone in its reminder window it still gets the reminder', async () => {
    const owner = await person();
    await copy(owner, soon(5));

    await service.sendExpiryReminders();
    expect(await told(owner, 'verification_expiry_reminder')).toBe(1);
  });

  it('no "renew it" reminder beside a valid new copy; the reminder returns if that copy is revoked', async () => {
    const owner = await person();
    await copy(owner, soon(5));
    const renewal = await copy(owner, soon(400), { subjectId: await subject(owner) });

    await service.sendExpiryReminders();
    expect(await told(owner, 'verification_expiry_reminder')).toBe(0);

    await revoke(renewal.id);
    await service.sendExpiryReminders();
    expect(await told(owner, 'verification_expiry_reminder')).toBe(1);
  });
});

describe('a paper bound to a subject stands alone', () => {
  it('a reminder for it still goes out beside a valid copy on another subject', async () => {
    const owner = await person();
    await copy(owner, soon(5), { subjectId: await subject(owner) });
    await copy(owner, soon(400), { subjectId: await subject(owner) });

    await service.sendExpiryReminders();
    expect(await told(owner, 'verification_expiry_reminder')).toBe(1);
  });

  it('a legacy copy, a valid copy on a subject and a newer one revoked: the valid one stands', async () => {
    const owner = await person();
    await copy(owner, soon(200));
    await copy(owner, soon(300), { subjectId: await subject(owner) });
    const revoked = await copy(owner, soon(400), { subjectId: await subject(owner) });
    await revoke(revoked.id);
    expect(await gate(owner)).toBe(true);
  });

  it('it lapses beside a valid copy on another subject: the person is told, that paper is a real one', async () => {
    const owner = await person();
    const first = await copy(owner, soon(5), { subjectId: await subject(owner) });
    await copy(owner, soon(400), { subjectId: await subject(owner) });
    await app.prisma.verificationDocument.update({ where: { id: first.id }, data: { expiresAt: LAPSED() } as never });

    await service.expireLapsedDocuments();
    expect(await told(owner, 'verification_expired')).toBe(1);
  });

  it('a copy on a subject counts first, even with a later copy bound to none', async () => {
    const owner = await person();
    await copy(owner, soon(200), { subjectId: await subject(owner) });
    await copy(owner, soon(300));
    const revoked = await copy(owner, soon(400), { subjectId: await subject(owner) });
    await revoke(revoked.id);
    expect(await gate(owner)).toBe(true);
  });

  it('a copy revoked on one subject leaves the copy on another carrying the gate', async () => {
    const owner = await person();
    await copy(owner, soon(200), { subjectId: await subject(owner) });
    const other = await copy(owner, soon(400), { subjectId: await subject(owner) });
    await revoke(other.id);
    expect(await gate(owner)).toBe(true);
  });
});
