import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withVehiclePhotosScanned } from '../lib/photo-scan-filter';

// [Row 312 · COORD 23 Oct, ruling (a) for vehicle photos] The admin response filter: a vehicle photo
// owed a scan, failed or gone is withheld at any depth; a lookup error withholds them all.
const db = (rows: Array<{ fileKey: string | null; result: string | null }> | Error) => {
  const findMany = vi.fn(async () => { if (rows instanceof Error) throw rows; return rows; });
  return { prisma: { uploadScanDebt: { findMany } } as never, findMany };
};

describe('[Row 312] vehicle photos in admin responses', () => {
  it('withholds owed / failed / gone photos at any depth, keeps scanned ones, one query for the response', async () => {
    const { prisma, findMany } = db([
      { fileKey: 'vehicles/a/car.jpg', result: null },
      { fileKey: '/uploads/vehicles/b/car.jpg', result: 'UNSCANNABLE' },
      { fileKey: 'vehicles/c/car.jpg', result: 'GONE' },
      { fileKey: 'vehicles/d/car.jpg', result: 'CLEAN' },
    ]);
    const out = await withVehiclePhotosScanned(prisma, { success: true, data: {
      list: [{ id: 1, vehiclePhotoUrl: '/uploads/vehicles/a/car.jpg' }, { id: 2, vehiclePhotoUrl: 'vehicles/b/car.jpg' }],
      order: { rider: { vehiclePhotoUrl: 'vehicles/c/car.jpg' }, driver: { vehiclePhotoUrl: 'vehicles/d/car.jpg' } },
      other: { vehiclePhotoUrl: 'vehicles/e/car.jpg', at: new Date(0) },
    } });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(out.data.list).toEqual([{ id: 1, vehiclePhotoUrl: null, vehiclePhotoScan: 'AWAITING' }, { id: 2, vehiclePhotoUrl: null, vehiclePhotoScan: 'FAILED' }]);
    expect(out.data.order.rider).toEqual({ vehiclePhotoUrl: null, vehiclePhotoScan: 'GONE' });
    expect(out.data.order.driver).toEqual({ vehiclePhotoUrl: 'vehicles/d/car.jpg' });
    expect(out.data.other).toEqual({ vehiclePhotoUrl: 'vehicles/e/car.jpg', at: new Date(0) });
  });

  it('a lookup error withholds every photo (fail closed); no photo in the response means no query', async () => {
    const broken = db(new Error('db down'));
    const out = await withVehiclePhotosScanned(broken.prisma, { data: [{ vehiclePhotoUrl: 'vehicles/x/car.jpg' }] });
    expect(out.data).toEqual([{ vehiclePhotoUrl: null, vehiclePhotoScan: 'AWAITING' }]);
    const none = db([]);
    const same = { data: [{ vehiclePhotoUrl: null }, { name: 'x' }] };
    expect(await withVehiclePhotosScanned(none.prisma, same)).toBe(same);
    expect(none.findMany).not.toHaveBeenCalled();
  });

  it('[REVIEW-G S4-1] a null-prototype container is walked like any object (as the legacy pointer walker does)', async () => {
    const { prisma } = db([{ fileKey: 'vehicles/n/car.jpg', result: null }]);
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { vehiclePhotoUrl: 'vehicles/n/car.jpg', plate: 'PAA 1' });
    const out = await withVehiclePhotosScanned(prisma, { data: { rider: bare } });
    expect({ ...(out.data.rider as Record<string, unknown>) }).toEqual({ vehiclePhotoUrl: null, vehiclePhotoScan: 'AWAITING', plate: 'PAA 1' });
  });

  it('[ruling 01:28Z] the client-written profilePhotoUrl pointer is held to the same rule (it can name any upload)', async () => {
    const { prisma } = db([{ fileKey: 'liveness/u1/selfie.jpg', result: null }, { fileKey: 'vehicles/p/car.jpg', result: 'FOUND' }]);
    const out = await withVehiclePhotosScanned(prisma, { rider: { profilePhotoUrl: '/uploads/liveness/u1/selfie.jpg', vehiclePhotoUrl: 'vehicles/p/car.jpg' }, other: { profilePhotoUrl: 'avatars/u2/me.jpg' } });
    expect(out.rider).toEqual({ profilePhotoUrl: null, profilePhotoScan: 'AWAITING', vehiclePhotoUrl: null, vehiclePhotoScan: 'FAILED' });
    expect(out.other).toEqual({ profilePhotoUrl: 'avatars/u2/me.jpg' });
  });
});

describe('[Row 312 · ruling 01:28Z] the filter is wired on every surface', () => {
  const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
  it('app.ts registers it before any route; every order-room socket event goes through it', () => {
    const app = src('app.ts');
    const at = app.indexOf('registerUploadPhotoScan(app)');
    expect(at, 'app.ts must call registerUploadPhotoScan(app)').toBeGreaterThan(-1);
    expect(at).toBeLessThan(app.indexOf("await app.register(authRoutes"));
  });

  // The order room: the customer's ride and delivery cards over the socket.
  const room = (debt: unknown) => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const socket = { id: 's1', data: { tenantId: 't1', userId: 'cust', authorizationExpiresAtMs: Date.now() + 60_000 }, leave: async () => undefined };
    const io = { in: () => ({ fetchSockets: async () => [socket] }), to: () => ({ emit: (event: string, payload: unknown) => { emitted.push({ event, payload }); } }) };
    const db: Record<string, unknown> = {
      order: { findUnique: async () => ({ tenantId: 't1', customerId: 'cust', rider: null, driver: null, vendor: null, holdExpiresAt: null, cancelledAt: null, paymentMethod: 'CASH' }) },
      chatRoom: { findMany: async () => [] },
    };
    if (debt !== undefined) db['uploadScanDebt'] = debt;
    return { io, db, emitted };
  };
  it('an order-room event withholds an owed photo (plate kept); without the debt table it withholds (fail closed) and touches nothing when no photo rides along', async () => {
    const { emitToOrderRoom } = await import('../modules/order/order-room-emission.service');
    const owed = room({ findMany: async () => [{ fileKey: 'vehicles/z/car.jpg', result: null }] });
    await emitToOrderRoom(owed.db as never, owed.io as never, 'o1', 'order:status_changed', { driver: { vehiclePhotoUrl: '/uploads/vehicles/z/car.jpg', licensePlate: 'PAA 1' } });
    expect(owed.emitted).toEqual([{ event: 'order:status_changed', payload: { driver: { vehiclePhotoUrl: null, vehiclePhotoScan: 'AWAITING', licensePlate: 'PAA 1' } } }]);
    const blind = room(undefined);
    await emitToOrderRoom(blind.db as never, blind.io as never, 'o1', 'order:status_changed', { driver: { vehiclePhotoUrl: 'vehicles/z/car.jpg' } });
    expect(blind.emitted[0]!.payload).toEqual({ driver: { vehiclePhotoUrl: null, vehiclePhotoScan: 'AWAITING' } });
    const plain = room(undefined);
    const tripwire = new Proxy(plain.db, { get: (target, prop) => { if (prop === 'uploadScanDebt') throw new Error('touched the debt table'); return target[prop as string]; } });
    await emitToOrderRoom(tripwire as never, plain.io as never, 'o1', 'order:status_changed', { status: 'PICKED_UP' });
    expect(plain.emitted).toEqual([{ event: 'order:status_changed', payload: { status: 'PICKED_UP' } }]);
  });
});
