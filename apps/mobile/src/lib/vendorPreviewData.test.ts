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
