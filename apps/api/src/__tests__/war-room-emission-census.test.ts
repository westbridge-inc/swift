import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { nanoid } from 'nanoid';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { runWithoutTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { OPS_WAR_ROOM, warRoomsFor } from '../modules/safety/war-room';

// ---------------------------------------------------------------------------
// [M077] Every war-room emission is tenant-aware: it either goes to the
// subject tenant's room AND the platform room (warRoomsFor), or it is
// DECLARED platform-only (the SUPER_ADMIN room). The census below lists every
// emission in the API by file, event and audience; a new emission fails it
// until someone decides its audience here. And at runtime a tenant ADMIN's
// socket receives nothing platform-only, and nothing from another tenant.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

type Audience = 'tenant+platform' | 'platform-only';
const CENSUS: Record<string, Array<[event: string, audience: Audience]>> = {
  'modules/mover-revocation-outbox.ts': [['incident:new', 'platform-only']],
  'modules/safety/guardian.service.ts': [
    ['guardian:high-risk', 'platform-only'], ['guardian:completion-flag', 'platform-only'], ['guardian:flag', 'platform-only'],
    ['guardian:checkin-sent', 'platform-only'], ['guardian:checkin-sent', 'platform-only'], ['guardian:driver-confirmed', 'platform-only'],
    ['guardian:driver-confirm-refused', 'platform-only'], ['guardian:driver-confirmed', 'platform-only'],
  ],
  'modules/safety/incident.service.ts': [
    ['incident:pattern', 'platform-only'], ['incident:new', 'platform-only'], ['incident:merged', 'platform-only'], ['incident:pattern', 'platform-only'],
  ],
  'modules/safety/liveness.service.ts': [['safety:not-my-driver', 'platform-only']],
  'modules/safety/sos.service.ts': [['sos:retrigger', 'tenant+platform']],
  'modules/safety/sos-escalation.ts': [['sos:active', 'tenant+platform']],
};

function emissionsIn(file: string): Array<[string, Audience]> {
  const src = strip(readFileSync(join(SRC, file), 'utf8'));
  const found: Array<{ at: number; event: string; audience: Audience }> = [];
  for (const m of src.matchAll(/\.to\('ops:war-room'\)\s*\.emit\(\s*'([^']+)'/g)) found.push({ at: m.index!, event: m[1]!, audience: 'platform-only' });
  for (const m of src.matchAll(/\.to\(OPS_WAR_ROOM\)\s*\.emit\(\s*'([^']+)'/g)) found.push({ at: m.index!, event: m[1]!, audience: 'platform-only' });
  for (const m of src.matchAll(/\.to\(warRoomsFor\([^)]*\)\)\s*\.emit\(\s*'([^']+)'/g)) found.push({ at: m.index!, event: m[1]!, audience: 'tenant+platform' });
  // a rooms variable is tenant-aware only when it was built by warRoomsFor in the same file
  if (/const rooms = warRoomsFor\(/.test(src)) for (const m of src.matchAll(/\.to\(rooms\)\s*\.emit\(\s*'([^']+)'/g)) found.push({ at: m.index!, event: m[1]!, audience: 'tenant+platform' });
  // the guardian's private helper emits to the platform room only
  if (/private warRoom\(event: string, payload: Record<string, unknown>\) \{\s*try \{\s*this\.io\.to\('ops:war-room'\)\.emit\(event, payload\);/.test(src)) {
    for (const m of src.matchAll(/this\.warRoom\(\s*'([^']+)'/g)) found.push({ at: m.index!, event: m[1]!, audience: 'platform-only' });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => [f.event, f.audience]);
}

describe('[M077] census: every war-room emission has a declared audience', () => {
  const files = (readdirSync(SRC, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts') && !f.includes('__tests__') && !f.endsWith('.test.ts'))
    .map((f) => relative(SRC, join(SRC, f)));

  it('the files that emit into the war room are exactly the census', () => {
    const emitting = files.filter((f) => f !== 'modules/safety/war-room.ts' && /ops:war-room|OPS_WAR_ROOM|warRoomsFor\(/.test(strip(readFileSync(join(SRC, f), 'utf8'))));
    // socket.ts JOINS (warRoomsForSocket) and never emits
    expect(emitting.filter((f) => f !== 'plugins/socket.ts').sort()).toEqual(Object.keys(CENSUS).sort());
  });

  it.each(Object.keys(CENSUS))('%s: each emission and its audience, in order', (file) => {
    expect(emissionsIn(file)).toEqual(CENSUS[file]);
  });

  it('no emission reaches the war room any other way (a bare template, a hand-built array)', () => {
    for (const file of Object.keys(CENSUS)) {
      const src = strip(readFileSync(join(SRC, file), 'utf8'));
      const targets = [...src.matchAll(/\.to\(((?:[^()]|\([^()]*\))*)\)\s*\.emit/g)].map((m) => m[1]!.trim())
        .filter((t) => /war-room|WAR_ROOM|warRoomsFor|^rooms$/.test(t));
      for (const t of targets) expect(t, `${file}: ${t}`).toMatch(/^(?:'ops:war-room'|OPS_WAR_ROOM|rooms|warRoomsFor\([^()]*\))$/);
      expect(src).not.toMatch(/`ops:war-room/);
    }
  });
});

describe('[M077] at runtime a tenant ADMIN socket hears its own tenant and nothing platform-only', () => {
  let app: FastifyInstance;
  let url: string;
  const sockets: Socket[] = [];
  const userIds: string[] = [];
  const RUN = nanoid(6).toLowerCase();
  const phoneBase = 592_750_000_000 + Math.floor(Math.random() * 100_000_000);
  let seq = 0;

  async function token(roles: UserRole[]) {
    seq += 1;
    const user = await runWithoutTenant(() => app.prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'War', lastName: `Room${RUN}${seq}`, roles, activeRole: roles[0]!, status: 'ACTIVE', isPhoneVerified: true } }), 'test-fixture:l10-war-room');
    userIds.push(user.id);
    const t = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
    await runWithoutTenant(() => app.prisma.session.create({ data: { userId: user.id, token: t, refreshToken: nanoid(48), deviceId: 'war', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + 86_400_000) } }), 'test-fixture:l10-war-room');
    return { t, tenantId: user.tenantId };
  }

  function connect(t: string): Promise<{ socket: Socket; heard: string[] }> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(url, { auth: { token: t }, transports: ['websocket'], reconnection: false, timeout: 3000 });
      sockets.push(socket);
      const heard: string[] = [];
      socket.onAny((event: string) => heard.push(event));
      const timer = setTimeout(() => reject(new Error('socket did not become ready')), 7_500);
      socket.on('auth:ready', () => { clearTimeout(timer); resolve({ socket, heard }); });
      socket.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'development';
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
    for (const s of sockets) s.disconnect();
    await runWithoutTenant(async () => {
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }, 'test-cleanup:l10-war-room');
    await app.close();
  });

  it('platform-only and other-tenant emissions never reach a tenant ADMIN; the SUPER_ADMIN hears all of them', async () => {
    const admin = await token(['ADMIN']);
    const superAdmin = await token(['SUPER_ADMIN']);
    const a = await connect(admin.t);
    const s = await connect(superAdmin.t);
    const platformOnly = [...new Set(Object.values(CENSUS).flat().filter(([, aud]) => aud === 'platform-only').map(([e]) => e))];
    for (const event of platformOnly) app.io.to(OPS_WAR_ROOM).emit(event, { probe: RUN });
    app.io.to(warRoomsFor('some-other-tenant')).emit('sos:active', { probe: `${RUN}-other` });
    app.io.to(warRoomsFor(admin.tenantId)).emit('sos:retrigger', { probe: `${RUN}-mine` });
    await new Promise((r) => setTimeout(r, 300));
    const warRoomEvents = new Set([...platformOnly, 'sos:active', 'sos:retrigger']);
    const heardBy = (x: { heard: string[] }) => x.heard.filter((e) => warRoomEvents.has(e));
    expect(heardBy(a)).toEqual(['sos:retrigger']);
    expect(new Set(heardBy(s))).toEqual(warRoomEvents);
  });
});
