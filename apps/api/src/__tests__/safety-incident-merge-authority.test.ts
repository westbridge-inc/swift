import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [AUD-MAIN-004 / INV-15] `POST /incidents/:id/merge` was the ONE case action
// with no ops check.
//
// Its six siblings (ack, investigate, close, escalate-police, lift-interim,
// shadow-restrict) all run through `opsCaseAction`, which refuses a non-ops
// caller; `decide` checks `isOps` inline. Merge took a bare `auth` handler and
// passed `request.user.userId` to `mergeDuplicate` as the acting analyst — a
// caller-supplied identity the service trusted and stamped into closedBy /
// decidedBy.
//
// Merging is not cosmetic: it closes the duplicate as DISMISSED and calls
// liftInterim, which clears `safetySuspendedAt` on the subject's driver AND
// rider rows. The subject is handed their own case id in the interim-suspension
// notification, so the one principal with a motive also has the inputs.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_730_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Merge', lastName: `U${seq}`,
      roles, activeRole: roles[0]!, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'mg', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { userId: user.id, token };
}

async function makeCase(subjectUserId: string) {
  return app.prisma.incidentCase.create({
    data: {
      caseNumber: `INC-${nanoid(8).toUpperCase()}`,
      severity: 'S2', category: 'SAFETY_ASSAULT', intake: 'IN_TRIP_REPORT',
      subjectUserId, summary: 'merge authority fixture',
      slaAckBy: new Date(Date.now() + 3_600_000),
      slaDecideBy: new Date(Date.now() + 86_400_000),
    },
  });
}

const post = (url: string, payload: unknown, token?: string) =>
  app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.io = io;
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
}, 120000);

afterAll(async () => {
  await app.prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: userIds } } }).catch(() => {});
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await app.close();
});

describe('[AUD-MAIN-004] only ops may merge a safety case', () => {
  it('a CUSTOMER is refused, and the duplicate stays OPEN', async () => {
    const subject = await makeUser(['MOVER']);
    const attacker = await makeUser(['CUSTOMER']);
    const dup = await makeCase(subject.userId);
    const survivor = await makeCase(subject.userId);

    const res = await post(`/api/v1/safety/incidents/${dup.id}/merge`, { intoCaseId: survivor.id }, attacker.token);
    expect(res.statusCode).toBe(403);

    const after = await app.prisma.incidentCase.findUnique({ where: { id: dup.id } });
    expect(after?.status).toBe('OPEN');
  });

  it('the subject of the case cannot merge their own case away', async () => {
    // The realistic actor: the interim-suspension notification hands them the
    // caseId, and same-subject + same-tenant are satisfied for free.
    const subject = await makeUser(['MOVER']);
    const dup = await makeCase(subject.userId);
    const survivor = await makeCase(subject.userId);

    const res = await post(`/api/v1/safety/incidents/${dup.id}/merge`, { intoCaseId: survivor.id }, subject.token);
    expect(res.statusCode).toBe(403);

    const after = await app.prisma.incidentCase.findUnique({ where: { id: dup.id } });
    expect(after?.status).toBe('OPEN');
  });

  it('an unauthenticated caller is refused', async () => {
    const res = await post('/api/v1/safety/incidents/whatever/merge', { intoCaseId: 'x' });
    expect(res.statusCode).toBe(401);
  });
});

describe('[AUD-MAIN-004] census: every incident case action carries an ops check', () => {
  // Structural, so a NEW case action cannot be born unguarded the way merge was.
  // Source-as-text on purpose: it grades the registration site, which is where
  // the defect lived, and needs no database.
  it('no /incidents/:id/<action> route is registered with bare auth', () => {
    const src = readFileSync(join(__dirname, '..', 'modules', 'safety', 'safety.routes.ts'), 'utf8');
    const lines = src.split('\n');
    const starts = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /^\s*app\.(get|post|put|patch|delete)(<[^>]*>)?\(/.test(l));

    const unguarded: string[] = [];
    starts.forEach(({ l, i }, n) => {
      const m = /app\.\w+(?:<[^>]*>)?\(\s*'([^']+)'/.exec(l);
      if (!m) return;
      const path = m[1]!;
      if (!/^\/incidents\/:id\//.test(path)) return;
      const end = n + 1 < starts.length ? starts[n + 1]!.i : lines.length;
      const block = lines.slice(i, end).join('\n');
      if (!/opsCaseAction|isOps\(/.test(block)) unguarded.push(`${path} (line ${i + 1})`);
    });

    expect(unguarded, `incident case actions with no ops check: ${unguarded.join(', ')}`).toEqual([]);
  });
});
