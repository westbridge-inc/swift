/**
 * [VERIFY-DOCS V3] ONLY A DOCUMENT REVIEWER OPENS, APPROVES OR REJECTS A DOCUMENT.
 *
 * Owner rulings, 6 Oct 2026: "only a verification-reviewer can open documents";
 * "opening, approving and rejecting documents all need an explicit document
 * reviewer grant (never implied by `*` or role defaults); a super-admin may
 * grant it to themselves with a recorded reason". Today's roles stay as they
 * are (no REVIEWER role at launch), so the grant is ONE permission entry on the
 * admin account — `documents.review` — that only its exact name confers.
 *
 * Before this change every ADMIN and SUPER_ADMIN held `*`, `*` covered
 * `verification.document.read`, and a minted view link was a five-minute
 * bearer token nobody could take back. Now:
 *   - `*`, a prefix wildcard and the role default never confer the grant;
 *   - the four document doors (open, approve, reject, revoke) demand it;
 *   - the view link names the reviewer it was minted for, and the render route
 *     re-reads that reviewer's grant on every load, so revoking the grant (or
 *     suspending or demoting the reviewer) kills links already open;
 *   - the legacy client-written document pointers on mover rows are withheld
 *     from every admin response unless the caller holds the grant;
 *   - shadow mode never relaxes any of it;
 *   - a SUPER_ADMIN grants and revokes (themselves included) with a reason,
 *     and the record keeps who, whom, why and the before/after of the grant.
 *
 * The test names the new capability and error code as plain strings, so on
 * the old code every case fails on its own assertion rather than on an import.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { mintRenderPath, resetKeyProviderForTests } from '../providers/storage/envelope';
import * as authority from '../modules/admin/admin-authority';

const GRANT = 'documents.review';
const REQUIRED = 'DOCUMENT_REVIEWER_REQUIRED';
const MESSAGE = 'You need the document-reviewer permission — ask a super-admin, or grant it to yourself in Staff & roles';
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const REASON = `Document review rota ${RUN}: owner reviews this week`;
const OTHER_TENANT = `vd3-${RUN.toLowerCase()}`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`vd3-${RUN}`)]);

let app: FastifyInstance;
const users: string[] = [];
let seq = 0;
let moverId = '';
let moverToken = '';
let ownerId = '';
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'document-reviewer-grant-test');

type Role = 'ADMIN' | 'SUPER_ADMIN';
async function person(opts: { role: Role | 'MOVER' | 'VENDOR_OWNER'; permissions?: readonly string[] | null; tenantId?: string }) {
  seq += 1;
  const role = opts.role;
  const u = await system(() => app.prisma.user.create({ data: {
    phone: `+59275${NUM}${String(seq).padStart(2, '0')}`, firstName: `Vd${RUN}`, lastName: `P${seq}`,
    roles: [role, 'CUSTOMER'] as never[], activeRole: role as never, status: 'ACTIVE', isPhoneVerified: true,
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    ...(opts.permissions ? { admin: { create: { permissions: [...opts.permissions] } } } : {}),
  } }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role, jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `vd3-${RUN}-${seq}`, deviceType: 'test',
    expiresAt: new Date(Date.now() + DAY),
  } }));
  return { id: u.id, token };
}
const admin = (permissions: readonly string[] | null, role: Role = 'ADMIN', tenantId?: string) =>
  person({ role, permissions, ...(tenantId ? { tenantId } : {}) });

const call = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>, reason: string | null = REASON) => app.inject({
  method, url: `/api/v1/admin${url}`, ...(payload !== undefined ? { payload } : {}),
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(reason ? { 'x-swift-reason': reason } : {}) },
});
const render = (path: string) => app.inject({ method: 'GET', url: path });

async function uploadedDoc(): Promise<string> {
  const boundary = `----vd3${RUN}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="doc.png"\r\ncontent-type: image/png\r\n\r\n`),
    PNG, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await app.inject({ method: 'POST', url: '/api/v1/verification/upload',
    headers: { authorization: `Bearer ${moverToken}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  expect(up.statusCode).toBe(200);
  const doc = await system(() => app.prisma.verificationDocument.create({ data: {
    userId: moverId, role: 'MOVER', docType: 'national_id', fileUrl: up.json().data.url, status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1',
  } }));
  return doc.id;
}
async function pendingOwnerDoc(status: 'PENDING' | 'APPROVED' = 'PENDING') {
  return system(() => app.prisma.verificationDocument.create({ data: {
    userId: ownerId, role: 'VENDOR_OWNER', docType: 'business_registration', fileUrl: '', status, consentAt: new Date(), privacyNoticeVersion: 'v1',
    ...(status === 'APPROVED' ? { reviewedAt: new Date(), state: 'COMMITTED' as const } : {}),
  } }));
}
const permissionsOf = async (userId: string) =>
  (await system(() => app.prisma.admin.findUnique({ where: { userId }, select: { permissions: true } })))?.permissions ?? null;
const statusOf = async (id: string) =>
  (await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id }, select: { status: true } }))).status;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['MASTER_KEK'] = crypto.randomBytes(32).toString('base64');
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  await system(() => app.prisma.tenant.create({ data: { id: OTHER_TENANT, name: `VD3 other ${RUN}`, slug: OTHER_TENANT, isActive: true } }));
  const mover = await person({ role: 'MOVER' });
  moverId = mover.id; moverToken = mover.token;
  ownerId = (await person({ role: 'VENDOR_OWNER' })).id;
});

afterEach(() => { delete process.env['ADMIN_CAPABILITY_MODE']; });

afterAll(async () => {
  delete process.env['MASTER_KEK'];
  resetKeyProviderForTests();
  await system(async () => {
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } }).catch(() => {});
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await app.prisma.documentRecord.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: users } } }).catch(() => {});
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
    await app.prisma.tenant.deleteMany({ where: { id: OTHER_TENANT } }).catch(() => {});
  });
  await app.close();
});

describe('[V3] the grant is explicit-only: `*`, a wildcard or a role default never confer it', () => {
  it('the engine: `*` and `documents.*` do not match the grant; only its exact name does', () => {
    expect(authority.capabilityMatches('*', GRANT)).toBe(false);
    expect(authority.capabilityMatches('documents.*', GRANT)).toBe(false);
    expect(authority.holdsCapability(['*', 'verification.*', 'documents.*'], GRANT)).toBe(false);
    expect(authority.holdsCapability([GRANT], GRANT)).toBe(true);
    // ...and everything else still matches exactly as before
    expect(authority.capabilityMatches('*', 'verification.document.read')).toBe(true);
  });

  it('the grant never NARROWS an actor: alone on the list, the role default still applies beside it', () => {
    expect(authority.capabilitiesOf({ role: 'ADMIN', permissions: [GRANT] })).toEqual(['*', GRANT]);
    expect(authority.capabilitiesOf({ role: 'SUPER_ADMIN', permissions: [GRANT] })).toEqual(['*', GRANT]);
    // an ordinary entry still REPLACES the role container, as ADM-001 says
    expect(authority.capabilitiesOf({ role: 'ADMIN', permissions: ['support.read', GRANT] })).toEqual(['support.read', GRANT]);
  });

  it('the four document doors demand the grant on top of their own capability; nothing else does', () => {
    const doors = ['GET /verification/:id/document-url', 'PUT /verification/:id/approve', 'PUT /verification/:id/reject', 'PUT /verification/:id/revoke'];
    for (const door of doors) expect((authority.ADMIN_ROUTE_AUTHORITY[door] as { requires?: string } | undefined)?.requires, door).toBe(GRANT);
    const others = Object.entries(authority.ADMIN_ROUTE_AUTHORITY).filter(([k, a]) => !doors.includes(k) && (a as { requires?: string }).requires);
    expect(others.map(([k]) => k)).toEqual([]);
    expect(authority.decideCapability({ role: 'SUPER_ADMIN', permissions: ['*'] }, 'GET', '/verification/:id/document-url').allowed).toBe(false);
    expect(authority.decideCapability({ role: 'SUPER_ADMIN', permissions: ['*', GRANT] }, 'GET', '/verification/:id/document-url').allowed).toBe(true);
  });
});

describe('[V3] opening a document', () => {
  it('an ADMIN holding `*` is refused, in plain words, and no view is recorded', async () => {
    const docId = await uploadedDoc();
    const a = await admin(['*']);
    const res = await call(a.token, 'GET', `/verification/${docId}/document-url`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe(REQUIRED);
    expect(res.json().error.message).toBe(MESSAGE);
    const views = await system(() => app.prisma.auditLog.count({ where: { action: 'VIEW_VERIFICATION_DOC', entityId: docId } }));
    expect(views).toBe(0);
  });

  it('a SUPER_ADMIN holding `*`, an admin on the role default, and every wildcard are refused alike', async () => {
    const docId = await uploadedDoc();
    for (const a of [await admin(['*'], 'SUPER_ADMIN'), await admin(null), await admin([]), await admin(['*', 'verification.*', 'documents.*'], 'SUPER_ADMIN')]) {
      const res = await call(a.token, 'GET', `/verification/${docId}/document-url`);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe(REQUIRED);
    }
  });

  it('shadow mode never relaxes it', async () => {
    process.env['ADMIN_CAPABILITY_MODE'] = 'shadow';
    const docId = await uploadedDoc();
    const a = await admin(['*'], 'SUPER_ADMIN');
    const res = await call(a.token, 'GET', `/verification/${docId}/document-url`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe(REQUIRED);
  });

  it('a reviewer opens it; the link names its reviewer; revoking the grant kills the link already open', async () => {
    const docId = await uploadedDoc();
    const r = await admin(['*', GRANT]);
    const minted = await call(r.token, 'GET', `/verification/${docId}/document-url`);
    expect(minted.statusCode).toBe(200);
    const path: string = minted.json().data.url;
    expect(new URL(path, 'http://x').searchParams.get('reviewer')).toBe(r.id);
    const first = await render(path);
    expect(first.statusCode).toBe(200);
    expect(Buffer.from(first.rawPayload).equals(PNG)).toBe(true);
    await system(() => app.prisma.admin.update({ where: { userId: r.id }, data: { permissions: ['*'] } }));
    const after = await render(path);
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe(REQUIRED);
  });

  it('a link cannot be re-aimed at another reviewer, and a suspended or demoted reviewer’s link stops working', async () => {
    const docId = await uploadedDoc();
    const r = await admin(['*', GRANT]);
    const other = await admin(['*', GRANT]);
    const path: string = (await call(r.token, 'GET', `/verification/${docId}/document-url`)).json().data.url;
    const reaimed = new URL(path, 'http://x');
    reaimed.searchParams.set('reviewer', other.id);
    expect((await render(`${reaimed.pathname}${reaimed.search}`)).statusCode).toBe(403);
    const stripped = new URL(path, 'http://x');
    stripped.searchParams.delete('reviewer');
    expect((await render(`${stripped.pathname}${stripped.search}`)).statusCode).toBe(403);
    expect((await render(path)).statusCode).toBe(200);
    await system(() => app.prisma.user.update({ where: { id: r.id }, data: { status: 'SUSPENDED' } }));
    expect((await render(path)).statusCode).toBe(403);
    await system(() => app.prisma.user.update({ where: { id: r.id }, data: { status: 'ACTIVE', activeRole: 'CUSTOMER', roles: ['CUSTOMER'] } }));
    expect((await render(path)).statusCode).toBe(403);
  });

  it('a reviewer in another tenant cannot open this tenant’s document through a link minted for them', async () => {
    const docId = await uploadedDoc();
    const foreign = await admin(['*', GRANT], 'SUPER_ADMIN', OTHER_TENANT);
    // their own console cannot even find it
    expect((await call(foreign.token, 'GET', `/verification/${docId}/document-url`)).statusCode).toBe(404);
    // and a correctly signed link naming them (defence in depth) is refused at render
    const named = mintRenderPath(docId, foreign.id, 60).path;
    const refused = await render(named);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe(REQUIRED);
  });
});

describe('[V3] deciding a document', () => {
  it('approve, reject and revoke are refused without the grant and change nothing', async () => {
    const a = await admin(['*'], 'SUPER_ADMIN');
    const pending = await pendingOwnerDoc();
    const approve = await call(a.token, 'PUT', `/verification/${pending.id}/approve`, {});
    expect(approve.statusCode).toBe(403);
    expect(approve.json().error.code).toBe(REQUIRED);
    const reject = await call(a.token, 'PUT', `/verification/${pending.id}/reject`, { reason: REASON, reasonCode: 'UNREADABLE' });
    expect(reject.statusCode).toBe(403);
    expect(await statusOf(pending.id)).toBe('PENDING');
    const approved = await pendingOwnerDoc('APPROVED');
    const revoke = await call(a.token, 'PUT', `/verification/${approved.id}/revoke`, { reason: REASON });
    expect(revoke.statusCode).toBe(403);
    expect(revoke.json().error.code).toBe(REQUIRED);
    expect(await statusOf(approved.id)).toBe('APPROVED');
  });

  it('with the grant the same admin approves and rejects', async () => {
    const r = await admin(['*', GRANT], 'SUPER_ADMIN');
    const one = await pendingOwnerDoc();
    expect((await call(r.token, 'PUT', `/verification/${one.id}/approve`, {})).statusCode).toBe(200);
    expect(await statusOf(one.id)).toBe('APPROVED');
    const two = await pendingOwnerDoc();
    expect((await call(r.token, 'PUT', `/verification/${two.id}/reject`, { reason: REASON, reasonCode: 'UNREADABLE' })).statusCode).toBe(200);
    expect(await statusOf(two.id)).toBe('REJECTED');
  });
});

describe('[V3] granting and revoking', () => {
  it('only a SUPER_ADMIN grants; an ADMIN holding `*` is refused and nothing changes', async () => {
    const a = await admin(['*']);
    const target = await admin(['*']);
    const res = await call(a.token, 'PUT', `/staff/${target.id}/document-reviewer`, { grant: true });
    expect(res.statusCode).toBe(403);
    expect(await permissionsOf(target.id)).toEqual(['*']);
  });

  it('a reason is required', async () => {
    const s = await admin(['*'], 'SUPER_ADMIN');
    const res = await call(s.token, 'PUT', `/staff/${s.id}/document-reviewer`, { grant: true }, null);
    expect(res.statusCode).toBe(400);
    expect(await permissionsOf(s.id)).toEqual(['*']);
  });

  it('a SUPER_ADMIN grants it to themselves with a reason; the grant adds, never narrows; the record names who, whom and why', async () => {
    const s = await admin(['*'], 'SUPER_ADMIN');
    const res = await call(s.token, 'PUT', `/staff/${s.id}/document-reviewer`, { grant: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ userId: s.id, documentReviewer: true, changed: true });
    expect(await permissionsOf(s.id)).toEqual(['*', GRANT]);
    const named = await system(() => app.prisma.auditLog.findFirst({ where: { action: 'DOCUMENT_REVIEWER_GRANTED', entityId: s.id } }));
    expect(named).not.toBeNull();
    expect(named!.userId).toBe(s.id);
    expect(named!.changes).toMatchObject({ reason: REASON, self: true, targetUserId: s.id });
    const row = await system(() => app.prisma.auditLog.findFirst({ where: { action: `ADMIN PUT /api/v1/admin/staff/:userId/document-reviewer`, entityId: s.id } }));
    expect(row).not.toBeNull();
    const changes = row!.changes as { before: string | null; after: string | null; reason?: string };
    expect(changes.reason).toBe(REASON);
    expect(changes.before).not.toBe(changes.after);
    // and the new grant works on the very next request, with no new login
    const docId = await uploadedDoc();
    expect((await call(s.token, 'GET', `/verification/${docId}/document-url`)).statusCode).toBe(200);
  });

  it('granting an admin with no Admin row keeps their role default; revoking kills their open links', async () => {
    const s = await admin(['*'], 'SUPER_ADMIN');
    const target = await admin(null);
    expect((await call(s.token, 'PUT', `/staff/${target.id}/document-reviewer`, { grant: true })).statusCode).toBe(200);
    expect(await permissionsOf(target.id)).toEqual([GRANT]);
    expect((await call(target.token, 'GET', '/finance/revenue')).statusCode).not.toBe(403);
    const docId = await uploadedDoc();
    const path: string = (await call(target.token, 'GET', `/verification/${docId}/document-url`)).json().data.url;
    expect((await render(path)).statusCode).toBe(200);
    const revoked = await call(s.token, 'PUT', `/staff/${target.id}/document-reviewer`, { grant: false });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().data).toMatchObject({ documentReviewer: false, changed: true });
    expect(await permissionsOf(target.id)).toEqual([]);
    expect((await render(path)).statusCode).toBe(403);
    const named = await system(() => app.prisma.auditLog.findFirst({ where: { action: 'DOCUMENT_REVIEWER_REVOKED', entityId: target.id } }));
    expect(named!.changes).toMatchObject({ reason: REASON, self: false, targetUserId: target.id });
  });

  it('granting a holder again changes nothing and writes no second grant record', async () => {
    const s = await admin(['*', GRANT], 'SUPER_ADMIN');
    const res = await call(s.token, 'PUT', `/staff/${s.id}/document-reviewer`, { grant: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ documentReviewer: true, changed: false });
    expect(await permissionsOf(s.id)).toEqual(['*', GRANT]);
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'DOCUMENT_REVIEWER_GRANTED', entityId: s.id } }))).toBe(0);
  });

  it('the target must be an active admin in the same tenant', async () => {
    const s = await admin(['*'], 'SUPER_ADMIN');
    const customer = await person({ role: 'MOVER' });
    const notStaff = await call(s.token, 'PUT', `/staff/${customer.id}/document-reviewer`, { grant: true });
    expect(notStaff.statusCode).toBe(409);
    expect(await permissionsOf(customer.id)).toBeNull();
    const foreign = await admin(['*'], 'ADMIN', OTHER_TENANT);
    expect((await call(s.token, 'PUT', `/staff/${foreign.id}/document-reviewer`, { grant: true })).statusCode).toBe(404);
    expect(await permissionsOf(foreign.id)).toEqual(['*']);
  });

  it('a SUPER_ADMIN lists the tenant’s staff with who holds the grant; an ADMIN may not', async () => {
    const s = await admin(['*'], 'SUPER_ADMIN');
    const holder = await admin(['*', GRANT]);
    const foreign = await admin(['*', GRANT], 'ADMIN', OTHER_TENANT);
    const res = await call(s.token, 'GET', '/staff/document-reviewers');
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ userId: string; documentReviewer: boolean; you: boolean }>;
    expect(rows.find((r) => r.userId === holder.id)).toMatchObject({ documentReviewer: true, you: false });
    expect(rows.find((r) => r.userId === s.id)).toMatchObject({ documentReviewer: false, you: true });
    expect(rows.find((r) => r.userId === foreign.id)).toBeUndefined();
    expect(res.body).not.toMatch(/phone|\+592/);
    expect((await call(holder.token, 'GET', '/staff/document-reviewers')).statusCode).toBe(403);
  });
});

describe('[V3] legacy document pointers on mover rows', () => {
  const POINTERS = ['nationalIdUrl', 'driverLicenseUrl', 'vehicleInsuranceUrl', 'vehicleInspectionUrl'];
  async function moverRows() {
    const r = await person({ role: 'MOVER' });
    const rider = await system(() => app.prisma.rider.create({ data: {
      userId: r.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
      nationalIdUrl: `legacy/${RUN}/id.jpg`, driverLicenseUrl: `legacy/${RUN}/dl.jpg`, vehicleInsuranceUrl: `legacy/${RUN}/ins.jpg`,
    } as never }));
    const d = await person({ role: 'MOVER' });
    const driver = await system(() => app.prisma.driver.create({ data: {
      userId: d.id, vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2015, vehicleColor: 'White', licensePlate: `HC ${NUM}`,
      nationalIdUrl: `legacy/${RUN}/did.jpg`, driverLicenseUrl: `legacy/${RUN}/ddl.jpg`, vehicleInsuranceUrl: `legacy/${RUN}/dins.jpg`, vehicleInspectionUrl: `legacy/${RUN}/dfit.jpg`,
    } as never }));
    return { rider, driver };
  }

  it('a non-reviewer sees no pointer on the rider and driver detail or list; a reviewer does', async () => {
    const { rider, driver } = await moverRows();
    const plain = await admin(['*'], 'SUPER_ADMIN');
    const reviewer = await admin(['*', GRANT]);
    for (const url of [`/riders/${rider.id}`, `/drivers/${driver.id}`, '/riders?limit=100', '/drivers?limit=100']) {
      const hidden = await call(plain.token, 'GET', url);
      expect(hidden.statusCode, url).toBe(200);
      for (const key of POINTERS) expect(hidden.body, `${url} ${key}`).not.toContain(`"${key}"`);
      expect(hidden.body, url).not.toContain(`legacy/${RUN}/`);
    }
    for (const url of [`/riders/${rider.id}`, `/drivers/${driver.id}`]) {
      const shown = await call(reviewer.token, 'GET', url);
      expect(shown.statusCode, url).toBe(200);
      expect(shown.body, url).toContain(`legacy/${RUN}/`);
    }
  });
});
