import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAUNCH_HIDDEN_VEHICLE_KINDS, vehicleOffered } from './vehicleOffer';

// ---------------------------------------------------------------------------
// [Launch vehicle list · owner 2026-09-24] "take out extra vehicles like truck,
// never ever did i say rider". Canters and box trucks are hidden; bicycle,
// motorbike, car, wagon (estate) car and both buses stay. The server decides
// (config/vehicle-classes isVehicleOffered, enforced at /become, the change route
// and GO); the app mirrors its list until the price list's `offered` flags arrive.
// ---------------------------------------------------------------------------

const API_CLASSES = readFileSync(join(process.cwd(), '../api/src/config/vehicle-classes.ts'), 'utf8');

describe('the launch vehicle list', () => {
  it('the app hides exactly what the server hides', () => {
    const block = /LAUNCH_HIDDEN_VEHICLE_TYPES[^=]*=\s*new Set<VehicleType>\(\[([\s\S]*?)\]\)/.exec(API_CLASSES)?.[1];
    expect(block, 'the server list moved or was renamed — keep the app in step with it').toBeTruthy();
    const serverHidden = [...block!.matchAll(/'([A-Z_0-9]+)'/g)].map((m) => m[1]).sort();
    expect([...LAUNCH_HIDDEN_VEHICLE_KINDS].sort()).toEqual(serverHidden);
    expect(serverHidden).toEqual(['BOX_TRUCK_LONG', 'BOX_TRUCK_SHORT', 'CANTER_LONG', 'CANTER_SHORT']);
  });

  it('before the price list loads, every rider and driver vehicle is offered and the four heavy ones are not', () => {
    for (const kind of ['BICYCLE', 'MOTORCYCLE', 'CAR', 'WAGON_CAR', 'BUS_9', 'BUS_15'] as const) expect(vehicleOffered(kind)).toBe(true);
    for (const kind of LAUNCH_HIDDEN_VEHICLE_KINDS) expect(vehicleOffered(kind)).toBe(false);
  });

  it('the loaded price list is the authority: its flag wins in both directions', () => {
    const pricing = { movers: [{ vehicleType: 'CANTER_SHORT', offered: true }, { vehicleType: 'BUS_15', offered: false }] };
    expect(vehicleOffered('CANTER_SHORT', pricing)).toBe(true);
    expect(vehicleOffered('BUS_15', pricing)).toBe(false);
    // A vehicle the list does not mention, or an older server without the flag, falls back to the launch list.
    expect(vehicleOffered('BOX_TRUCK_LONG', pricing)).toBe(false);
    expect(vehicleOffered('MOTORCYCLE', { movers: [{ vehicleType: 'MOTORCYCLE' }] })).toBe(true);
    expect(vehicleOffered('CANTER_LONG', { movers: [{ vehicleType: 'CANTER_LONG' }] })).toBe(false);
  });
});
