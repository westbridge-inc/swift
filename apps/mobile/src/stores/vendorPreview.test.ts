import { beforeEach, describe, expect, it } from 'vitest';
import { useVendorPreview } from './vendorPreview';
import { vendorPreviewDataset } from '../lib/vendorPreviewData';

// ---------------------------------------------------------------------------
// Found on a phone: a pending vendor tapped "Preview your dashboard" and the
// dashboard crashed inside vendorPreviewData.ts with an undefined catalogue.
//
// VendorStack handed the store action `enterPreview(type?)` straight to the
// button, and Pressable calls its handler with the press EVENT. The event was
// stored as the sample-business type, so every vendor hook fed it to the sample
// dataset — `CATALOGUE[event]` is undefined and `rows[0]` throws on render.
//
// A stored type is not cosmetic: a non-null `previewType` also switches every
// vendor hook to canned data and lets the root navigator skip sign-in. So the
// only safe reading of anything that is not one of the four business types is
// the legacy peek at the signed-in vendor's OWN store (type null).
// ---------------------------------------------------------------------------

// What React Native's Pressable passes to an onPress handler.
const pressEvent = {
  type: 'press',
  nativeEvent: { locationX: 12, locationY: 8, pageX: 40, pageY: 600, timestamp: 1 },
  currentTarget: 71,
  target: 71,
};

// The dashboard's render path, exactly as usePreviewDataset() computes it.
function renderPathDataset() {
  const previewType = useVendorPreview.getState().previewType;
  return previewType ? vendorPreviewDataset(previewType) : null;
}

beforeEach(() => {
  useVendorPreview.getState().exitPreview();
});

describe('the pending vendor’s "Preview your dashboard" button', () => {
  it('opens the real-data peek at their own store when the press event reaches the store', () => {
    useVendorPreview.getState().enterPreview(pressEvent as never);

    expect(useVendorPreview.getState()).toMatchObject({ preview: true, previewType: null });
  });

  it('renders the dashboard instead of throwing inside the sample dataset', () => {
    useVendorPreview.getState().enterPreview(pressEvent as never);

    expect(() => renderPathDataset()).not.toThrow();
    expect(renderPathDataset()).toBeNull();
  });
});

describe('a missing or unknown business type is fail-safe', () => {
  const hostile: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['an unknown type', 'BARBERSHOP'],
    ['a lower-case type', 'restaurant'],
    ['an empty string', ''],
    ['a number', 42],
    ['an object', { type: 'RESTAURANT' }],
    ['a press event', pressEvent],
  ];

  it.each(hostile)('entering preview with %s never stores a sample type', (_label, value) => {
    useVendorPreview.getState().enterPreview(value as never);

    expect(useVendorPreview.getState().previewType).toBeNull();
    expect(() => renderPathDataset()).not.toThrow();
  });

  it.each(hostile)('switching the sample to %s keeps the business being shown', (_label, value) => {
    useVendorPreview.getState().enterPreview('SERVICE');

    useVendorPreview.getState().setPreviewType(value as never);

    expect(useVendorPreview.getState()).toMatchObject({ preview: true, previewType: 'SERVICE' });
    expect(renderPathDataset()?.store.vendorType).toBe('SERVICE');
  });
});

describe('a known business type still opens its sample dashboard', () => {
  it.each(['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE'] as const)('%s', (type) => {
    useVendorPreview.getState().enterPreview(type);

    expect(useVendorPreview.getState()).toMatchObject({ preview: true, previewType: type });
    const dataset = renderPathDataset();
    expect(dataset?.store.vendorType).toBe(type);
    expect(dataset?.menu.categories[0].items.length).toBeGreaterThan(0);
  });

  it('the sample chips still switch between the four types', () => {
    useVendorPreview.getState().enterPreview('RESTAURANT');
    for (const type of ['SUPERMARKET', 'STORE', 'SERVICE', 'RESTAURANT'] as const) {
      useVendorPreview.getState().setPreviewType(type);
      expect(renderPathDataset()?.store.vendorType).toBe(type);
    }
  });
});
