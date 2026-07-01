import { describe, it, expect } from 'vitest';
import { pickOrderId } from './order';

describe('pickOrderId (checkout response contract)', () => {
  it('reads the first order id from the multi-vendor orders[] shape', () => {
    expect(pickOrderId({ orders: [{ id: 'o1' }, { id: 'o2' }] })).toBe('o1');
  });
  it('falls back to a single order.id', () => {
    expect(pickOrderId({ order: { id: 'single' } })).toBe('single');
  });
  it('prefers orders[] over order', () => {
    expect(pickOrderId({ orders: [{ id: 'first' }], order: { id: 'other' } })).toBe('first');
  });
  it('returns undefined for empty / missing / null payloads', () => {
    expect(pickOrderId({ orders: [] })).toBeUndefined();
    expect(pickOrderId({})).toBeUndefined();
    expect(pickOrderId(null)).toBeUndefined();
    expect(pickOrderId(undefined)).toBeUndefined();
  });
});
