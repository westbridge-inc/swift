import { describe, expect, it, vi } from 'vitest';
import { withVehiclePhotosScanned } from '../modules/admin/vehicle-photo-scan';

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
});
