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
