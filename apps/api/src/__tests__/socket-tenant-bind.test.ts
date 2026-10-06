import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { tenantBindCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [L04 · R5 socket] A socket event handler runs outside any HTTP request, so it
// had no tenant bound even though the socket's tenant is known from its
// authenticated session. Under TENANT_UNSCOPED_ACCESS=deny every subscribe
// lookup was refused and the subscription silently failed. Each handler that
// reads the database now runs inside the socket's own tenant.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let url: string;
const sockets: Socket[] = [];
const userIds: string[] = [];
const vendorIds: string[] = [];
const PHONE_PREFIX = '+5920434';
let priorPolicy: string | undefined;

async function owner() {
  const user = await app.prisma.user.create({
    data: { phone: `${PHONE_PREFIX}${String(userIds.length + 1).padStart(3, '0')}`, firstName: 'Sock', lastName: 'Owner', roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Socket Shop', slug: `socket-shop-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}900`, addressLine1: '1 Socket Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE',
    },
  });
  vendorIds.push(vendor.id);
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'sock-tenant', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { token, vendorId: vendor.id };
}

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 3000 });
    sockets.push(socket);
    const timer = setTimeout(() => reject(new Error('socket never became ready')), 7_500);
    socket.once('auth:ready', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  priorPolicy = process.env['TENANT_UNSCOPED_ACCESS'];
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (priorPolicy === undefined) delete process.env['TENANT_UNSCOPED_ACCESS']; else process.env['TENANT_UNSCOPED_ACCESS'] = priorPolicy;
  for (const s of sockets) s.disconnect();
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[R5 socket] subscribe handlers read inside the socket’s tenant', () => {
  it('under deny, an owner subscribing to their own store’s feed joins it', async () => {
    const { token, vendorId } = await owner();
    const socket = await connect(token);
    process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
    try {
      socket.emit('vendor:subscribe', { vendorId });
      await expect.poll(async () => (await app.io.in(`vendor:${vendorId}`).fetchSockets()).length, { timeout: 3000 }).toBe(1);
    } finally {
      delete process.env['TENANT_UNSCOPED_ACCESS'];
    }
  });

  it('with the database binding on, the handler’s read is bound to the socket’s tenant and the owner still joins', async () => {
    const { token, vendorId } = await owner();
    const socket = await connect(token);
    const priorBind = process.env['TENANT_RLS_BIND'];
    const bound = async () => (await tenantBindCounter.get()).values.find((v) => v.labels['kind'] === 'tenant')?.value ?? 0;
    process.env['TENANT_RLS_BIND'] = '1';
    process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
    try {
      const before = await bound();
      socket.emit('vendor:subscribe', { vendorId });
      await expect.poll(async () => (await app.io.in(`vendor:${vendorId}`).fetchSockets()).length, { timeout: 3000 }).toBe(1);
      expect(await bound()).toBeGreaterThan(before);
    } finally {
      delete process.env['TENANT_UNSCOPED_ACCESS'];
      if (priorBind === undefined) delete process.env['TENANT_RLS_BIND']; else process.env['TENANT_RLS_BIND'] = priorBind;
    }
  });

  it('every database-reading handler is wrapped in the socket’s tenant (source census)', () => {
    const src = readFileSync(join(__dirname, '../plugins/socket.ts'), 'utf8');
    // Every database access in a handler — not just one of them, and not a
    // mention in a comment — must be the argument of inSocketTenant(() => …).
    const count = (text: string, needle: string) => text.split(needle).length - 1;
    for (const event of ['order:subscribe', 'chat:join', 'vendor:subscribe']) {
      const at = src.indexOf(`socket.on('${event}'`);
      expect(at, event).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf('socket.on(', at + 10))
        .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
      const reads = count(body, 'app.prisma.') + count(body, 'assertRoomAccess(');
      const wrapped = count(body, 'inSocketTenant(() => app.prisma.') + count(body, 'inSocketTenant(() => assertRoomAccess(');
      expect(reads, `${event} reads the database`).toBeGreaterThan(0);
      expect(wrapped, `${event}: every database read runs inside the socket's tenant`).toBe(reads);
    }
  });
});
