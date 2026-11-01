import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerPublicUploads } from '../utils/public-uploads';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { getStorageProvider } from '../providers/storage/storage-provider';
import { signupSelfieFor } from '../modules/verification/signup-selfie';
import { eraseLivenessSelfies, eraseStaleUnclaimedUploads } from '../modules/user/upload-erasure';
import { liveDuplicateHolders } from '../modules/verification/duplicate-holders';
import { sealExistingPhotos } from '../modules/user/seal-existing-photos';
import { runWithoutTenant } from '../plugins/tenant-context';
import { REAL_PNG, uniquePng } from './helpers/real-image';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [DOC-SECURITY G2] THE SELFIES ARE SEALED AT REST, LIKE THE DOCUMENTS.
//
// The signup selfie (the profile photo) and the shift liveness selfie were
// stored as plain images, while the processor register and the Privacy Policy
// say the store holds encrypted images. Each now gets the documents' envelope:
// a per-photo key wrapped by MASTER_KEK, ciphertext only in the bucket. A
// profile photo is read through a short-lived signed link the API mints where
// it minted a presigned link before; the link decrypts in memory, and only
// while the account still points at that photo. An envelope that is a photo is
// never mistaken for a verification upload.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const UPLOAD_DIR = path.join(os.tmpdir(), `swift-sealed-selfies-${nanoid(6)}`);
const PUBLIC = 'https://api.sealed.test';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const SIGNED_LINK = /^https:\/\/api\.sealed\.test\/api\/v1\/auth\/selfie\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]{16}\.enc)\?expires=(\d+)&sig=([a-f0-9]{32})$/;
const saved: Record<string, string | undefined> = {};

let app: FastifyInstance;
const userIds: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'sealed-selfies-test');

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  const user = await system(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Sealed', lastName: 'Selfie', roles, activeRole: roles[0]!, isPhoneVerified: true, status: 'ACTIVE', ...extra,
  } as never }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'sealed', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: user.id, token };
}

function multipartBody(filename: string, mime: string, content: Buffer) {
  const boundary = `----swift${nanoid(8)}`;
  const head = Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}
const postFile = (url: string, token: string, content: Buffer) => {
  const { payload, contentType } = multipartBody('photo.png', 'image/png', content);
  return app.inject({ method: 'POST', url, payload, headers: { 'content-type': contentType, authorization: `Bearer ${token}` } });
};
const diskPath = (key: string) => path.join(UPLOAD_DIR, key.replace(/^\/uploads\//, ''));
const linkPath = (link: string) => link.slice(PUBLIC.length);
const envelope = (fileKey: string) => system(() => app.prisma.encryptedObject.findUnique({ where: { fileKey } }));

beforeAll(async () => {
  for (const k of ['NODE_ENV', 'UPLOAD_DIR', 'MASTER_KEK', 'API_PUBLIC_URL']) saved[k] = process.env[k];
  process.env['NODE_ENV'] = 'development';
  process.env['UPLOAD_DIR'] = UPLOAD_DIR;
  process.env['MASTER_KEK'] = randomBytes(32).toString('base64');
  process.env['API_PUBLIC_URL'] = PUBLIC;
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  registerPublicUploads(app, UPLOAD_DIR);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.livenessCheck.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: userIds } } });
    await app.prisma.storageOrphan.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: userIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  resetKeyProviderForTests();
  await rm(UPLOAD_DIR, { recursive: true, force: true });
});

describe('[DOC-SECURITY G2] the signup selfie is sealed at rest', () => {
  it('stores only ciphertext, with an envelope row for its owner, and answers a signed link, never the stored key', async () => {
    const u = await makeUser(['CUSTOMER']);
    const res = await postFile('/api/v1/auth/selfie', u.token, REAL_PNG);
    expect(res.statusCode, res.body).toBe(200);
    const link = res.json().data.user.avatar as string;
    const match = SIGNED_LINK.exec(link);
    expect(match, link).not.toBeNull();
    expect(match![1]).toBe(u.userId);
    const stored = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: u.userId } }))).avatar!;
    expect(stored).toBe(`/uploads/avatars/${u.userId}/${match![2]}`);
    expect(res.body).not.toContain(stored);
    const onDisk = await readFile(diskPath(stored));
    expect(onDisk.subarray(0, 4).equals(PNG_MAGIC), 'the bucket holds no image').toBe(false);
    expect(onDisk.includes(REAL_PNG.subarray(8, 40))).toBe(false);
    const row = await envelope(stored);
    expect(row).toMatchObject({ createdBy: u.userId, mimeType: 'image/png', shreddedAt: null, sha256: createHash('sha256').update(REAL_PNG).digest('hex') });
    expect(row!.wrappedDek?.length).toBe(60);
  });

  it('the signed link opens the cleaned photo, decrypted in memory, private and never sniffed', async () => {
    const u = await makeUser(['CUSTOMER']);
    const link = (await postFile('/api/v1/auth/selfie', u.token, uniquePng(`meta ${nanoid(6)}`))).json().data.user.avatar as string;
    const img = await app.inject({ method: 'GET', url: linkPath(link) });
    expect(img.statusCode, img.body.slice(0, 200)).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    expect(img.rawPayload.includes(Buffer.from('meta '))).toBe(false); // the metadata the camera wrote is gone
    expect(String(img.headers['cache-control'])).toMatch(/^private, max-age=\d+$/);
    expect(img.headers['x-content-type-options']).toBe('nosniff');
  });

  it("refuses a wrong signature, an expired or far-future link, another account's id, and the stored path itself", async () => {
    const u = await makeUser(['CUSTOMER']);
    const other = await makeUser(['CUSTOMER']);
    const link = (await postFile('/api/v1/auth/selfie', u.token, REAL_PNG)).json().data.user.avatar as string;
    const [, owner, file, expires, sig] = SIGNED_LINK.exec(link)!;
    const flip = (s: string) => `${s[0] === 'a' ? 'b' : 'a'}${s.slice(1)}`;
    const refused = [
      `/api/v1/auth/selfie/${owner}/${file}?expires=${expires}&sig=${flip(sig!)}`,
      `/api/v1/auth/selfie/${owner}/${file}?expires=${Number(expires) + 1}&sig=${sig}`,
      `/api/v1/auth/selfie/${other.userId}/${file}?expires=${expires}&sig=${sig}`,
      `/api/v1/auth/selfie/${owner}/${file}`,
      `/uploads/avatars/${owner}/${file}`,
    ];
    for (const url of refused) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
      expect(r.rawPayload.subarray(0, 4).equals(PNG_MAGIC), url).toBe(false);
    }
    // An expired link (signed for a time already past) is refused like a forged one.
    const { sealedAvatarUrl } = await import('../providers/storage/sealed-photo');
    const stored = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: u.userId } }))).avatar!;
    const old = sealedAvatarUrl(stored, Date.now() - 2 * 3600_000)!;
    expect((await app.inject({ method: 'GET', url: linkPath(old) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: linkPath(link) })).statusCode, 'the real link still opens').toBe(200);
  });

  it('a newer selfie retires the old one: its link stops working, its key is shredded and its bytes deleted', async () => {
    const u = await makeUser(['CUSTOMER']);
    const first = (await postFile('/api/v1/auth/selfie', u.token, uniquePng(`first ${nanoid(6)}`))).json().data.user.avatar as string;
    const firstKey = `/uploads/avatars/${u.userId}/${SIGNED_LINK.exec(first)![2]}`;
    expect((await app.inject({ method: 'GET', url: linkPath(first) })).statusCode).toBe(200);
    const second = await postFile('/api/v1/auth/selfie', u.token, uniquePng(`second ${nanoid(6)}`));
    expect(second.statusCode, second.body).toBe(200);
    expect((await app.inject({ method: 'GET', url: linkPath(first) })).statusCode).toBe(404);
    const retired = await envelope(firstKey);
    expect(retired?.wrappedDek ?? null).toBeNull();
    expect(retired?.shreddedAt).not.toBeNull();
    expect(retired?.sha256).toBe('erased');
    await expect(readFile(diskPath(firstKey))).rejects.toThrow();
    expect((await app.inject({ method: 'GET', url: linkPath(second.json().data.user.avatar) })).statusCode).toBe(200);
  });

  it('a link opens only the photo the account points at now: a moved pointer kills it, even before the old envelope is shredded', async () => {
    const u = await makeUser(['CUSTOMER']);
    const link = (await postFile('/api/v1/auth/selfie', u.token, uniquePng(`a ${nanoid(6)}`))).json().data.user.avatar as string;
    const { sealPhoto } = await import('../providers/storage/sealed-photo');
    const other = await sealPhoto(app.prisma, getStorageProvider(), { buffer: uniquePng(`b ${nanoid(6)}`), declaredMimeType: 'image/png', ownerId: u.userId, folder: 'avatars' });
    await system(() => app.prisma.user.update({ where: { id: u.userId }, data: { avatar: other } }));
    expect((await app.inject({ method: 'GET', url: linkPath(link) })).statusCode).toBe(404);
  });

  it("the reviewer's view beside an ID shows it through the same signed link", async () => {
    const u = await makeUser(['MOVER']);
    await postFile('/api/v1/auth/selfie', u.token, REAL_PNG);
    const user = await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: u.userId }, select: { id: true, avatar: true, selfieCapturedAt: true } }));
    const shown = await signupSelfieFor('national_id', user);
    expect(shown?.url).toMatch(SIGNED_LINK);
    expect((await app.inject({ method: 'GET', url: linkPath(shown!.url) })).statusCode).toBe(200);
  });
});

describe('[DOC-SECURITY G2] the shift liveness selfie is sealed at rest', () => {
  async function driver() {
    const u = await makeUser(['MOVER'], { selfieCapturedAt: new Date(), avatar: 'https://cdn.test/avatars/reference-face.jpg' });
    await system(() => app.prisma.driver.create({ data: {
      userId: u.userId, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `SEAL ${nanoid(4)}`, driverLicenseUrl: '', vehicleInsuranceUrl: '',
    } }));
    return u;
  }

  it('stores only ciphertext, with an envelope row for its owner, named by the check', async () => {
    const u = await driver();
    const res = await postFile('/api/v1/safety/liveness-check?profile=DRIVER', u.token, REAL_PNG);
    expect(res.statusCode, res.body).toBe(200);
    const check = await system(() => app.prisma.livenessCheck.findUniqueOrThrow({ where: { id: res.json().data.checkId } }));
    expect(check.selfieUrl).toMatch(new RegExp(`^/uploads/liveness/${u.userId}/[A-Za-z0-9_-]{16}\\.enc$`));
    const onDisk = await readFile(diskPath(check.selfieUrl));
    expect(onDisk.subarray(0, 4).equals(PNG_MAGIC)).toBe(false);
    expect(await envelope(check.selfieUrl)).toMatchObject({ createdBy: u.userId, mimeType: 'image/png', shreddedAt: null });
  });

  it("account erasure shreds the photo's key, forgets its fingerprint and deletes the bytes", async () => {
    const u = await driver();
    const res = await postFile('/api/v1/safety/liveness-check?profile=DRIVER', u.token, REAL_PNG);
    const key = (await system(() => app.prisma.livenessCheck.findUniqueOrThrow({ where: { id: res.json().data.checkId } }))).selfieUrl;
    await system(() => app.prisma.user.update({ where: { id: u.userId }, data: { phone: `deleted:${u.userId}`, status: 'DEACTIVATED' } }));
    const out = await eraseLivenessSelfies(app.prisma, getStorageProvider(), u.userId);
    expect(out).toMatchObject({ erased: 1, pending: 0 });
    const row = await envelope(key);
    expect(row?.wrappedDek ?? null).toBeNull();
    expect(row?.shreddedAt).not.toBeNull();
    expect(row?.sha256).toBe('erased');
    await expect(readFile(diskPath(key))).rejects.toThrow();
  });
});

describe('[DOC-SECURITY G2] a sealed photo is not a verification upload', () => {
  /** A sealed envelope row of `folder`, `ageDays` old, with a real file on disk. */
  async function sealedRow(userId: string, folder: 'avatars' | 'liveness', ageDays: number, sha256 = createHash('sha256').update(nanoid()).digest('hex')) {
    const { url } = await getStorageProvider().upload({ buffer: randomBytes(64), filename: 'photo.enc', mimeType: 'application/octet-stream', folder: `${folder}/${userId}` });
    await system(() => app.prisma.encryptedObject.create({ data: {
      fileKey: url, createdBy: userId, iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), wrappedDek: Buffer.alloc(60, 3),
      mimeType: 'image/jpeg', sizeBytes: 64, sha256, createdAt: new Date(Date.now() - ageDays * DAY),
    } }));
    return url;
  }

  it('the unclaimed-upload sweep leaves sealed photos to their owners: nothing pending, nothing touched', async () => {
    const u = await makeUser(['MOVER']);
    const keys = [await sealedRow(u.userId, 'avatars', 45), await sealedRow(u.userId, 'liveness', 45)];
    const out = await eraseStaleUnclaimedUploads(app.prisma, getStorageProvider(), u.userId, new Date(Date.now() - 30 * DAY));
    expect(out).toEqual({ pending: 0, held: 0, erased: 0 });
    for (const key of keys) expect((await envelope(key))?.shreddedAt, key).toBeNull();
    expect((await readdir(path.join(UPLOAD_DIR, 'avatars', u.userId))).length).toBe(1);
  });

  it('the duplicate-document signal never matches a sealed photo', async () => {
    const a = await makeUser(['MOVER']);
    const b = await makeUser(['MOVER']);
    const sha = createHash('sha256').update(`shared ${nanoid()}`).digest('hex');
    await sealedRow(a.userId, 'avatars', 1, sha);
    await sealedRow(a.userId, 'liveness', 1, sha);
    expect(await system(() => liveDuplicateHolders(app.prisma, sha, b.userId))).toEqual([]);
  });
});

describe('[DOC-SECURITY G2] the selfies stored before sealing are sealed by a one-off pass', () => {
  /** A plain selfie stored the way the routes stored one before (server-issued name in the person's folder). */
  async function plainBefore(folder: 'avatars' | 'liveness', userId: string, content: Buffer) {
    const { url } = await getStorageProvider().upload({ buffer: content, filename: 'swift-selfie.png', mimeType: 'image/png', folder: `${folder}/${userId}` });
    return url;
  }
  async function personWithPlainSelfies(held = false) {
    const u = await makeUser(['MOVER']);
    const avatar = await plainBefore('avatars', u.userId, uniquePng(`old avatar ${nanoid(6)}`));
    const shift = await plainBefore('liveness', u.userId, uniquePng(`old shift ${nanoid(6)}`));
    await system(async () => {
      await app.prisma.user.update({ where: { id: u.userId }, data: { avatar, selfieCapturedAt: new Date() } });
      await app.prisma.livenessCheck.create({ data: { userId: u.userId, profile: 'DRIVER', purpose: 'GO_ONLINE', selfieUrl: shift, outcome: 'BORDERLINE', reviewRequired: true } });
      if (held) await app.prisma.docLegalHold.create({ data: { subjectUserId: u.userId, reason: 'seal-existing test hold', ownerId: u.userId, placedBy: u.userId, reviewBy: new Date(Date.now() + 30 * DAY) } });
    });
    return { ...u, avatar, shift };
  }
  /** The pass, over this suite's people only (the shared test database holds other suites' rows). */
  const scopedPass = (dryRun: boolean) => sealExistingPhotos(app.prisma.$extends({ query: {
    user: { async findMany({ args, query }) { return query({ ...args, where: { AND: [args.where ?? {}, { id: { in: [...userIds] } }] } }); } },
    livenessCheck: { async findMany({ args, query }) { return query({ ...args, where: { AND: [args.where ?? {}, { userId: { in: [...userIds] } }] } }); } },
  } }) as unknown as typeof app.prisma, getStorageProvider(), { dryRun });

  it('a dry run counts them and changes nothing; the real run seals each, moves the pointer and deletes the plain copy; a second run finds nothing', async () => {
    const p = await personWithPlainSelfies();
    const dry = await scopedPass(true);
    expect(dry.avatars.candidates).toBeGreaterThanOrEqual(1);
    expect(dry.liveness.candidates).toBeGreaterThanOrEqual(1);
    expect((await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } }))).avatar).toBe(p.avatar);
    await readFile(diskPath(p.avatar));

    const run = await scopedPass(false);
    expect(run.avatars.sealed).toBeGreaterThanOrEqual(1);
    expect(run.liveness.sealed).toBeGreaterThanOrEqual(1);
    const avatar = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } }))).avatar!;
    expect(avatar).toMatch(new RegExp(`^/uploads/avatars/${p.userId}/[A-Za-z0-9_-]{16}\\.enc$`));
    expect((await readFile(diskPath(avatar))).subarray(0, 4).equals(PNG_MAGIC)).toBe(false);
    await expect(readFile(diskPath(p.avatar))).rejects.toThrow();
    const { resolveAvatarUrl } = await import('../utils/avatar-url');
    const link = (await resolveAvatarUrl(avatar))!;
    const img = await app.inject({ method: 'GET', url: linkPath(link) });
    expect(img.statusCode).toBe(200);
    expect(img.rawPayload.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    const check = await system(() => app.prisma.livenessCheck.findFirstOrThrow({ where: { userId: p.userId } }));
    expect(check.selfieUrl).toMatch(new RegExp(`^/uploads/liveness/${p.userId}/[A-Za-z0-9_-]{16}\\.enc$`));
    expect(await envelope(check.selfieUrl)).toMatchObject({ createdBy: p.userId, shreddedAt: null });
    await expect(readFile(diskPath(p.shift))).rejects.toThrow();

    const again = await scopedPass(false);
    expect(again.avatars.candidates + again.liveness.candidates).toBe(0);
  });

  it('a person under a legal hold is left exactly as they are', async () => {
    const p = await personWithPlainSelfies(true);
    const run = await scopedPass(false);
    expect(run.avatars.held + run.liveness.held).toBeGreaterThanOrEqual(2);
    expect((await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } }))).avatar).toBe(p.avatar);
    expect((await system(() => app.prisma.livenessCheck.findFirstOrThrow({ where: { userId: p.userId } }))).selfieUrl).toBe(p.shift);
    await readFile(diskPath(p.avatar));
    await readFile(diskPath(p.shift));
    await system(() => app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: p.userId } }));
  });
});
