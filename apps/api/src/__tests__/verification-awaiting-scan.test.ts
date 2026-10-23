/**
 * [Row 312 · REVIEW-G S3-1 · COORD ruling 23 Oct, option (a)] STAFF NEVER OPEN AN UNSCANNED DOCUMENT.
 *
 * Under MALWARE_SCAN_BYPASS=1 (clamd down) a mover's onboarding document is stored WITHOUT a scan and
 * owed a rescan. The admin document viewer decrypted and served it inline to the reviewer for the whole
 * outage: a crafted file reaching a reviewer's browser is exactly what the scanner exists to stop. The
 * owner's rule (18 Oct) is that the scan fails closed while the scanner is down, so: while that debt is
 * open the viewer answers "awaiting malware scan" (no link minted, nothing decrypted, nothing served);
 * once a rescan answers CLEAN the document opens as before.
 *
 * Real path end to end: the upload route under the bypass with an unreachable scanner, the audited
 * document-url door, the render door, and the upload-rescan job against a fake clamd.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import crypto from 'node:crypto';
import net from 'node:net';
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
import { getStorageProvider } from '../providers/storage/storage-provider';
import { rescanUploadDebt } from '../lib/upload-scan-debt';
import { REAL_PNG, uniquePng } from './helpers/real-image';

const GRANT = 'documents.review';
const AWAITING = 'AWAITING_MALWARE_SCAN';
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const REASON = `Onboarding review ${RUN}: checking the applicant's ID`;
const PNG = uniquePng(`awaitscan-${RUN}`);
/** Nothing listens here: the scanner is down. */
const DOWN = { MALWARE_SCAN: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: '1' } as const;
const SCAN_ENV = ['MALWARE_SCAN', 'CLAMD_HOST', 'CLAMD_PORT', 'MALWARE_SCAN_BYPASS'] as const;

let app: FastifyInstance;
const users: string[] = [];
let seq = 0;
let moverId = '';
let moverToken = '';
const servers: net.Server[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'verification-awaiting-scan-test');

async function person(role: 'ADMIN' | 'MOVER', permissions?: readonly string[]) {
  seq += 1;
  const u = await system(() => app.prisma.user.create({ data: {
    phone: `+59276${NUM}${String(seq).padStart(2, '0')}`, firstName: `Aw${RUN}`, lastName: `P${seq}`,
    roles: [role, 'CUSTOMER'] as never[], activeRole: role as never, status: 'ACTIVE', isPhoneVerified: true,
    ...(permissions ? { admin: { create: { permissions: [...permissions] } } } : {}),
  } }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role, jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `aw-${RUN}-${seq}`, deviceType: 'test',
    expiresAt: new Date(Date.now() + DAY),
  } }));
  return { id: u.id, token };
}

const mint = (token: string, docId: string) => app.inject({
  method: 'GET', url: `/api/v1/admin/verification/${docId}/document-url`,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
});
const render = (path: string) => app.inject({ method: 'GET', url: path });

async function uploadedDoc(): Promise<{ docId: string; fileUrl: string }> {
  const boundary = `----aw${RUN}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="doc.png"\r\ncontent-type: image/png\r\n\r\n`),
    PNG, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await app.inject({ method: 'POST', url: '/api/v1/verification/upload',
    headers: { authorization: `Bearer ${moverToken}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  expect(up.statusCode, up.body).toBe(200);
  const fileUrl: string = up.json().data.url;
  const doc = await system(() => app.prisma.verificationDocument.create({ data: {
    userId: moverId, role: 'MOVER', docType: 'national_id', fileUrl, status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1',
  } }));
  return { docId: doc.id, fileUrl };
}

/** A fake clamd that answers PING and calls every stream clean. */
async function cleanClamd(): Promise<Record<string, string>> {
  const server = net.createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.toString('utf8').startsWith('zPING\0')) { socket.end('PONG\0'); return; }
      let at = 'zINSTREAM\0'.length;
      for (;;) {
        if (data.length < at + 4) return;
        const length = data.readUInt32BE(at);
        if (length === 0) break;
        if (data.length < at + 4 + length) return;
        at += 4 + length;
      }
      socket.end('stream: OK\0');
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { MALWARE_SCAN: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String((server.address() as net.AddressInfo).port) };
}

const viewAudits = (docId: string) => system(() => app.prisma.auditLog.count({ where: { action: 'VIEW_VERIFICATION_DOC', entityId: docId } }));

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
  const mover = await person('MOVER');
  moverId = mover.id; moverToken = mover.token;
});

afterEach(async () => {
  for (const name of SCAN_ENV) delete process.env[name];
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

afterAll(async () => {
  delete process.env['MASTER_KEK'];
  resetKeyProviderForTests();
  await system(async () => {
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true, fileUrl: true } });
    await app.prisma.uploadScanDebt.deleteMany({ where: { OR: [{ fileKey: { in: docs.map((d) => d.fileUrl) } }, { surface: 'verification', sha256: crypto.createHash('sha256').update(PNG).digest('hex') }] } }).catch(() => {});
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await app.prisma.documentRecord.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: users } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  });
  await app.close();
});

describe('[Row 312 · G S3-1 (a)] a document stored under the bypass is not opened by staff until a clean scan', () => {
  it('awaiting malware scan: no link, nothing decrypted or served, no view recorded; a clean rescan opens it', async () => {
    // clamd is down and the emergency switch is on: the mover's ID is stored unscanned, owed a rescan.
    Object.assign(process.env, DOWN, { MALWARE_SCAN_BYPASS: '1' });
    const { docId, fileUrl } = await uploadedDoc();
    const debt = await system(() => app.prisma.uploadScanDebt.findFirst({ where: { fileKey: fileUrl }, select: { reason: true, surface: true, rescannedAt: true } }));
    expect(debt).toMatchObject({ reason: 'bypass', surface: 'verification', rescannedAt: null });

    const reviewer = await person('ADMIN', ['*', GRANT]);
    // The audited door says why, in words the console repeats, and mints no link.
    const refused = await mint(reviewer.token, docId);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe(AWAITING);
    expect(refused.json().error.message).toMatch(/malware scan/i);
    expect(refused.json().data?.url).toBeUndefined();
    expect(await viewAudits(docId)).toBe(0);
    // A link minted any other way is refused by the render door too, before anything is decrypted.
    const link = mintRenderPath(docId, reviewer.id, 60).path;
    const served = await render(link);
    expect(served.statusCode).toBe(409);
    expect(served.json().error.code).toBe(AWAITING);
    expect(Buffer.from(served.rawPayload).includes(REAL_PNG.subarray(0, 64))).toBe(false);

    // clamd is back: the rescan answers CLEAN and closes the debt; the document opens as before.
    for (const name of SCAN_ENV) delete process.env[name];
    const env = await cleanClamd();
    const pass = await rescanUploadDebt({ prisma: app.prisma as never, redis: app.redis, notifications: {} as never, storage: getStorageProvider(), env });
    expect(pass.clean).toBeGreaterThanOrEqual(1);
    const opened = await mint(reviewer.token, docId);
    expect(opened.statusCode, opened.body).toBe(200);
    const shown = await render(opened.json().data.url);
    expect(shown.statusCode).toBe(200);
    expect(Buffer.from(shown.rawPayload).equals(REAL_PNG)).toBe(true);
    expect(await viewAudits(docId)).toBe(1);
  });

  it('a document scanned at upload (no debt) opens at once, as before', async () => {
    const { docId } = await uploadedDoc();
    const reviewer = await person('ADMIN', ['*', GRANT]);
    const opened = await mint(reviewer.token, docId);
    expect(opened.statusCode, opened.body).toBe(200);
    expect((await render(opened.json().data.url)).statusCode).toBe(200);
  });
});
