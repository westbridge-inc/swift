import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaPlugin } from '../plugins/prisma';
import { testPhone } from './helpers/fixture-ids';
import { moverPool } from './helpers/mover-pool';

// [AUD-G7-042] A suite that empties the dispatch pool puts every mover that
// was there before it back as it was — and never puts its own back online.

let app: FastifyInstance;
const userIds: string[] = [];

async function onlineRider(): Promise<string> {
  const user = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Pool', lastName: 'Rider', roles: ['MOVER'], activeRole: 'MOVER', isPhoneVerified: true } });
  userIds.push(user.id);
  // An online mover owns a location session (riders_online_requires_location_owner).
  const rider = await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE', isOnline: true, isAvailable: true, locationSessionId: `g7-042-${user.id}` } });
  return rider.id;
}
const state = (id: string) => app.prisma.rider.findUniqueOrThrow({ where: { id }, select: { isOnline: true, isAvailable: true } });

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
});

afterAll(async () => {
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[AUD-G7-042] the mover pool', () => {
  it('empties the pool by id and restores only the movers that were there before the suite', async () => {
    const foreign = await onlineRider();
    const pool = moverPool(app.prisma, 'rider');
    await pool.begin();
    const own = await onlineRider();

    await pool.empty();
    expect(await state(foreign)).toEqual({ isOnline: false, isAvailable: false });
    expect(await state(own)).toEqual({ isOnline: false, isAvailable: false });

    expect(await pool.restore()).toBeGreaterThanOrEqual(1);
    expect(await state(foreign)).toEqual({ isOnline: true, isAvailable: true });
    expect(await state(own)).toEqual({ isOnline: false, isAvailable: false });
  });

  it('remembers a mover\'s state from the FIRST time it emptied the pool', async () => {
    const foreign = await onlineRider();
    const pool = moverPool(app.prisma, 'rider');
    await pool.begin();
    await pool.empty({ isOnline: false });
    await pool.empty();
    await pool.restore();
    expect(await state(foreign)).toEqual({ isOnline: true, isAvailable: true });
  });

  it('refuses to empty before it knows who was there first', async () => {
    await expect(moverPool(app.prisma, 'rider').empty()).rejects.toThrow(/begin\(\)/);
  });
});
