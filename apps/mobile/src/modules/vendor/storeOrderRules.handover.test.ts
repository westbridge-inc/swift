import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canMarkHandedToRider, handoverNeedsNoCode } from './storeOrderRules';
import { HANDOVER_WORDS, pickupCheckWords, riderHandoverLine, riderPhotoUrl } from './storeHandover';
import { cardTapFor } from './boardTaps';

// ---------------------------------------------------------------------------
// [STORE-DASH · owner ruling 22 Oct 19:45Z, O-2] The store's hand-overs, on the
// server's contract (STORE-FLOW O-2):
//   - takeaway: the store's "Ask for the pickup code" is OFF by default; the
//     server says per order (pickupCodeRequired). Off = "Handed to customer"
//     in one tap after checking the first name and the order number (PUT
//     complete-pickup with no code). On, or an older server that says nothing
//     = today's typed code;
//   - delivery with a Swift rider: "Handed to rider" (PUT handed-to-rider) once
//     the rider is assigned, with the rider's photo, first name and vehicle to
//     check. Only when the server knows the step (the order carries
//     handedToRiderAt), so an older server never gets a request it cannot answer.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const rider = { user: { firstName: 'Devon' }, vehicleType: 'MOTORCYCLE', vehicleMake: 'Honda', vehicleModel: 'CG125', vehicleColor: 'Red', licensePlate: 'PAB 1234', photoUrl: 'https://cdn.test/signed/rider.jpg?sig=1' };
const delivery = (extra: Record<string, unknown> = {}) => ({
  status: 'RIDER_ARRIVED_PICKUP', fulfillment: 'DELIVERY', fulfillmentMode: 'PLATFORM_RIDER', riderId: 'r-1', rider, handedToRiderAt: null, ...extra,
});

describe('[O-2] the takeaway hand-over needs a code only when the store asks for one', () => {
  it('the setting is off for this order: no code', () => {
    expect(handoverNeedsNoCode({ pickupCodeRequired: false })).toBe(true);
  });
  it('the setting is on: the typed code, as today', () => {
    expect(handoverNeedsNoCode({ pickupCodeRequired: true })).toBe(false);
  });
  it('an older server that sends no field: the code is still needed (never a request it refuses)', () => {
    expect(handoverNeedsNoCode({})).toBe(false);
    expect(handoverNeedsNoCode({ pickupCodeRequired: undefined })).toBe(false);
    expect(handoverNeedsNoCode({ pickupCodeRequired: null })).toBe(false);
    expect(handoverNeedsNoCode(null)).toBe(false);
    expect(handoverNeedsNoCode(undefined)).toBe(false);
  });
});

describe('[O-2] when "Handed to rider" may be tapped', () => {
  it('a Swift-rider delivery whose rider is assigned, on the way or at the store, or a ready order with its rider', () => {
    for (const status of ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP', 'READY_FOR_PICKUP']) {
      expect(canMarkHandedToRider(delivery({ status })), status).toBe(true);
    }
    // the platform rider is the default when the mode is not set
    expect(canMarkHandedToRider(delivery({ fulfillmentMode: null }))).toBe(true);
    // the rider's id alone is enough (the board may not carry the rider row)
    expect(canMarkHandedToRider(delivery({ rider: null }))).toBe(true);
  });
  it('no rider yet: not offered (the server would answer NO_RIDER_YET)', () => {
    expect(canMarkHandedToRider(delivery({ riderId: null, rider: null, status: 'READY_FOR_PICKUP' }))).toBe(false);
  });
  it('already marked: not offered again', () => {
    expect(canMarkHandedToRider(delivery({ handedToRiderAt: '2026-10-23T10:00:00.000Z' }))).toBe(false);
  });
  it('an older server (no handedToRiderAt field): never offered', () => {
    const old: Record<string, unknown> = delivery();
    delete old['handedToRiderAt'];
    expect(canMarkHandedToRider(old)).toBe(false);
  });
  it('not a Swift-rider delivery: takeaway, the store\'s own delivery, an appointment', () => {
    expect(canMarkHandedToRider(delivery({ fulfillment: 'PICKUP' }))).toBe(false);
    expect(canMarkHandedToRider(delivery({ fulfillmentMode: 'VENDOR_DELIVERY' }))).toBe(false);
    expect(canMarkHandedToRider(delivery({ fulfillment: 'APPOINTMENT' }))).toBe(false);
  });
  it('after the rider\'s "Picked up", or a closed order: not offered', () => {
    for (const status of ['PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'PENDING', 'ACCEPTED', 'PREPARING']) {
      expect(canMarkHandedToRider(delivery({ status })), status).toBe(false);
    }
  });
  it('nothing at all: not offered', () => {
    expect(canMarkHandedToRider(null)).toBe(false);
    expect(canMarkHandedToRider(undefined)).toBe(false);
  });
});

describe('[O-2] what the store checks at the hand-over', () => {
  it('the rider\'s first name and vehicle: colour make model · plate', () => {
    expect(riderHandoverLine(rider)).toBe('Devon — Red Honda CG125 · PAB 1234');
  });
  it('the vehicle type stands in when make and model are missing', () => {
    expect(riderHandoverLine({ user: { firstName: 'Devon' }, vehicleType: 'MOTORCYCLE' })).toBe('Devon — Motorcycle');
    expect(riderHandoverLine({ vehicleType: 'MOTOR_BIKE' })).toBe('Motor bike');
  });
  it('only what was sent; nothing when nothing was sent', () => {
    expect(riderHandoverLine({ user: { firstName: '  ' }, licensePlate: 'PAB 1234' })).toBe('PAB 1234');
    expect(riderHandoverLine({ user: { firstName: 'Devon' } })).toBe('Devon');
    expect(riderHandoverLine({})).toBeNull();
    expect(riderHandoverLine(null)).toBeNull();
  });
  it('the photo only as the server\'s resolved web address — never a raw storage key', () => {
    expect(riderPhotoUrl(rider)).toBe('https://cdn.test/signed/rider.jpg?sig=1');
    expect(riderPhotoUrl({ photoUrl: 'riders/r-1/photo.jpg' })).toBeNull();
    expect(riderPhotoUrl({ photoUrl: '' })).toBeNull();
    expect(riderPhotoUrl({ photoUrl: null })).toBeNull();
    expect(riderPhotoUrl(undefined)).toBeNull();
  });
  it('the name check reads the first name and the order number', () => {
    expect(HANDOVER_WORDS.checkName('Asha', 'SW-1001')).toBe('Check the name before you hand it over: Asha · order #SW-1001');
    expect(HANDOVER_WORDS.checkName('Asha', 1001)).toBe('Check the name before you hand it over: Asha · order #1001');
  });
  it('[REVIEW-F S4-2 on #2054] only what the store can check: no name = the number; no number = the name', () => {
    expect(HANDOVER_WORDS.checkName(null, 'SW-1001')).toBe('Check the order number before you hand it over: order #SW-1001');
    expect(HANDOVER_WORDS.checkName('  ', 'SW-1001')).toBe('Check the order number before you hand it over: order #SW-1001');
    expect(HANDOVER_WORDS.checkName('Asha', null)).toBe('Check the name before you hand it over: Asha');
    expect(HANDOVER_WORDS.checkName(undefined, '')).toBe('Check who is collecting before you hand it over.');
  });
});

describe('[REVIEW-F S3-1 on #2054] the takeaway line never prompts a hand-over on a paused order', () => {
  const pickup = (extra: Record<string, unknown> = {}) => ({ status: 'READY_FOR_PICKUP', fulfillment: 'PICKUP', customer: { firstName: 'Asha' }, orderNumber: 'SW-1001', ...extra });
  const paused = { paymentMethod: 'MOBILE_MONEY', mmgClaimMismatchAt: '2026-10-23T09:00:00.000Z' };
  it('code off: the name and order-number check', () => {
    expect(pickupCheckWords(pickup({ pickupCodeRequired: false }))).toBe('Check the name before you hand it over: Asha · order #SW-1001');
  });
  it('code off on an order paused for an MMG payment review: no hand-over prompt', () => {
    expect(pickupCheckWords(pickup({ pickupCodeRequired: false, ...paused }))).toBe('The customer collects this order.');
  });
  it('code on, or an older server: null (the screen keeps its code words)', () => {
    expect(pickupCheckWords(pickup({ pickupCodeRequired: true }))).toBeNull();
    expect(pickupCheckWords(pickup())).toBeNull();
    expect(pickupCheckWords(null)).toBeNull();
  });
});

describe('[#2033 REVIEW-F S4-2 · O-2] the card\'s hand-overs are one tap', () => {
  it('"Handed to customer" (code off) and "Handed to rider" go to the server from the card', () => {
    expect(cardTapFor('handed-to-customer')).toBe('send');
    expect(cardTapFor('handed-to-rider')).toBe('send');
  });
  it('the code hand-over still opens the order, where the code is typed', () => {
    expect(cardTapFor('complete-pickup')).toBe('open');
  });
});

describe('[O-2] the phone sends the right request for each', () => {
  const hooks = read('src/hooks/vendorops.ts');
  const api = read('src/services/api.ts');
  it('"Handed to customer" completes the pickup with NO code; "Handed to rider" is its own request', () => {
    expect(hooks).toMatch(/if \(action === 'handed-to-customer'\) return unwrap\(vendorApi\.completePickup\(id\)\);/);
    expect(hooks).toMatch(/if \(action === 'handed-to-rider'\) return unwrap\(vendorApi\.handedToRider\(id\)\);/);
    expect(api).toMatch(/handedToRider: \(id: string\) => api\.put\(`\/vendor\/orders\/\$\{id\}\/handed-to-rider`, \{\}\)/);
  });
  it('the setting rides the store profile and refreshes the cards', () => {
    expect(hooks).toMatch(/vendorApi\.updateProfile\(\{ requirePickupCode \}\)/);
    const hook = hooks.slice(hooks.indexOf('export function useSetRequirePickupCode('), hooks.indexOf('export function useSetSelfDelivery('));
    expect(hook).toMatch(/queryKey: \['vendor', 'orders'\]/);
  });
  it('[REVIEW-F S3-1/S4-1 on #2054] the board card shows the rider check only beside its "Handed to rider" button, and the takeaway line through pickupCheckWords', () => {
    const board = read('src/modules/vendor/screens/VendorOps.tsx');
    expect(board).toMatch(/\{actions\.some\(\(a\) => a\.action === 'handed-to-rider'\) \? <RiderHandoverLine rider=\{order\.rider\} \/> : null\}/);
    expect(board).toMatch(/\{pickupCheckWords\(order\) \?\? 'Ask the customer for their code at collection'\}/);
    expect(board).not.toMatch(/canMarkHandedToRider\(order\) \? <RiderHandoverLine/);
  });
  it('the tap\'s answer writes handedToRiderAt into the order\'s caches', () => {
    expect(hooks).toMatch(/const CONFIRMED_ORDER_FIELDS = \[[^\]]*'handedToRiderAt'/);
  });
});
