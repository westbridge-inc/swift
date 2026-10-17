import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { asFastifyTrustProxy } from '../config/trust-proxy';
import { captureSignup } from '../modules/integrity/capture-hooks';
import { hasActiveHold } from '../modules/integrity/enforcement';
import { hashSignal, isPublicNetworkAddress, normalizeIpSubnet, normalizePhone } from '../modules/integrity/normalize';
import { registrationProofFor } from './helpers/otp';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [AUD-1 row 301 · AUD-L4-009 · AUD-PRIOR-009] The signup fraud check.
//
// It counted only signups that named a device (X-Device-Id), and no Swift
// client sends that header: every real signup skipped it, and so did anyone who
// simply left the header out. Repeat signups from one network were recorded
// (signup_attempts.ipHash) and never read; the platform setting
// ipFlagThreshold24h existed and nothing used it.
//
// Now: a signup that names no device lands in the unknown-device bucket of its
// network and is judged with that network; every signup from a public network
// counts against it, whatever device it names. Crossing the threshold refuses
// nothing and tells the person nothing: the account enters REVIEW_FIRST, the
// existing rung where a PERSON checks it at activation (carrier NAT puts many
// real Guyana users behind one network, so the network alone never blocks).
// The source address is request.ip, which follows TRUST_PROXY: a raw
// X-Forwarded-For never picks the bucket.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let behindProxy: FastifyInstance;
const userIds: string[] = [];
const phones: string[] = [];
let seq = 0;
const phoneBase = 592_896_000_000 + Math.floor(Math.random() * 3_000_000);

/** A fresh public /24 per call (190.80.0.0/12 is Guyana carrier space): the counts start at zero every run. */
const usedNetworks = new Set<string>();
function freshNetwork(): string {
  for (;;) {
    const net = `190.${80 + Math.floor(Math.random() * 16)}.${Math.floor(Math.random() * 256)}`;
    if (!usedNetworks.has(net)) {
      usedNetworks.add(net);
      return net;
    }
  }
}

async function makeUser() {
  seq += 1;
  const phone = `+${phoneBase + seq}`;
  const u = await app.prisma.user.create({
    data: { phone, firstName: 'Net', lastName: `V${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true },
  });
  userIds.push(u.id);
  phones.push(phone);
  return u;
}

async function signup(deviceId: string | null, ip: string | null) {
  const u = await makeUser();
  await captureSignup(app.prisma, { userId: u.id, role: 'CUSTOMER', phone: u.phone, deviceId, ip });
  return u;
}

async function networkThreshold(): Promise<number> {
  return (await app.prisma.integritySettings.findUnique({ where: { id: 'platform' } }))?.ipFlagThreshold24h ?? 15;
}

async function attemptOf(phone: string) {
  return app.prisma.signupAttempt.findFirst({ where: { phoneHash: hashSignal(normalizePhone(phone)) }, orderBy: { createdAt: 'desc' } });
}

async function withNetworkThreshold<T>(value: number, run: () => Promise<T>): Promise<T> {
  const before = await app.prisma.integritySettings.findUnique({ where: { id: 'platform' } });
  await app.prisma.integritySettings.upsert({ where: { id: 'platform' }, create: { id: 'platform', ipFlagThreshold24h: value }, update: { ipFlagThreshold24h: value } });
  try {
    return await run();
  } finally {
    if (before) await app.prisma.integritySettings.update({ where: { id: 'platform' }, data: { ipFlagThreshold24h: before.ipFlagThreshold24h } });
    else await app.prisma.integritySettings.delete({ where: { id: 'platform' } });
  }
}

async function buildApp(trustProxy: string | undefined): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false, trustProxy: asFastifyTrustProxy(trustProxy) });
  registerErrorHandler(instance);
  registerEmptyJsonBodyParser(instance);
  await instance.register(prismaPlugin);
  await instance.register(redisPlugin);
  await instance.register(authPlugin);
  await instance.register(socketPlugin);
  await instance.register(authRoutes, { prefix: '/api/v1/auth' });
  await instance.ready();
  return instance;
}

beforeAll(async () => {
  app = await buildApp(undefined);
  behindProxy = await buildApp('loopback');
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.enforcementAction.deleteMany({ where: { accountId: { in: userIds } } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } });
    await app.prisma.signupAttempt.deleteMany({ where: { phoneHash: { in: phones.map((p) => hashSignal(normalizePhone(p))) } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:signup-network-velocity');
  await behindProxy.close();
  await app.close();
});

describe('a signup that names no device is never a pass [AUD-1 row 301]', () => {
  it('no header, a blank one, "unknown" or "registration": the Nth from one public network waits for a person', async () => {
    const net = freshNetwork();
    const threshold = await networkThreshold();
    const noDevice = [null, '', 'unknown', 'registration', '   '];
    const users = [];
    for (let i = 0; i < threshold; i += 1) {
      users.push(await signup(noDevice[i % noDevice.length]!, `${net}.${(i % 250) + 1}`));
    }
    const last = users[users.length - 1]!;
    expect((await hasActiveHold(app.prisma, last.id)).held).toBe(true);
    const action = await app.prisma.enforcementAction.findFirst({ where: { accountId: last.id } });
    expect(action?.level).toBe('REVIEW_FIRST');
    expect(action?.reasonCode).toBe('VELOCITY_NETWORK');
    expect(action?.decidedBy).toBe('SYSTEM');
    expect(action?.signalsFired).toEqual([{ type: 'IP_SUBNET', windowHours: 24, signups: threshold, threshold, deviceHeader: 'missing' }]);
    expect((await attemptOf(last.phone))?.outcome).toBe('REVIEW_FIRST');
    // Earlier signups are untouched: the rung is the Nth, not a retroactive sweep.
    for (const u of users.slice(0, -1)) expect((await hasActiveHold(app.prisma, u.id)).held).toBe(false);
  });

  it('the ledger files it under the unknown-device bucket of its network, never under no device at all', async () => {
    const [netA, netB] = [freshNetwork(), freshNetwork()];
    const a1 = await signup(null, `${netA}.10`);
    const a2 = await signup('unknown', `${netA}.200`);
    const b1 = await signup(null, `${netB}.10`);
    const named = await signup(`dev-${nanoid(10)}`, `${netA}.11`);
    const [ra1, ra2, rb1, rn] = await Promise.all([a1, a2, b1, named].map((u) => attemptOf(u.phone)));
    expect(ra1?.deviceHash).toBeTruthy();
    expect(ra2?.deviceHash).toBe(ra1?.deviceHash);
    expect(rb1?.deviceHash).toBeTruthy();
    expect(rb1?.deviceHash).not.toBe(ra1?.deviceHash);
    expect(rn?.deviceHash).toBeTruthy();
    expect(rn?.deviceHash).not.toBe(ra1?.deviceHash);
  });
});

describe('repeat signups from one network are counted, whatever devices they name [AUD-1 row 301]', () => {
  it('a different named device every time: the Nth from one public network waits for a person', async () => {
    const net = freshNetwork();
    const threshold = await networkThreshold();
    const users = [];
    for (let i = 0; i < threshold; i += 1) users.push(await signup(`dev-${nanoid(12)}`, `${net}.${(i % 250) + 1}`));
    const last = users[users.length - 1]!;
    const action = await app.prisma.enforcementAction.findFirst({ where: { accountId: last.id } });
    expect(action?.reasonCode).toBe('VELOCITY_NETWORK');
    expect(action?.signalsFired).toEqual([{ type: 'IP_SUBNET', windowHours: 24, signups: threshold, threshold, deviceHeader: 'sent' }]);
    expect((await hasActiveHold(app.prisma, users[threshold - 2]!.id)).held).toBe(false);
  });

  it('the threshold is the platform setting ipFlagThreshold24h, read on every signup', async () => {
    await withNetworkThreshold(4, async () => {
      const net = freshNetwork();
      const users = [];
      for (let i = 0; i < 4; i += 1) users.push(await signup(null, `${net}.${i + 1}`));
      expect((await hasActiveHold(app.prisma, users[2]!.id)).held).toBe(false);
      expect((await hasActiveHold(app.prisma, users[3]!.id)).held).toBe(true);
      const action = await app.prisma.enforcementAction.findFirst({ where: { accountId: users[3]!.id } });
      expect(action?.signalsFired).toEqual([{ type: 'IP_SUBNET', windowHours: 24, signups: 4, threshold: 4, deviceHeader: 'missing' }]);
    });
  });

  it('one device past its own limit on a busy network: one hold, both signals, the device reason', async () => {
    await withNetworkThreshold(3, async () => {
      const net = freshNetwork();
      const device = `dev-${nanoid(12)}`;
      const users = [];
      for (let i = 0; i < 3; i += 1) users.push(await signup(device, `${net}.${i + 1}`));
      const actions = await app.prisma.enforcementAction.findMany({ where: { accountId: users[2]!.id } });
      expect(actions).toHaveLength(1);
      expect(actions[0]!.reasonCode).toBe('VELOCITY_DEVICE');
      expect(actions[0]!.signalsFired).toEqual([
        { type: 'DEVICE', windowHours: 24, signups: 3, threshold: 3 },
        { type: 'IP_SUBNET', windowHours: 24, signups: 3, threshold: 3, deviceHeader: 'sent' },
      ]);
    });
  });
});

describe('only a public source address is a network', () => {
  it('signups from our own side of the proxy are recorded, and never put anyone on hold', async () => {
    const threshold = await networkThreshold();
    // One private /24 of this run's own, past the threshold: counted as a network it would hold the last.
    const net = `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
    const users = [];
    for (let i = 0; i < threshold + 1; i += 1) users.push(await signup(null, `${net}.${(i % 250) + 1}`));
    for (const u of users) expect((await hasActiveHold(app.prisma, u.id)).held).toBe(false);
    expect((await attemptOf(users[0]!.phone))?.ipHash).toBe(hashSignal(`${net}.0/24`));
    const loopback = await signup(null, '127.0.0.1');
    expect((await hasActiveHold(app.prisma, loopback.id)).held).toBe(false);
    expect((await attemptOf(loopback.phone))?.ipHash).toBe(hashSignal('127.0.0.0/24'));
  });

  it('loopback, private, link-local, carrier-shared and unique-local addresses are not public; real ones are', () => {
    for (const ip of ['127.0.0.1', '10.4.5.6', '172.16.0.1', '172.31.255.254', '192.168.1.20', '100.64.3.4', '169.254.10.1', '0.0.0.0',
      '::1', '::', 'fe80::1', 'fd12:3456::9', '::ffff:10.0.0.7', '::ffff:127.0.0.1', '', 'not-an-ip']) {
      expect(isPublicNetworkAddress(ip), ip).toBe(false);
    }
    for (const ip of ['190.83.44.129', '172.32.0.1', '100.128.0.1', '8.8.8.8', '2800:3f0:4001:80a::200e', '::ffff:190.83.44.129']) {
      expect(isPublicNetworkAddress(ip), ip).toBe(true);
    }
  });

  it('an IPv6 network is its /64 however the address is written; a mapped IPv4 address is its /24', () => {
    const net = normalizeIpSubnet('2800:3f0:4001:80a::200e');
    expect(net).toBe('2800:03f0:4001:080a::/64');
    expect(normalizeIpSubnet('2800:03F0:4001:080A:0:0:0:1')).toBe(net);
    expect(normalizeIpSubnet('2800:3f0:4001:80a:ffff:1:2:3')).toBe(net);
    expect(normalizeIpSubnet('2800:3f0:4001:80b::1')).not.toBe(net);
    expect(normalizeIpSubnet('2001:db8::')).toBe('2001:0db8:0000:0000::/64');
    expect(normalizeIpSubnet('::ffff:190.83.44.129')).toBe('190.83.44.0/24');
    expect(normalizeIpSubnet('190.83.44.129')).toBe('190.83.44.0/24');
  });
});

describe('the route takes the source address the TRUST_PROXY way, never from a raw X-Forwarded-For', () => {
  async function register(instance: FastifyInstance, remoteAddress: string, forwardedFor: string) {
    const phone = testPhone();
    const proof = await registrationProofFor(instance, phone);
    const res = await instance.inject({
      method: 'POST', url: '/api/v1/auth/register', remoteAddress,
      headers: { 'x-forwarded-for': forwardedFor },
      payload: { phone, registrationProof: proof, firstName: 'Net', lastName: `Route${nanoid(4)}`, acceptTerms: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    userIds.push(res.json().data.user.id);
    phones.push(phone);
    return attemptOf(phone);
  }

  it('trusting no proxy: a forged X-Forwarded-For does not move the signup to another network', async () => {
    const [client, forged] = [freshNetwork(), freshNetwork()];
    const row = await register(app, `${client}.7`, `${forged}.9`);
    expect(row?.ipHash).toBe(hashSignal(`${client}.0/24`));
  });

  it('behind a proxy we were told to trust: the address it forwards is the network', async () => {
    const client = freshNetwork();
    const row = await register(behindProxy, '127.0.0.1', `${client}.9`);
    expect(row?.ipHash).toBe(hashSignal(`${client}.0/24`));
  });
});
