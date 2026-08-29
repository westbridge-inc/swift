import { describe, it, expect } from 'vitest';
import { vendorPreviewDataset, previewQuery, previewMutation } from './vendorPreviewData';
import { useVendorPreview } from '../stores/vendorPreview';

// Vendor PREVIEW (R4 + invariant 5): a prospective owner walks the REAL dashboard
// of their business type with SAMPLE data, strictly READ-ONLY. These pin the
// contract at the source: mutations no-op, and every type yields a coherent,
// active, verified sample so the dashboard shows the working experience.

const TYPES = ['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE'] as const;

describe('vendor preview — read-only invariant (invariant 5)', () => {
  it('previewMutation is a true no-op: mutate + mutateAsync write nothing, never throw', async () => {
    const m = previewMutation();
    expect(m.isPending).toBe(false);
    expect(() => m.mutate({ id: 'x', action: 'accept' })).not.toThrow();
    await expect(m.mutateAsync()).resolves.toBeUndefined();
  });

  it('previewQuery resolves immediately with the sample data', () => {
    const q = previewQuery({ hello: 1 });
    expect(q.data).toEqual({ hello: 1 });
    expect(q.isLoading).toBe(false);
    expect(q.isSuccess).toBe(true);
  });
});

describe('vendor preview — per-type sample datasets are coherent', () => {
  for (const type of TYPES) {
    it(`${type}: an ACTIVE, verified store with orders, a catalogue, and analytics`, () => {
      const d = vendorPreviewDataset(type);
      // The store renders the working board (not onboarding): ACTIVE + verified.
      expect(d.store.status).toBe('ACTIVE');
      expect(d.store.isVerified).toBe(true);
      expect(d.store.vendorType).toBe(type); // reshapes to the chosen type
      expect(d.owner.vendors[0].id).toBe(d.store.id);
      // Real content on every core surface the dashboard reads.
      expect(d.orders.length).toBeGreaterThan(0);
      expect(d.menu.categories[0].items.length).toBeGreaterThan(0);
      expect(typeof d.analytics.today.total).toBe('number');
      expect(d.revenue).toHaveLength(7);
      expect(d.subscription.status).toBe('ACTIVE');
    });
  }

  it('SERVICE surfaces appointments (not delivery) — the type-awareness spec', () => {
    const svc = vendorPreviewDataset('SERVICE');
    expect(svc.orders.every((o) => o.fulfillment === 'APPOINTMENT')).toBe(true);
    const rest = vendorPreviewDataset('RESTAURANT');
    expect(rest.orders.every((o) => o.fulfillment === 'DELIVERY')).toBe(true);
  });

  it('only SERVICE has a schedule (bookings) — the goods types have none', () => {
    expect(vendorPreviewDataset('SERVICE').bookings.length).toBeGreaterThan(0);
    expect(vendorPreviewDataset('RESTAURANT').bookings).toHaveLength(0);
    expect(vendorPreviewDataset('SUPERMARKET').bookings).toHaveLength(0);
    // Shape the Schedule agenda reads.
    const b = vendorPreviewDataset('SERVICE').bookings[0];
    expect(b.serviceName).toBeTruthy();
    expect(b.customer.firstName).toBeTruthy();
    expect(typeof b.slotStart).toBe('string');
  });

  it('every type has a coherent repeat-customers (loyalty) sample — the rate is derived, never contradictory', () => {
    for (const type of TYPES) {
      const l = vendorPreviewDataset(type).loyalty;
      expect(l.totalCustomers).toBeGreaterThan(0);
      expect(l.repeatCustomers).toBeLessThanOrEqual(l.totalCustomers); // a subset came back
      expect(l.totalOrders).toBeGreaterThanOrEqual(l.totalCustomers); // repeat buyers order more
      // repeatRate is computed from the counts, so the tile can't show a rate
      // that contradicts "X of Y came back".
      expect(l.repeatRate).toBe(Math.round((l.repeatCustomers / l.totalCustomers) * 100));
    }
  });
});

describe('vendorPreview store', () => {
  it('enter with a type = sample preview; no-arg = the legacy pending-vendor peek', () => {
    expect(useVendorPreview.getState().previewType).toBeNull();
    useVendorPreview.getState().enterPreview('SUPERMARKET');
    expect(useVendorPreview.getState().preview).toBe(true);
    expect(useVendorPreview.getState().previewType).toBe('SUPERMARKET');
    useVendorPreview.getState().setPreviewType('SERVICE');
    expect(useVendorPreview.getState().previewType).toBe('SERVICE');
    useVendorPreview.getState().exitPreview();
    expect(useVendorPreview.getState().preview).toBe(false);
    expect(useVendorPreview.getState().previewType).toBeNull();

    // No-arg keeps the original behaviour (real data): preview on, type null.
    useVendorPreview.getState().enterPreview();
    expect(useVendorPreview.getState().preview).toBe(true);
    expect(useVendorPreview.getState().previewType).toBeNull();
    useVendorPreview.getState().exitPreview();
  });
});

// ---------------------------------------------------------------------------
// The preview is what a prospective vendor is shown as "the working experience".
// Its dates were written as absolute ISO strings, so by the time this was found
// on a real device the sample advertised a bill that fell due three weeks
// earlier and a queue of month-old orders. Absolute dates in a canned dataset
// do not fail on the day they are written — they fail silently, later, in front
// of exactly the person the sample is meant to convince.
//
// These assert the PROPERTY (the sample is current) rather than any value, so
// they cannot rot the same way.
// ---------------------------------------------------------------------------
describe('the sample never goes stale', () => {
  const TYPES = ['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE'] as const;

  it.each(TYPES)('%s: the next bill is ahead of today, never behind it', (type) => {
    const { subscription } = vendorPreviewDataset(type);
    const next = new Date(subscription.nextBillingDate).getTime();
    expect(next).toBeGreaterThan(Date.now());
    // The advertised rate is WEEKLY, so a next-bill date further out than a
    // week would be describing a plan the vendor is not being sold.
    expect(next - Date.now()).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    expect(new Date(subscription.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now());
  });

  it.each(TYPES)('%s: the live queue is live — every order arrived within the hour', (type) => {
    const { orders } = vendorPreviewDataset(type);
    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) {
      const age = Date.now() - new Date(o.createdAt).getTime();
      expect(age).toBeGreaterThanOrEqual(0);          // never dated in the future
      expect(age).toBeLessThanOrEqual(60 * 60 * 1000); // a queue, not an archive
    }
  });

  it('SERVICE: the schedule is today and tomorrow, not a past week', () => {
    const { bookings } = vendorPreviewDataset('SERVICE');
    expect(bookings.length).toBeGreaterThan(0);
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    for (const b of bookings) {
      expect(new Date(b.slotStart).getTime()).toBeGreaterThanOrEqual(startOfToday.getTime());
      expect(new Date(b.slotEnd).getTime()).toBeGreaterThan(new Date(b.slotStart).getTime());
    }
  });

  it('no absolute date literal survives in the dataset source', async () => {
    // The three assertions above pass for a dataset that hardcodes dates far
    // enough in the future to still be valid today. This is what actually stops
    // the pattern coming back.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./vendorPreviewData.ts', import.meta.url), 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(stripped).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
