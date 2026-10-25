import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { LEGAL_VERSION } from '../modules/legal/legal.routes';
import { MATERIAL_CHANGES, NON_MATERIAL_CHANGES, acceptanceStatus, materialVersion } from '../modules/legal/reaccept';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [Legal research G2 · R26 · Terms "Changes": "We announce material changes in the app … and ask you to accept
// them in the app"] "Continued use" is no longer acceptance. A material change is shown in short and accepted
// with a fresh tick; the tick is recorded in the consent ledger for the Terms, the Privacy Policy and the
// person's partner agreements, at the served version. Phone builds 9-11 never call this and are never blocked.
// ---------------------------------------------------------------------------

describe('who must accept, and what they are shown', () => {
  it('a material version takes effect only once it is the served version', () => {
    expect(materialVersion('2026-10-15')).toBeNull();
    expect(materialVersion('2026-10-16')).toBe('2026-10-16');
    expect(materialVersion('2026-12-01')).toBe(MATERIAL_CHANGES[MATERIAL_CHANGES.length - 1]!.version);
  });

  it('someone who never accepted any version must accept the current one (no change summary: it is all new to them)', () => {
    expect(acceptanceStatus({ tosVersion: null, roles: ['CUSTOMER'] as UserRole[] }, '2026-10-16')).toMatchObject({ needsAcceptance: true, summary: [] });
  });

  it('someone who accepted before a material version is asked again, with the summary; at or after it, not', () => {
    const before = acceptanceStatus({ tosVersion: '2026-10-15', roles: ['CUSTOMER'] as UserRole[] }, '2026-10-16');
    expect(before.needsAcceptance).toBe(true);
    expect(before.summary.join(' ')).toMatch(/Westbridge Inc\./);
    expect(before.summary.join(' ')).toMatch(/letters, documents or mail/);
    expect(acceptanceStatus({ tosVersion: '2026-10-16', roles: ['CUSTOMER'] as UserRole[] }, '2026-10-16').needsAcceptance).toBe(false);
    // A later non-material version (not listed) asks nobody who accepted the material one.
    expect(acceptanceStatus({ tosVersion: '2026-10-17', roles: ['CUSTOMER'] as UserRole[] }, '2026-10-20').needsAcceptance).toBe(false);
  });

  // [COORD 16 Oct · 2026-10-17] A person who accepted NEITHER 2026-10-16 nor 2026-10-17 is shown BOTH summaries,
  // oldest first — never only the newest — and a person who accepted 2026-10-16 is shown only what changed since.
  it('every material change since the accepted version is summarised, oldest first', () => {
    const v16 = MATERIAL_CHANGES.find((c) => c.version === '2026-10-16')!.summary;
    const v17 = MATERIAL_CHANGES.find((c) => c.version === '2026-10-17')!.summary;
    expect(v16.length).toBeGreaterThan(0);
    expect(v17.length).toBeGreaterThan(0);
    const skippedBoth = acceptanceStatus({ tosVersion: '2026-10-15', roles: ['CUSTOMER'] as UserRole[] }, '2026-10-17');
    expect(skippedBoth.needsAcceptance).toBe(true);
    expect(skippedBoth.summary).toEqual([...v16, ...v17]);
    const skippedOne = acceptanceStatus({ tosVersion: '2026-10-16', roles: ['CUSTOMER'] as UserRole[] }, '2026-10-17');
    expect(skippedOne.needsAcceptance).toBe(true);
    expect(skippedOne.summary).toEqual([...v17]);
    // Not yet served: 2026-10-17 neither asks nor summarises while 2026-10-16 is the served version.
    expect(acceptanceStatus({ tosVersion: '2026-10-15', roles: ['CUSTOMER'] as UserRole[] }, '2026-10-16').summary).toEqual([...v16]);
    expect(acceptanceStatus({ tosVersion: '2026-10-17', roles: ['CUSTOMER'] as UserRole[] }, '2026-10-17')).toMatchObject({ needsAcceptance: false, summary: [] });
  });

  it('the 2026-10-17 summary says what changed: people check identity, no face matching, customers never need a photo', () => {
    const v17 = MATERIAL_CHANGES.find((c) => c.version === '2026-10-17')!.summary.join(' ');
    expect(v17).toMatch(/Identity checks are done by people/);
    expect(v17).toMatch(/no automated face-matching/);
    expect(v17).toMatch(/Customers never need a photo/);
    expect(v17).toMatch(/if a business takes MMG, the MMG payment details it gives Swift are shown to its customer/);
    expect(v17).toMatch(/a business or mover handling your order sees your first name and phone number, only to reach you about that order, never your last name/);
  });

  it('partners re-accept their agreement with the Terms', () => {
    expect(acceptanceStatus({ tosVersion: null, roles: ['MOVER', 'CUSTOMER'] as UserRole[] }).agreements).toEqual(['driver_agreement']);
    // [REVIEW-F S3-1] legacy rider/driver roles re-accept the Mover Agreement too
    expect(acceptanceStatus({ tosVersion: null, roles: ['RIDER', 'CUSTOMER'] as UserRole[] }).agreements).toEqual(['driver_agreement']);
    expect(acceptanceStatus({ tosVersion: null, roles: ['DRIVER'] as UserRole[] }).agreements).toEqual(['driver_agreement']);
    expect(acceptanceStatus({ tosVersion: null, roles: ['VENDOR_OWNER', 'CUSTOMER'] as UserRole[] }).agreements).toEqual(['vendor_agreement']);
    expect(acceptanceStatus({ tosVersion: null, roles: ['CUSTOMER'] as UserRole[] }).agreements).toEqual([]);
  });
});

// [COORD 18 Oct ruling · 2026-10-18 NON-material] The Privacy s.6 sentence describes what already happens, so the
// bump asks nobody again. Phone builds 9-11 have no re-accept screen; a forced re-accept on staging could lock the
// shared store-review demo account out. These tests hold the three facts that keep every build working.
describe('[2026-10-18] a non-material bump asks nobody again', () => {
  it('every served version is classed exactly once: material (a fresh tick) or not', () => {
    const material = MATERIAL_CHANGES.some((c) => c.version === LEGAL_VERSION);
    const plain = NON_MATERIAL_CHANGES.some((c) => c.version === LEGAL_VERSION);
    expect(material !== plain, `${LEGAL_VERSION} must be listed in exactly one of MATERIAL_CHANGES / NON_MATERIAL_CHANGES`).toBe(true);
    expect(NON_MATERIAL_CHANGES.map((c) => c.version)).toContain('2026-10-18');
    expect(MATERIAL_CHANGES.map((c) => c.version)).not.toContain('2026-10-18');
  });

  it('nobody\'s answer changes: every accepted version and role gets the same answer at 2026-10-18 as at 2026-10-17', () => {
    expect(materialVersion('2026-10-18')).toBe('2026-10-17');
    for (const tosVersion of [null, '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']) {
      for (const roles of [['CUSTOMER'], ['MOVER', 'CUSTOMER'], ['VENDOR_OWNER', 'CUSTOMER']] as UserRole[][]) {
        const before = acceptanceStatus({ tosVersion, roles }, '2026-10-17');
        const after = acceptanceStatus({ tosVersion, roles }, '2026-10-18');
        expect([before.currentVersion, after.currentVersion]).toEqual(['2026-10-17', '2026-10-18']);
        // Everything but the served version itself is the same answer.
        expect({ ...after, currentVersion: before.currentVersion }, `${tosVersion} ${roles.join('+')}`).toEqual(before);
      }
    }
    expect(acceptanceStatus({ tosVersion: '2026-10-17', roles: ['CUSTOMER'] as UserRole[] }, '2026-10-18')).toMatchObject({ needsAcceptance: false, summary: [] });
  });

  // [owner 22 Oct 2026 · COORD 23:14Z · 2026-10-22 NON-material pre-launch] Terms s.7's one-minute cancel window asks
  // nobody again: every accepted version and role gets the same answer at 2026-10-22 as at 2026-10-21.
  it('[2026-10-22] nobody\'s answer changes: every accepted version and role gets the same answer at 2026-10-22 as at 2026-10-21', () => {
    expect(NON_MATERIAL_CHANGES.map((c) => c.version)).toContain('2026-10-22');
    expect(MATERIAL_CHANGES.map((c) => c.version)).not.toContain('2026-10-22');
    expect(materialVersion('2026-10-22')).toBe('2026-10-21');
    for (const tosVersion of [null, '2026-10-17', '2026-10-18', '2026-10-21']) {
      for (const roles of [['CUSTOMER'], ['MOVER', 'CUSTOMER'], ['VENDOR_OWNER', 'CUSTOMER']] as UserRole[][]) {
        const before = acceptanceStatus({ tosVersion, roles }, '2026-10-21');
        const after = acceptanceStatus({ tosVersion, roles }, '2026-10-22');
        expect({ ...after, currentVersion: before.currentVersion }, `${tosVersion} ${roles.join('+')}`).toEqual(before);
      }
    }
    expect(acceptanceStatus({ tosVersion: '2026-10-21', roles: ['CUSTOMER'] as UserRole[] }, '2026-10-22')).toMatchObject({ needsAcceptance: false, summary: [] });
  });

  it('builds 9-11 are never asked: only GET/POST /auth/legal-acceptance read acceptance, and sign-up stamps the server\'s version', () => {
    const SRC = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => { for (const n of readdirSync(dir)) { const f = join(dir, n); if (statSync(f).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(f); } else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) files.push(f); } };
    walk(SRC);
    const readers = files.filter((f) => /acceptanceStatus\(|needsAcceptance/.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f)).sort();
    expect(readers).toEqual(['modules/auth/auth.routes.ts', 'modules/legal/reaccept.ts']);
    const routes = readFileSync(join(SRC, 'modules/auth/auth.routes.ts'), 'utf8');
    expect(routes.match(/acceptanceStatus\(/g)).toHaveLength(2);
    for (const m of routes.matchAll(/acceptanceStatus\(/g)) {
      const opener = Math.max(...['app.get(', 'app.post(', 'app.put(', 'app.patch(', 'app.delete('].map((o) => routes.lastIndexOf(o, m.index!)));
      expect(routes.slice(opener, opener + 40)).toMatch(/^app\.(get|post)\('\/legal-acceptance'/);
    }
    expect(readFileSync(join(SRC, 'modules/auth/auth.service.ts'), 'utf8')).toMatch(/tosVersion: LEGAL_VERSION/);
  });
});

let app: FastifyInstance;
const userIds: string[] = [];

async function mkUser(roles: UserRole[], tosVersion: string | null) {
  const u = await app.prisma.user.create({
    data: { phone: testPhone(), firstName: 'Re', lastName: `Accept${nanoid(5)}`, roles, activeRole: roles[0]!, isPhoneVerified: true, tosVersion },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: u.id, token, refreshToken: nanoid(48), deviceId: 'reaccept', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { id: u.id, token };
}
const call = (method: 'GET' | 'POST', token: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: '/api/v1/auth/legal-acceptance', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(payload ? { payload } : {}) });
const rows = (userId: string) => runWithoutTenant(() => app.prisma.consentRecord.findMany({
  where: { subjectId: userId }, orderBy: { documentType: 'asc' }, select: { documentType: true, documentVersion: true, action: true, subjectType: true, evidence: true },
}), 'test-read:reaccept');

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:reaccept');
  await app.close();
});

describe('GET/POST /auth/legal-acceptance', () => {
  it('a person who never accepted is asked; the fresh tick records the Terms, the Privacy Policy and their agreement, at the served version', async () => {
    const mover = await mkUser(['MOVER', 'CUSTOMER'] as UserRole[], null);
    const status = await call('GET', mover.token);
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json().data).toMatchObject({ currentVersion: LEGAL_VERSION, acceptedVersion: null, needsAcceptance: true, agreements: ['driver_agreement'] });

    const accepted = await call('POST', mover.token, { version: LEGAL_VERSION, accept: true });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().data).toMatchObject({ acceptedVersion: LEGAL_VERSION, needsAcceptance: false });
    expect((await rows(mover.id)).map((r) => [r.documentType, r.documentVersion, r.action, r.subjectType])).toEqual([
      ['driver_agreement', LEGAL_VERSION, 'granted', 'driver'],
      ['privacy_policy', LEGAL_VERSION, 'granted', 'customer'],
      ['terms_of_service', LEGAL_VERSION, 'granted', 'customer'],
    ]);
    expect((await rows(mover.id))[0]!.evidence).toMatchObject({ control: 'reaccept_checkbox', path: 'auth/legal-acceptance' });

    // A double tap records once.
    expect((await call('POST', mover.token, { version: LEGAL_VERSION, accept: true })).statusCode).toBe(200);
    expect(await rows(mover.id)).toHaveLength(3);
  });

  it('accepting words that are no longer served is refused (they changed while the person read them); no tick, no row', async () => {
    const person = await mkUser(['CUSTOMER'] as UserRole[], null);
    const stale = await call('POST', person.token, { version: '2026-01-01', accept: true });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'LEGAL_VERSION_CHANGED', details: { currentVersion: LEGAL_VERSION } });
    const unticked = await call('POST', person.token, { version: LEGAL_VERSION, accept: false });
    expect(unticked.statusCode).toBe(400);
    expect(await rows(person.id)).toHaveLength(0);
  });

  // [2026-10-18 non-material] stays proven above (acceptanceStatus at '2026-10-18' is pure). At the served
  // 2026-10-22 (non-material, on top of the 2026-10-21 material change), a person who accepted 2026-10-17 or
  // 2026-10-18 is asked once, shown only what changed materially since — the waiting charge and crash reports, never a
  // line for the one-minute cancel window — and after the tick is not asked again. A person at 2026-10-21 is not asked.
  // [ROLE-DOCS] The served version is now 2026-10-22.1, NON-material on top of 2026-10-22: same summary, same answers.
  it('[2026-10-21 material, served 2026-10-22.1] a person who accepted 2026-10-17 or 2026-10-18 is asked once, with the 2026-10-21 summary only', async () => {
    const v21 = MATERIAL_CHANGES.find((c) => c.version === '2026-10-21')!.summary;
    expect(LEGAL_VERSION).toBe('2026-10-22.1');
    expect(NON_MATERIAL_CHANGES.map((c) => c.version)).toEqual(expect.arrayContaining(['2026-10-22', '2026-10-22.1']));
    expect(materialVersion('2026-10-22.1')).toBe('2026-10-21');
    for (const accepted of ['2026-10-17', '2026-10-18']) {
      const person = await mkUser(['CUSTOMER'] as UserRole[], accepted);
      expect((await call('GET', person.token)).json().data).toMatchObject({ currentVersion: '2026-10-22.1', acceptedVersion: accepted, needsAcceptance: true, summary: [...v21] });
      expect((await call('POST', person.token, { version: '2026-10-22.1', accept: true })).statusCode).toBe(200);
      expect((await call('GET', person.token)).json().data).toMatchObject({ acceptedVersion: '2026-10-22.1', needsAcceptance: false, summary: [] });
    }
    const at21 = await mkUser(['CUSTOMER'] as UserRole[], '2026-10-21');
    expect((await call('GET', at21.token)).json().data).toMatchObject({ currentVersion: '2026-10-22.1', acceptedVersion: '2026-10-21', needsAcceptance: false, summary: [] });
  });

  it('a person already at the served version is not asked', async () => {
    const person = await mkUser(['CUSTOMER'] as UserRole[], LEGAL_VERSION);
    expect((await call('GET', person.token)).json().data).toMatchObject({ needsAcceptance: false, acceptedVersion: LEGAL_VERSION });
  });
});
