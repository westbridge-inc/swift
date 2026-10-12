import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { AccountService } from '../modules/user/account.service';
import { LocalStorageProvider } from '../providers/storage/storage-provider';
import { placeDocLegalHold, releaseDocLegalHold } from '../modules/verification/legal-hold';
import { retryAccountErasures } from '../modules/user/account-erasure-retry';

const storage = new LocalStorageProvider();
vi.mock('../providers/storage/storage-provider', async (original) => ({ ...await original<object>(), getStorageProvider: () => storage }));
const fields = ['nationalIdUrl', 'driverLicenseUrl', 'vehicleInsuranceUrl', 'profilePhotoUrl', 'vehiclePhotoUrl'] as const;
let app: FastifyInstance;
const ids: string[] = [];
const objects: string[] = [];
const bytes = Buffer.from('synthetic erasure fixture');
const service = () => new AccountService({ prisma: app.prisma, log: app.log, io: { in: () => ({ disconnectSockets: () => undefined }) } as any });

beforeAll(async () => { app = Fastify({ logger: false }); await app.register(prismaPlugin); await app.ready(); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await app.prisma.verificationDocument.updateMany({ where: { userId: { in: ids } }, data: { legalHoldId: null } });
  await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: ids } } });
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  for (const key of objects) await storage.delete(key);
  await app.close();
});

async function mover(role: 'rider' | 'driver') {
  const user = await app.prisma.user.create({ data: { phone: `+592${Date.now()}${ids.length}`, firstName: 'Synthetic', lastName: 'Mover', roles: ['MOVER'], activeRole: 'MOVER' } });
  ids.push(user.id);
  const profile = role === 'rider'
    ? await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } })
    : await app.prisma.driver.create({ data: { userId: user.id, vehicleType: 'CAR', vehicleMake: 'Test', vehicleModel: 'Test', vehicleYear: 2020, vehicleColor: 'White', licensePlate: nanoid(8), driverLicenseUrl: '', vehicleInsuranceUrl: '' } });
  const urls: Record<string, string> = {};
  for (const field of fields) {
    const encrypted = !field.endsWith('PhotoUrl');
    const folder = encrypted ? `verification/${user.id}` : field === 'vehiclePhotoUrl' ? `vehicles/${profile.id}` : `avatars/${user.id}`;
    const { url } = await storage.upload({ buffer: bytes, filename: encrypted ? 'test.enc' : 'test.jpg', mimeType: 'application/octet-stream', folder });
    urls[field] = url; objects.push(url);
    if (encrypted) await app.prisma.encryptedObject.create({ data: { fileKey: url, createdBy: user.id, iv: Buffer.alloc(12), authTag: Buffer.alloc(16), wrappedDek: Buffer.alloc(60), sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, mimeType: 'image/jpeg' } });
  }
  if (role === 'rider') await app.prisma.rider.update({ where: { id: profile.id }, data: urls });
  else await app.prisma.driver.update({ where: { id: profile.id }, data: urls });
  const read = () => role === 'rider' ? app.prisma.rider.findUniqueOrThrow({ where: { id: profile.id } }) : app.prisma.driver.findUniqueOrThrow({ where: { id: profile.id } });
  return { userId: user.id, profileId: profile.id, urls, read };
}

describe('driver vehicle inspection document erasure', () => {
  it('purges the vehicle inspection document with the account, as every other mover document', async () => {
    const p = await mover('driver');
    const { url } = await storage.upload({ buffer: bytes, filename: 'test.enc', mimeType: 'application/octet-stream', folder: `verification/${p.userId}` });
    objects.push(url);
    await app.prisma.encryptedObject.create({ data: { fileKey: url, createdBy: p.userId, iv: Buffer.alloc(12), authTag: Buffer.alloc(16), wrappedDek: Buffer.alloc(60), sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, mimeType: 'image/jpeg' } });
    await app.prisma.driver.update({ where: { id: p.profileId }, data: { vehicleInspectionUrl: url } });
    expect(await service().deleteAccount(p.userId)).toMatchObject({ deleted: true });
    expect((await app.prisma.driver.findUniqueOrThrow({ where: { id: p.profileId } })).vehicleInspectionUrl).toBeNull();
    await expect(storage.getObject(url)).rejects.toMatchObject({ code: 'ENOENT' });
    const envelope = await app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: url } });
    expect(envelope.wrappedDek).toBeNull();
    expect(envelope.shreddedAt).not.toBeNull();
    expect(await app.prisma.deletionReceipt.count({ where: { subjectId: p.userId, verificationProbeResult: 'CONFIRMED_ABSENT' } })).toBe(6);
  });

  it('does not purge an object another driver\u2019s vehicle inspection pointer still references', async () => {
    const p = await mover('driver'); const other = await mover('driver');
    const alias = p.urls['vehiclePhotoUrl']!.replace('/uploads/', '');
    await app.prisma.driver.update({ where: { id: other.profileId }, data: { vehicleInspectionUrl: alias } });
    const del = vi.spyOn(storage, 'delete');
    expect(await service().deleteAccount(p.userId)).toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE' });
    expect(del).not.toHaveBeenCalledWith(p.urls['vehiclePhotoUrl']);
    expect(await storage.getObject(p.urls['vehiclePhotoUrl']!)).toEqual(bytes);
  });
});

for (const role of ['rider', 'driver'] as const) describe(`${role} legacy document and photo erasure`, () => {
  it('purges all five stored objects, clears pointers, shreds document keys and records purge evidence', async () => {
    const p = await mover(role);
    const result = await service().deleteAccount(p.userId);
    expect(result).toMatchObject({ deleted: true });
    const row = await p.read();
    for (const field of fields) {
      expect(row[field], field).toBe(role === 'driver' && ['driverLicenseUrl', 'vehicleInsuranceUrl'].includes(field) ? '' : null);
      await expect(storage.getObject(p.urls[field]!)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const envelopes = await app.prisma.encryptedObject.findMany({ where: { createdBy: p.userId } });
    expect(envelopes).toHaveLength(3);
    expect(envelopes.every((e) => e.wrappedDek === null && e.shreddedAt !== null)).toBe(true);
    expect(await app.prisma.deletionReceipt.count({ where: { subjectId: p.userId, verificationProbeResult: 'CONFIRMED_ABSENT' } })).toBe(5);
  });

  it('keeps held objects, then the account retry worker purges after legal-hold release', async () => {
    const p = await mover(role);
    const doc = await app.prisma.verificationDocument.create({ data: { userId: p.userId, role: 'MOVER', docType: 'national_id', fileUrl: p.urls['nationalIdUrl']! } });
    const { hold } = await placeDocLegalHold(app.prisma, { subjectUserId: p.userId, placedBy: p.userId, ownerId: p.userId, reason: 'Synthetic preservation case', reviewBy: new Date(Date.now() + 2 * 86400000) });
    expect(await service().deleteAccount(p.userId)).toMatchObject({ deleted: false, status: 'PENDING_LEGAL_HOLD' });
    expect((await p.read()).nationalIdUrl).toBe(p.urls['nationalIdUrl']);
    for (const key of Object.values(p.urls)) await expect(storage.getObject(key)).resolves.toEqual(bytes);
    await releaseDocLegalHold(app.prisma, { holdId: hold.id, releasedBy: p.userId, reason: 'Synthetic case closed' });
    await retryAccountErasures({ prisma: app.prisma, log: app.log, io: { in: () => ({ disconnectSockets: () => undefined }) } as any });
    expect((await p.read()).nationalIdUrl).toBeNull();
    expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } })).purgedAt).not.toBeNull();
    for (const key of Object.values(p.urls)) await expect(storage.getObject(key)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['vehiclePhotoUrl', 'driverLicenseUrl'] as const)('keeps %s pending when bytes survive; retry recovers without login', async (field) => {
    const p = await mover(role);
    const realDelete = storage.delete.bind(storage);
    vi.spyOn(storage, 'delete').mockImplementation(async (key) => { if (key !== p.urls[field]) await realDelete(key); });
    expect(await service().deleteAccount(p.userId)).toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE' });
    expect((await p.read())[field]).toBe(p.urls[field]);
    expect(await storage.getObject(p.urls[field]!)).toEqual(bytes);
    vi.restoreAllMocks();
    expect(await service().deleteAccount(p.userId)).toMatchObject({ deleted: true });
    expect((await p.read())[field]).toBe(role === 'driver' && field === 'driverLicenseUrl' ? '' : null);
    await expect(storage.getObject(p.urls[field]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not purge an owned photo while another account references a local alias', async () => {
    const p = await mover(role); const other = await mover(role);
    const alias = p.urls['vehiclePhotoUrl']!.replace('/uploads/', '');
    if (role === 'rider') await app.prisma.rider.update({ where: { id: other.profileId }, data: { vehiclePhotoUrl: alias } });
    else await app.prisma.driver.update({ where: { id: other.profileId }, data: { vehiclePhotoUrl: alias } });
    const del = vi.spyOn(storage, 'delete');
    expect(await service().deleteAccount(p.userId)).toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE' });
    expect(del).not.toHaveBeenCalledWith(p.urls['vehiclePhotoUrl']);
    expect((await p.read()).vehiclePhotoUrl).toBe(p.urls['vehiclePhotoUrl']);
    expect(await storage.getObject(p.urls['vehiclePhotoUrl']!)).toEqual(bytes);
  });

  it('refuses a foreign object pointer without touching foreign bytes', async () => {
    const p = await mover(role); const other = await mover(role);
    if (role === 'rider') await app.prisma.rider.update({ where: { id: p.profileId }, data: { nationalIdUrl: other.urls['nationalIdUrl'] } });
    else await app.prisma.driver.update({ where: { id: p.profileId }, data: { nationalIdUrl: other.urls['nationalIdUrl'] } });
    const del = vi.spyOn(storage, 'delete');
    expect(await service().deleteAccount(p.userId)).toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE' });
    expect(del).not.toHaveBeenCalledWith(other.urls['nationalIdUrl']);
    expect(await storage.getObject(other.urls['nationalIdUrl']!)).toEqual(bytes);
  });
});

describe('mover object erasure at platform scale', () => {
  it('purges a mover\'s objects when the platform holds more than 10,000 unrelated object references', async () => {
    const p = await mover('rider');
    const tag = nanoid(10).replace(/[^A-Za-z0-9]/g, 'x');
    // 10,001 other accounts, each with its own avatar pointer: unrelated references the census must not have to read.
    await app.prisma.$executeRawUnsafe(`
      INSERT INTO users (id, phone, "firstName", "lastName", "activeRole", "updatedAt", avatar)
      SELECT 'census-${tag}-' || g, '+5920${tag}' || g, 'Synthetic', 'Census', 'CUSTOMER', now(), 'avatars/census-${tag}-' || g || '/aaaaaaaaaaaaaaaa.jpg'
      FROM generate_series(1, 10001) AS g`);
    try {
      expect(await service().deleteAccount(p.userId)).toMatchObject({ deleted: true });
      const row = await p.read();
      for (const field of fields) {
        expect(row[field], field).toBeNull();
        await expect(storage.getObject(p.urls[field]!)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await app.prisma.$executeRawUnsafe(`DELETE FROM users WHERE id LIKE 'census-${tag}-%'`);
    }
  }, 60_000);

  it('names every mover object it leaves pending in the operator log, without the storage key itself', async () => {
    const p = await mover('driver'); const other = await mover('driver');
    await app.prisma.driver.update({ where: { id: p.profileId }, data: { nationalIdUrl: other.urls['nationalIdUrl'] } });
    const log = { ...app.log, warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const svc = new AccountService({ prisma: app.prisma, log: log as any, io: { in: () => ({ disconnectSockets: () => undefined }) } as any });
    expect(await svc.deleteAccount(p.userId)).toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE', pendingDocuments: 1 });
    const pending = log.warn.mock.calls.filter(([, msg]) => msg === 'mover object erasure pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]![0]).toMatchObject({ userId: p.userId, fields: ['driver.nationalIdUrl'], reason: 'Unproven mover object' });
    expect(JSON.stringify(pending[0]![0])).not.toContain(other.urls['nationalIdUrl']!);
  });
});
