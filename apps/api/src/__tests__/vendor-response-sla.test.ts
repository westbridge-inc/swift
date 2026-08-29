import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import {
  vendorResponseSlaMinutes,
  AUTO_REJECT_KEY,
  DEFAULT_VENDOR_RESPONSE_SLA_MINUTES,
} from '../modules/order/response-sla';

// ---------------------------------------------------------------------------
// `order_auto_reject_minutes` was seeded from the beginning, rendered by the
// admin config page as an editable field, and read by NOTHING — the deadline
// was actually pinned to an environment variable. These tests pin the fix:
// the dashboard field is now the control it always appeared to be, and it
// cannot break the deadline it exists to tune.
// ---------------------------------------------------------------------------

describe('vendor response SLA — the admin field is the real control', () => {
  let app: FastifyInstance;
  let original: unknown;
  const envBefore = process.env['VENDOR_RESPONSE_SLA_MINUTES'];

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(prismaPlugin);
    await app.ready();
    original = (await app.prisma.platformConfig.findUnique({ where: { key: AUTO_REJECT_KEY } }))?.value;
  });

  afterEach(async () => {
    if (envBefore === undefined) delete process.env['VENDOR_RESPONSE_SLA_MINUTES'];
    else process.env['VENDOR_RESPONSE_SLA_MINUTES'] = envBefore;
    if (original !== undefined) {
      await app.prisma.platformConfig.update({
        where: { key: AUTO_REJECT_KEY },
        data: { value: original as never },
      });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const setConfig = (value: unknown) =>
    app.prisma.platformConfig.upsert({
      where: { key: AUTO_REJECT_KEY },
      update: { value: value as never },
      create: { key: AUTO_REJECT_KEY, value: value as never },
    });

  it('uses the seeded value — 5 minutes', async () => {
    expect(await vendorResponseSlaMinutes(app.prisma)).toBe(5);
  });

  it('an operator editing the dashboard field actually changes the deadline', async () => {
    // The whole point. Before the fix this assertion could not be written:
    // the value was read from an env var and the field did nothing.
    await setConfig(20);
    expect(await vendorResponseSlaMinutes(app.prisma)).toBe(20);
  });

  it('config beats the environment variable', async () => {
    process.env['VENDOR_RESPONSE_SLA_MINUTES'] = '10';
    await setConfig(30);
    expect(await vendorResponseSlaMinutes(app.prisma)).toBe(30);
  });

  it('falls back to the env var when the row is absent', async () => {
    process.env['VENDOR_RESPONSE_SLA_MINUTES'] = '12';
    await app.prisma.platformConfig.deleteMany({ where: { key: AUTO_REJECT_KEY } });
    expect(await vendorResponseSlaMinutes(app.prisma)).toBe(12);
    await setConfig(original ?? 5);
  });

  it('a nonsense value NEVER disables the deadline — it falls back', async () => {
    // Fail-safe, not fail-closed: "no deadline" means orders hang in PENDING
    // forever and a customer waits with no answer. A bad config row must not
    // be able to break the safety net it was added to tune.
    delete process.env['VENDOR_RESPONSE_SLA_MINUTES'];
    for (const bad of [0, -5, 'abc', null, 100000, 0.5]) {
      await setConfig(bad);
      const got = await vendorResponseSlaMinutes(app.prisma);
      expect(got, `value ${JSON.stringify(bad)} must fall back, not disable`).toBe(
        DEFAULT_VENDOR_RESPONSE_SLA_MINUTES,
      );
      expect(got).toBeGreaterThan(0);
    }
  });

  it('accepts the documented range and rejects outside it', async () => {
    await setConfig(1);
    expect(await vendorResponseSlaMinutes(app.prisma)).toBe(1);
    await setConfig(1440);
    expect(await vendorResponseSlaMinutes(app.prisma)).toBe(1440);
    await setConfig(1441);
    expect(await vendorResponseSlaMinutes(app.prisma)).toBe(DEFAULT_VENDOR_RESPONSE_SLA_MINUTES);
  });
});
