import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { nanoid } from 'nanoid';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { emitToStoreRoom } from '../modules/order/order-room-emission.service';
import { resetBrowserOriginsForTests } from '../modules/auth/browser-session';

// ---------------------------------------------------------------------------
// [PERF row 8] The website's partner dashboard hears its store the way the
// business app does: through the SAME store socket (vendor:subscribe, the
// audience-at-publish room, the session rooms, the recheck, the expiry timer).
// The website holds no token (W-01), so its socket presents the access cookie,
// and only behind the socket cookie gate:
//  - the handshake names the website (auth.client 'web') and reads the
//    website's pair only (never the console's __Host- pair);
//  - its Origin is on the CORS allowlist, exactly; no Origin = refused, and a
//    Referer never stands in for one;
//  - the browser reaches the socket at /api/v1/socket.io/ (the cookie's Path),
//    WebSocket upgrades only; /socket.io/ and a phone's token are unchanged;
//  - a revoked or expired session is dropped by the same recheck as a phone's.
// The last case records the frames the server really sends and holds the
// website's parser fixture (apps/web/src/lib/store-live-feed.frames.json) to them.
//
// Fixture range: +5920486nnn (this file only).
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+5920486';
const WEBSITE = 'http://localhost:3001';
const FOREIGN = 'https://evil.example';
const BROWSER_PATH = '/api/v1/socket.io/';
const FRAMES_FIXTURE = join(__dirname, '../../../web/src/lib/store-live-feed.frames.json');

let app: FastifyInstance;
let url: string;
let port: number;
const sockets: Socket[] = [];
let seq = 0;

type Actor = { userId: string; sessionId: string; token: string };
let owner: Actor;
let vendorId: string;

async function makeActor(opts: { sessionTtlMs?: number } = {}): Promise<Actor> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Web', lastName: `Feed${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), deviceId: `web-feed-${seq}`, deviceType: 'test',
      expiresAt: new Date(Date.now() + (opts.sessionTtlMs ?? 86_400_000)),
    },
  });
  return { userId: user.id, sessionId: session.id, token };
}

async function makeStore(storeOwner: Actor): Promise<string> {
  const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: storeOwner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name: 'Web Feed Kitchen', slug: `web-feed-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}999`,
      addressLine1: '8 Feed Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.81, longitude: -58.16,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  return vendor.id;
}

async function purgeFixtures() {
  await runWithoutTenant(async () => {
    const ids = (await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } })).map((u) => u.id);
    if (ids.length === 0) return;
    const ownerIds = (await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((o) => o.id);
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: ownerIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.moverRevocationOutbox.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }, 'test-fixture:web-feed');
}

/** One Socket.IO client. `path` defaults to the website's door. Resolves at
 *  auth:ready (admitted) or at connect_error (refused). */
function connect(options: {
  path?: string; auth?: Record<string, unknown>; headers?: Record<string, string>;
}): Promise<{ socket: Socket; error?: Error }> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      path: options.path ?? BROWSER_PATH,
      auth: options.auth ?? {},
      extraHeaders: options.headers ?? {},
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000,
    });
    sockets.push(socket);
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error('socket never settled')); }, 7_500);
    socket.once('auth:ready', () => { clearTimeout(timer); resolve({ socket }); });
    socket.once('connect_error', (error) => { clearTimeout(timer); resolve({ socket, error }); });
  });
}

const website = (actor: Actor, extra: Record<string, string> = {}) => ({
  auth: { client: 'web' },
  headers: { origin: WEBSITE, cookie: `swift_at=${encodeURIComponent(actor.token)}`, ...extra },
});

function waitForDisconnect(socket: Socket, timeoutMs: number): Promise<boolean> {
  if (!socket.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    socket.once('disconnect', () => { clearTimeout(timer); resolve(true); });
  });
}

// ── A raw WebSocket client: the exact text frames, as a browser receives them ──
type RawSocket = { frames: string[]; send: (text: string) => void; next: (timeoutMs?: number) => Promise<string>; end: () => void };

function rawWebSocket(path: string, headers: Record<string, string>): Promise<RawSocket> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...headers,
      },
    });
    req.on('response', (res) => reject(new Error(`no upgrade: HTTP ${res.statusCode}`)));
    req.on('error', reject);
    req.on('upgrade', (_res, wire, head) => {
      let buffer: Buffer = Buffer.alloc(0);
      const frames: string[] = [];
      let read = 0;
      const waiters: Array<() => void> = [];
      const wake = () => { for (const w of waiters.splice(0)) w(); };
      const parse = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (buffer.length < 2) break;
          const opcode = buffer[0]! & 0x0f;
          let length = buffer[1]! & 0x7f;
          let offset = 2;
          if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); offset = 4; }
          else if (length === 127) { if (buffer.length < 10) break; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
          if (buffer.length < offset + length) break;
          const payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (opcode === 1) frames.push(payload.toString('utf8'));
          else if (opcode === 8) frames.push('<close>');
        }
        wake();
      };
      // The first frame can arrive in the same packet as the 101 response.
      parse(head);
      wire.on('data', parse);
      wire.on('close', () => { frames.push('<close>'); wake(); });
      resolve({
        frames,
        send(text: string) {
          const payload = Buffer.from(text, 'utf8');
          if (payload.length >= 126) throw new Error('test frames stay short');
          const mask = randomBytes(4);
          const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
          wire.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
        },
        next(timeoutMs = 4_000) {
          return new Promise((done, fail) => {
            const take = () => {
              if (read < frames.length) { done(frames[read++]!); return true; }
              return false;
            };
            if (take()) return;
            const timer = setTimeout(() => fail(new Error(`no frame within ${timeoutMs} ms (have ${JSON.stringify(frames)})`)), timeoutMs);
            const retry = () => { if (take()) clearTimeout(timer); else waiters.push(retry); };
            waiters.push(retry);
          });
        },
        end() { wire.destroy(); },
      });
    });
    req.end();
  });
}

/** Variable parts of a frame (connection ids, times) become placeholders. */
const normalized = (frame: string) => frame
  .replace(/"sid":"[^"]+"/g, '"sid":"<sid>"')
  .replace(/"expiresAt":"[^"]+"/g, '"expiresAt":"<iso>"');

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  delete process.env['CORS_ORIGIN'];
  resetBrowserOriginsForTests();
  process.env['SOCKET_AUTH_RECHECK_MS'] = '100';
  process.env['SOCKET_AUTH_RECHECK_TIMEOUT_MS'] = '1000';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  await purgeFixtures();
  owner = await makeActor();
  vendorId = await makeStore(owner);
});

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await purgeFixtures();
  await app.close();
  resetBrowserOriginsForTests();
});

describe('[PERF row 8] the website opens the store socket with its access cookie', () => {
  it('admits a website handshake (client web + its access cookie + an allowlisted Origin) at /api/v1/socket.io/, and its store room reaches it', async () => {
    const { socket, error } = await connect(website(owner));
    expect(error).toBeUndefined();
    expect(socket.connected).toBe(true);
    // The rooms derive from the verified session, exactly as a phone's.
    expect(app.io.sockets.adapter.rooms.get(`user:${owner.userId}`)?.has(socket.id ?? '')).toBe(true);
    expect(app.io.sockets.adapter.rooms.get(`session:${owner.sessionId}`)?.has(socket.id ?? '')).toBe(true);

    const heard = new Promise<{ orderId?: string }>((resolve) => socket.once('order:new', resolve));
    socket.emit('vendor:subscribe', { vendorId });
    for (let i = 0; i < 50 && !app.io.sockets.adapter.rooms.get(`vendor:${vendorId}`)?.has(socket.id ?? ''); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const sentAt = performance.now();
    expect(await emitToStoreRoom(app.prisma, app.io, vendorId, 'order:new', { orderId: 'ord-web-feed', vendorId, orderNumber: 'SW-WEB-1' })).toBe(true);
    expect((await heard).orderId).toBe('ord-web-feed');
    // Measured for the PR: publish to the browser socket, same machine.
    // eslint-disable-next-line no-console
    console.info(`[PERF row 8] store-room publish -> website socket: ${(performance.now() - sentAt).toFixed(1)} ms`);
  });

  it('refuses a valid cookie from a foreign Origin', async () => {
    const { error } = await connect(website(owner, { origin: FOREIGN }));
    expect(error?.message).toBe('Authentication required');
  });

  it('refuses a valid cookie with no Origin, and never reads the Referer instead', async () => {
    const noOrigin = { auth: { client: 'web' }, headers: { cookie: `swift_at=${encodeURIComponent(owner.token)}` } };
    expect((await connect(noOrigin)).error?.message).toBe('Authentication required');
    const refererOnly = { auth: { client: 'web' }, headers: { cookie: `swift_at=${encodeURIComponent(owner.token)}`, referer: `${WEBSITE}/dashboard/orders` } };
    expect((await connect(refererOnly)).error?.message).toBe('Authentication required');
  });

  it('a cookie is not a credential unless the handshake names the website', async () => {
    const unnamed = { auth: {}, headers: { origin: WEBSITE, cookie: `swift_at=${encodeURIComponent(owner.token)}` } };
    expect((await connect(unnamed)).error?.message).toBe('Authentication required');
    const adminClient = { auth: { client: 'admin-web' }, headers: { origin: WEBSITE, cookie: `swift_at=${encodeURIComponent(owner.token)}` } };
    expect((await connect(adminClient)).error?.message).toBe('Authentication required');
  });

  it("reads the website's pair only: the console's __Host- cookie is never the website's credential", async () => {
    const hostPair = { auth: { client: 'web' }, headers: { origin: WEBSITE, cookie: `__Host-swift_at=${encodeURIComponent(owner.token)}` } };
    expect((await connect(hostPair)).error?.message).toBe('Authentication required');
  });

  it('verifies the cookie like a token: a tampered one is a credential verdict', async () => {
    const tampered = { auth: { client: 'web' }, headers: { origin: WEBSITE, cookie: `swift_at=${owner.token.slice(0, -4)}AAAA` } };
    expect((await connect(tampered)).error?.message).toBe('Invalid or expired token');
  });

  it("a phone's token handshake is unchanged: /socket.io/, no Origin or any Origin, and the token wins over a cookie", async () => {
    const phone = await makeActor();
    const plain = await connect({ path: '/socket.io/', auth: { token: phone.token } });
    expect(plain.error).toBeUndefined();
    const foreign = await connect({ path: '/socket.io/', auth: { token: phone.token }, headers: { origin: FOREIGN } });
    expect(foreign.error).toBeUndefined();
    const both = await connect({ path: '/socket.io/', auth: { token: phone.token, client: 'web' }, headers: { origin: WEBSITE, cookie: `swift_at=${encodeURIComponent(owner.token)}` } });
    expect(both.error).toBeUndefined();
    expect(app.io.sockets.adapter.rooms.get(`user:${phone.userId}`)?.has(both.socket.id ?? '')).toBe(true);
    expect(app.io.sockets.adapter.rooms.get(`user:${owner.userId}`)?.has(both.socket.id ?? '') ?? false).toBe(false);
  });

  it('the alias serves WebSocket upgrades only: a plain request under /api/v1/socket.io/ is not the socket', async () => {
    const res = await fetch(`${url}${BROWSER_PATH}?EIO=4&transport=polling`, { headers: { origin: WEBSITE, cookie: `swift_at=${encodeURIComponent(owner.token)}` } });
    expect(res.status).toBe(404);
    // The engine itself still answers at its own path, as before.
    const engine = await fetch(`${url}/socket.io/?EIO=4&transport=polling`);
    expect(engine.status).toBe(200);
  });

  it('a revoked cookie session is dropped by the same recheck as a phone', async () => {
    const actor = await makeActor();
    const { socket, error } = await connect(website(actor));
    expect(error).toBeUndefined();
    const dropped = waitForDisconnect(socket, 2_000);
    await app.prisma.session.delete({ where: { id: actor.sessionId } });
    expect(await dropped).toBe(true);
  });

  it('an expired cookie session is dropped', async () => {
    const actor = await makeActor({ sessionTtlMs: 2_500 });
    const { socket, error } = await connect(website(actor));
    expect(error).toBeUndefined();
    expect(await waitForDisconnect(socket, 5_000)).toBe(true);
  });

  it("the website's parser fixture is the frames this server sends", async () => {
    const recorded: Record<string, string> = {};
    const headers = { origin: WEBSITE, cookie: `swift_at=${encodeURIComponent(owner.token)}` };

    const ws = await rawWebSocket(`${BROWSER_PATH}?EIO=4&transport=websocket`, headers);
    recorded['open'] = await ws.next();
    ws.send('40{"client":"web"}');
    recorded['connected'] = await ws.next();
    recorded['authReady'] = await ws.next();
    ws.send(`42["vendor:subscribe",{"vendorId":"${vendorId}"}]`);
    const sid = (JSON.parse(recorded['connected'].slice(2)) as { sid: string }).sid;
    for (let i = 0; i < 50 && !app.io.sockets.adapter.rooms.get(`vendor:${vendorId}`)?.has(sid); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await emitToStoreRoom(app.prisma, app.io, vendorId, 'order:new', { orderId: 'ord-fixture', vendorId: 'store-fixture', orderNumber: 'SW-FIXTURE' });
    recorded['orderNew'] = await ws.next();
    await emitToStoreRoom(app.prisma, app.io, vendorId, 'order:status_changed', { orderId: 'ord-fixture', status: 'ACCEPTED', timestamp: '2026-10-19T05:00:00.000Z' });
    recorded['statusChanged'] = await ws.next();
    ws.end();

    // The engine's heartbeat: the same server with a short interval, so the
    // ping arrives within the test (the frame itself does not depend on it).
    const engineOpts = (app.io.engine as unknown as { opts: { pingInterval: number } }).opts;
    const pingInterval = engineOpts.pingInterval;
    engineOpts.pingInterval = 150;
    try {
      const beat = await rawWebSocket(`${BROWSER_PATH}?EIO=4&transport=websocket`, headers);
      await beat.next();
      recorded['ping'] = await beat.next();
      beat.end();
    } finally {
      engineOpts.pingInterval = pingInterval;
    }

    const refused = await rawWebSocket(`${BROWSER_PATH}?EIO=4&transport=websocket`, { ...headers, origin: FOREIGN });
    await refused.next();
    refused.send('40{"client":"web"}');
    recorded['connectError'] = await refused.next();
    refused.end();

    const revoked = await makeActor();
    const doomed = await rawWebSocket(`${BROWSER_PATH}?EIO=4&transport=websocket`, { origin: WEBSITE, cookie: `swift_at=${encodeURIComponent(revoked.token)}` });
    await doomed.next();
    doomed.send('40{"client":"web"}');
    await doomed.next();
    await doomed.next();
    await app.prisma.session.delete({ where: { id: revoked.sessionId } });
    recorded['serverDisconnect'] = await doomed.next(3_000);
    doomed.end();

    const actual = Object.fromEntries(Object.entries(recorded).map(([k, v]) => [k, normalized(v)]));
    const fixture = JSON.parse(readFileSync(FRAMES_FIXTURE, 'utf8')) as { frames: Record<string, string> };
    expect(actual).toEqual(fixture.frames);
  });
});
