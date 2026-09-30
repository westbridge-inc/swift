import type { VehicleKind } from '../services/api';

// [Launch vehicle list · owner 2026-09-24] Which vehicles a mover can register or
// switch to. The SERVER decides (apps/api/src/config/vehicle-classes.ts
// isVehicleOffered): /become, the change route and GO all refuse a vehicle that is
// not offered, and every quote in the price list carries `offered`. The app follows
// that flag once the list has loaded. Until then (or from an older server that
// predates the flag) it falls back to the launch list below, which
// vehicleOffer.test.ts keeps equal to the server's.

/** Mirror of the server's LAUNCH_HIDDEN_VEHICLE_TYPES: canters and box trucks. */
export const LAUNCH_HIDDEN_VEHICLE_KINDS: readonly VehicleKind[] = ['CANTER_SHORT', 'CANTER_LONG', 'BOX_TRUCK_SHORT', 'BOX_TRUCK_LONG'];

type PricingLike = { movers?: ReadonlyArray<{ vehicleType?: string; offered?: unknown } | null | undefined> } | null | undefined;

/** Can a mover pick this vehicle today? The loaded price list's flag wins; the launch list answers until it arrives. */
export function vehicleOffered(kind: VehicleKind, pricing?: PricingLike): boolean {
  const quote = Array.isArray(pricing?.movers) ? pricing!.movers!.find((q) => q?.vehicleType === kind) : undefined;
  if (quote && typeof quote.offered === 'boolean') return quote.offered;
  return !LAUNCH_HIDDEN_VEHICLE_KINDS.includes(kind);
}

/** What the vehicle screens say, in one place. */
export const VEHICLE_COPY = {
  notOffered: 'Swift isn’t taking canters and box trucks at launch. Change your vehicle to keep going.',
  changeWarning: 'A new vehicle needs its own documents. Changing takes you offline until they’re approved; your personal documents stay.',
  saved: 'Vehicle saved',
  change: 'Change vehicle',
  saveNew: 'Save new vehicle',
} as const;
