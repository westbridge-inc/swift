import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { authRoutes } from '../modules/auth/auth.routes';

const storage = vi.hoisted(() => ({
  upload: vi.fn(), getObject: vi.fn(), delete: vi.fn(), getSignedUrl: vi.fn(),
}));
vi.mock('../providers/storage/storage-provider', async (original) => ({
  ...await original<object>(), getStorageProvider: () => storage,
}));

process.env['DATABASE_URL'] = process.env['DATABASE_URL']
  || 'postgresql://swift:swift@localhost:5434/swift_test2';
process.env['STORAGE_PROVIDER'] = 'local';

const prisma = new PrismaClient();
const marker = nanoid(8).toLowerCase();
const userId = `avatar-race-${marker}`;
const avatar = (label: string) => `/uploads/avatars/${userId}/${label.repeat(16)}.jpg`;
const initial = avatar('a');
const nextB = avatar('b');
const nextC = avatar('c');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const routes = new Map<string, (...args: any[]) => any>();
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const app: any = {
  prisma, log, io: {}, redis: {}, prefix: '', authenticate: vi.fn(), addHook: vi.fn(),
};
for (const verb of ['get', 'post', 'put', 'patch', 'delete']) {
  app[verb] = (path: string, ...args: any[]) => { routes.set(`${verb} ${path}`, args.at(-1)); };
}

beforeAll(async () => {
  await prisma.user.create({ data: {
    id: userId, phone: `avatar-race-${marker}`, firstName: 'Avatar', lastName: 'Race',
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: 'swift-default',
    avatar: initial, selfieCapturedAt: new Date(),
  } });
  await authRoutes(app);
});

afterAll(async () => {
  await prisma.storageOrphan.deleteMany({ where: { key: { contains: marker } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('avatar orphan transaction barriers', () => {
  it('serializes two selfie replacements and retains no uncensused intermediate object', async () => {
    const present = new Set([initial]);
    let uploadIndex = 0;
    storage.upload.mockImplementation(async () => {
      const key = [nextB, nextC][uploadIndex++]!;
      present.add(key);
      return { url: key };
    });
    storage.delete.mockImplementation(async (key: string) => { present.delete(key); });
    storage.getObject.mockImplementation(async (key: string) => {
      if (!present.has(key)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return Buffer.from('present');
    });
    const request = () => ({
      user: { userId },
      file: async () => ({ mimetype: 'image/png', filename: 'selfie.png', toBuffer: async () => png }),
    });
    const reply = () => ({ send: vi.fn((value) => value) });
    const handler = routes.get('post /selfie')!;
    await Promise.all([handler(request(), reply()), handler(request(), reply())]);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { avatar: true } });
    expect([nextB, nextC]).toContain(user.avatar);
    const superseded = [initial, nextB, nextC].filter((key) => key !== user.avatar);
    const rows = await prisma.storageOrphan.findMany({ where: { key: { in: superseded } } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.userId === userId && row.purgedAt instanceof Date)).toBe(true);
    expect([...present]).toEqual([user.avatar]);
  });
});
