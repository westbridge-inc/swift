/**
 * [#1449 S4-1 follow-up · GUARDRAILS §2] A retry of POST /verification/upload after a lost reply
 * keeps no second copy of the same ID document. The same person's identical file, stored in the
 * last minutes and not yet claimed, is the same upload: same key back, nothing new stored.
 * A deliberate re-submission (the first copy already claimed), a stale copy, an erased copy or
 * another person's copy is never reused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { UPLOAD_RETRY_WINDOW_MS, verificationRoutes } from '../modules/verification/verification.routes';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { uniquePng } from './helpers/real-image';

let app: FastifyInstance;
const marker = nanoid(6).toLowerCase();
const people: Array<{ id: string; token: string }> = [];

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['MASTER_KEK'] = crypto.randomBytes(32).toString('base64');
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
});

afterAll(async () => {
  delete process.env['MASTER_KEK'];
  resetKeyProviderForTests();
  const ids = people.map((p) => p.id);
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: ids } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  await app.close();
});

async function person() {
  const user = await app.prisma.user.create({ data: {
    phone: `+59268${String(Math.floor(Math.random() * 90000) + 10000)}`, firstName: 'Retry', lastName: 'Upload',
    roles: ['MOVER'] as never[], activeRole: 'MOVER' as never, isPhoneVerified: true,
  } });
  const token = app.jwt.sign({ userId: user.id, role: 'MOVER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'retry-test', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  people.push({ id: user.id, token });
  return { id: user.id, token };
}

function upload(token: string, bytes: Buffer) {
  const boundary = `----swift${marker}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="id.png"\r\ncontent-type: image/png\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({ method: 'POST', url: '/api/v1/verification/upload', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
}
const keyOf = async (token: string, bytes: Buffer) => {
  const res = await upload(token, bytes);
  expect(res.statusCode).toBe(200);
  return res.json().data.url as string;
};
const copies = (userId: string) => app.prisma.encryptedObject.count({ where: { createdBy: userId } });

describe('a lost-reply retry of the upload', () => {
  it('answers with the same upload and stores no second copy', async () => {
    const p = await person();
    const id = uniquePng(`retry-${marker}-1`);
    const first = await keyOf(p.token, id);
    const again = await keyOf(p.token, id);
    expect(again).toBe(first);
    expect(await copies(p.id)).toBe(1);
  });

  it('a deliberate re-submission after the first copy became a document gets its own upload', async () => {
    const p = await person();
    const id = uniquePng(`retry-${marker}-2`);
    const first = await keyOf(p.token, id);
    await app.prisma.verificationDocument.create({ data: { userId: p.id, role: 'MOVER', docType: 'national_id', fileUrl: first, status: 'PENDING' } });
    const second = await keyOf(p.token, id);
    expect(second).not.toBe(first);
    expect(await copies(p.id)).toBe(2);
  });

  it('a copy older than the retry window, or already erased, is never reused', async () => {
    const p = await person();
    const id = uniquePng(`retry-${marker}-3`);
    const stale = await keyOf(p.token, id);
    await app.prisma.encryptedObject.update({ where: { fileKey: stale }, data: { createdAt: new Date(Date.now() - UPLOAD_RETRY_WINDOW_MS - 1_000) } });
    const fresh = await keyOf(p.token, id);
    expect(fresh).not.toBe(stale);
    await app.prisma.encryptedObject.update({ where: { fileKey: fresh }, data: { wrappedDek: null, shreddedAt: new Date() } });
    const third = await keyOf(p.token, id);
    expect([stale, fresh]).not.toContain(third);
  });

  it('another person sending the same file gets their own upload', async () => {
    const a = await person();
    const b = await person();
    const id = uniquePng(`retry-${marker}-4`);
    const mine = await keyOf(a.token, id);
    const theirs = await keyOf(b.token, id);
    expect(theirs).not.toBe(mine);
    expect(theirs).toContain(b.id);
  });
});
