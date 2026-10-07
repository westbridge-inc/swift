import { describe, it, expect } from 'vitest';
import {
  previewMutation,
  previewQuery,
  PREVIEW_PROFILE,
  PREVIEW_DAILY_EARNINGS,
  PREVIEW_VERIFICATION,
  PREVIEW_ACTIVE_JOB,
} from './moverPreviewData';
import * as PV from './moverPreviewData';
import { useMoverPreview } from '../stores/moverPreview';

// Earner PREVIEW (R3 + invariant 3): the whole guarantee is that preview is
// READ-ONLY — it never writes server state, moves money, or goes truly online.
// The data hooks return previewQuery(sample); every mutation returns
// previewMutation(). These pin that contract at the source.

describe('earner preview — read-only invariant (R3 / invariant 3)', () => {
  it('previewMutation is a true no-op: mutate + mutateAsync write nothing and never throw', async () => {
    const m = previewMutation();
    expect(m.isPending).toBe(false);
    expect(m.isSuccess).toBe(false);
    // Calling it must do nothing and cannot throw — this IS "zero mutations".
    expect(() => m.mutate({ id: 'x', fare: 999 })).not.toThrow();
    await expect(m.mutateAsync()).resolves.toBeUndefined();
    expect(m.data).toBeUndefined();
  });

  it('previewQuery resolves immediately with the sample data (never loading/erroring)', () => {
    const q = previewQuery(PREVIEW_PROFILE);
    expect(q.data).toBe(PREVIEW_PROFILE);
    expect(q.isLoading).toBe(false);
    expect(q.isError).toBe(false);
    expect(q.isSuccess).toBe(true);
  });
});

describe('earner preview — sample data is shaped for the REAL screens', () => {
  it('the sample mover is online + verified so Home shows the earning experience, not a KYC/GO wall', () => {
    expect(PREVIEW_PROFILE.isOnline).toBe(true); // MoverHomeScreen: online = !!profile?.isOnline
    expect(PREVIEW_VERIFICATION.roleVerified).toBe(true); // GO gate reads eligible
  });

  it('the 7-day trend has exactly one "today" (the last bar) for the Home chart', () => {
    expect(PREVIEW_DAILY_EARNINGS).toHaveLength(7);
    expect(PREVIEW_DAILY_EARNINGS.filter((d) => d.isToday)).toHaveLength(1);
    expect(PREVIEW_DAILY_EARNINGS.at(-1)?.isToday).toBe(true);
  });

  it('the sample active trip is an in-progress taxi ride so Active-trip is previewable', () => {
    expect(PREVIEW_ACTIVE_JOB.status).toBe('RIDE_IN_PROGRESS');
    expect(PREVIEW_ACTIVE_JOB.orderType).toBe('TAXI');
    // No phone on the sample passenger → the driver's tel: call button stays hidden.
    expect(PREVIEW_ACTIVE_JOB.customer.phone).toBeNull();
  });
});

describe('moverPreview store', () => {
  it('enter/exit toggles preview and remembers which earner face to show', () => {
    expect(useMoverPreview.getState().preview).toBe(false);
    useMoverPreview.getState().enterPreview('RIDER');
    expect(useMoverPreview.getState().preview).toBe(true);
    expect(useMoverPreview.getState().kind).toBe('RIDER');
    useMoverPreview.getState().exitPreview();
    expect(useMoverPreview.getState().preview).toBe(false);
  });
});

describe('earner preview — the sample weekly fee is the live quote, never a frozen number', () => {
  const quote = (vehicleType: string, role: string, band: string, tier: string, rate: number) => ({ vehicleType, label: vehicleType, role, band, tier, rate });
  const pricing = {
    countryCode: 'GY', currencyCode: 'GYD', currencySymbol: '$', isActive: true, trialDays: 14,
    movers: [quote('MOTORCYCLE', 'RIDER', 'STANDARD', 'courier', 8000), quote('CAR', 'DRIVER', 'STANDARD', 'taxi', 9000)],
    vendors: { service: 8000, catalogue: [{ minItems: 0, tier: 'small', rate: 15000 }] },
    franchise: null,
    weekly: { mover: 9000, moverHeavy: 9000, serviceVendor: 8000, smallVendor: 15000, largeVendor: 20000, departmentVendor: 60000 },
  };

  it('the static sample subscription carries no weekly fee of its own', () => {
    expect('weeklyRate' in PV.PREVIEW_SUBSCRIPTION).toBe(false);
    expect('customRate' in PV.PREVIEW_SUBSCRIPTION).toBe(false);
  });

  it('the sample taxi driver is billed the taxi quote for the sample car', () => {
    const sub = PV.previewSubscription(pricing as never);
    expect(sub).toMatchObject({ type: 'TAXI_DRIVER', status: 'ACTIVE', weeklyRate: 9000 });
    // The quote follows the list, so a re-price reaches the preview untouched.
    const repriced = { ...pricing, movers: [quote('CAR', 'DRIVER', 'STANDARD', 'taxi', 9500)] };
    expect(PV.previewSubscription(repriced as never)?.weeklyRate).toBe(9500);
  });

  it('no quote, no sample subscription — the fee is absent, never zero', () => {
    expect(PV.previewSubscription(undefined)).toBeNull();
    expect(PV.previewSubscription({ ...pricing, movers: undefined } as never)).toBeNull();
    expect(PV.previewSubscription({ ...pricing, movers: [quote('CAR', 'DRIVER', 'STANDARD', 'taxi', 0)] } as never)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [Owner, 1 Oct] A delivery RIDER previews their own dashboard too. Each face
// has its own sample, shaped exactly as its real endpoints answer, so the real
// rider screens render it through their normal paths (zero screen drift).
// ---------------------------------------------------------------------------
describe('earner preview — a sample for each face', () => {
  it('the rider sample is a delivery rider on a motorbike, in the rider endpoints’ own shapes', () => {
    const rider = PV.previewSample('RIDER');
    expect(rider.profile).toMatchObject({ isOnline: true, vehicleType: 'MOTORCYCLE', lastName: 'Rider' });
    // GET /rider/earnings/today names its count `deliveries` (lib/earnings.moverJobsToday).
    expect(rider.earningsToday).toMatchObject({ deliveries: 8, total: 5200 });
    // Today's bar is today's total.
    expect(rider.daily.at(-1)?.total).toBe(rider.earningsToday.total);
    // GET /rider/stats
    expect(rider.stats).toMatchObject({ todayDeliveries: 8, weekDeliveries: 60, onlineHoursToday: 4 });
    // GET /rider/demand: orders waiting at stores, never taxi requests.
    expect(rider.demand).toMatchObject({ ready: 3, soon: 2 });
    expect(rider.demand['stores'][0]).toMatchObject({ name: 'Sample Kitchen', ready: 2 });
    // A delivery in hand, not a taxi ride.
    expect(rider.activeJob).toMatchObject({ status: 'PICKED_UP', orderType: 'FOOD_DELIVERY', paymentMethod: 'CASH' });
    // Finished DELIVERIES (GET /rider/orders), not earning rows.
    expect(rider.history.data[0]).toMatchObject({ status: 'DELIVERED', totalEarning: 1000 });
  });

  it('the driver sample is a taxi driver on a car, in the driver endpoints’ own shapes', () => {
    const driver = PV.previewSample('DRIVER');
    expect(driver.profile).toBe(PREVIEW_PROFILE);
    expect(driver.profile).toMatchObject({ vehicleType: 'CAR' });
    // GET /driver/earnings/today names its count `ridesCompleted`.
    expect(driver.earningsToday).toMatchObject({ ridesCompleted: 6 });
    // GET /driver/demand: people waiting for a ride.
    expect(driver.demand).toMatchObject({ waiting: 5, watchers: 3 });
    expect(driver.activeJob).toBe(PREVIEW_ACTIVE_JOB);
    expect(driver.history.data[0]).toMatchObject({ status: 'DELIVERED', taxiFareTotal: 2000 });
  });

  it('both weeks have seven real days, today last, so the bars carry their day letters', () => {
    for (const kind of ['RIDER', 'DRIVER'] as const) {
      const week = PV.previewSample(kind).daily;
      expect(week).toHaveLength(7);
      expect(week.filter((d) => d.isToday)).toHaveLength(1);
      expect(week.at(-1)?.isToday).toBe(true);
      // MoverHomeScreen labels a bar from `${date}T12:00:00Z`; a weekday name there is "Invalid Date".
      for (const d of week) expect(Number.isNaN(new Date(`${d.date}T12:00:00Z`).getTime()), `${kind} ${d.date}`).toBe(false);
    }
  });

  it('every number is round Guyana dollars and every place is in Georgetown', () => {
    for (const kind of ['RIDER', 'DRIVER'] as const) {
      const s = PV.previewSample(kind);
      for (const day of s.daily) expect(day.total % 100, `${kind} daily`).toBe(0);
      expect(s.earningsToday.total % 100).toBe(0);
      expect(Math.abs(Number(s.activeJob['pickupLat']) - 6.8)).toBeLessThan(0.1);
      expect(Math.abs(Number(s.activeJob['pickupLng']) + 58.16)).toBeLessThan(0.1);
    }
  });
});

describe('earner preview — each face is billed its own live quote', () => {
  const quote = (vehicleType: string, role: string, band: string, tier: string, rate: number) => ({ vehicleType, label: vehicleType, role, band, tier, rate });
  // The Guyana list today: riders 6,000; taxi drivers 9,000 (8,000 once #1393 lands).
  const list = (riderRate: number, taxiRate: number) => ({
    countryCode: 'GY', currencyCode: 'GYD', currencySymbol: '$', isActive: true, trialDays: 14,
    movers: [
      quote('BICYCLE', 'RIDER', 'STANDARD', 'courier', riderRate),
      quote('MOTORCYCLE', 'RIDER', 'STANDARD', 'courier', riderRate),
      quote('CAR', 'DRIVER', 'STANDARD', 'taxi', taxiRate),
    ],
    vendors: { service: 8000, catalogue: [{ minItems: 0, tier: 'small', rate: 15000 }] },
    franchise: null,
  });

  it('the sample rider is billed the rider rate from the list, as a delivery rider', () => {
    expect(PV.previewSubscription(list(6000, 9000) as never, 'RIDER')).toMatchObject({ type: 'DELIVERY_RIDER', weeklyRate: 6000 });
    // A re-price reaches the preview untouched.
    expect(PV.previewSubscription(list(6500, 9000) as never, 'RIDER')?.weeklyRate).toBe(6500);
  });

  it('the sample driver is billed the taxi rate from the list', () => {
    expect(PV.previewSubscription(list(6000, 9000) as never, 'DRIVER')).toMatchObject({ type: 'TAXI_DRIVER', weeklyRate: 9000 });
    expect(PV.previewSubscription(list(6000, 8000) as never, 'DRIVER')?.weeklyRate).toBe(8000);
  });

  it('a rider is never shown the taxi rate, and no quote means no fee', () => {
    const noRider = { ...list(6000, 9000), movers: [quote('CAR', 'DRIVER', 'STANDARD', 'taxi', 9000)] };
    expect(PV.previewSubscription(noRider as never, 'RIDER')).toBeNull();
    // A list that priced the motorbike as a taxi would be wrong; the rider face refuses it.
    const crossed = { ...list(6000, 9000), movers: [quote('MOTORCYCLE', 'DRIVER', 'STANDARD', 'taxi', 9000)] };
    expect(PV.previewSubscription(crossed as never, 'RIDER')).toBeNull();
    expect(PV.previewSubscription(undefined, 'RIDER')).toBeNull();
  });

  it('the sample subscription bills in the future, not on a date already gone', () => {
    const sub = PV.previewSubscription(list(6000, 9000) as never, 'RIDER')!;
    expect(new Date(sub.nextBillingDate).getTime()).toBeGreaterThan(Date.now());
  });
});
