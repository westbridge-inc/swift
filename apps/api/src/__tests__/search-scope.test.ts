import { describe, it, expect } from 'vitest';
import {
  FilterValueRejected, ITEM_INDEX, SEARCH_INDEX_VERSION, VENDOR_INDEX, buildScopedFilter, decodeScopedCursor, docId,
  encodeScopedCursor, escapeFilterValue, parseDocId, renderClause,
} from '../modules/search/search-scope';
import { searchScopeCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [R048-003] The pure half of the market/search scope: document ids carry the
// tenant and parse back; the filter builder never concatenates a raw value —
// quotes and backslashes are escaped, control characters are refused, and the
// tenant clause is the one clause a caller cannot omit; a page cursor names
// its tenant and its sort and is refused for any other.
// ---------------------------------------------------------------------------

const count = async (outcome: string) => (await searchScopeCounter.get()).values.find((v) => v.labels['outcome'] === outcome)?.value ?? 0;

describe('document ids carry the tenant', () => {
  it('a document id is <tenant>__<entity> and parses back; the index names are versioned', () => {
    expect(docId('swift-default', 'clx123')).toBe('swift-default__clx123');
    expect(parseDocId('swift-default__clx123')).toEqual({ tenantId: 'swift-default', entityId: 'clx123' });
    expect(parseDocId('nodelimiter')).toBeNull();
    expect(parseDocId('__x')).toBeNull();
    expect(VENDOR_INDEX).toBe(`vendors_${SEARCH_INDEX_VERSION}`);
    expect(ITEM_INDEX).toBe(`items_${SEARCH_INDEX_VERSION}`);
  });

  it('an id part that is not [A-Za-z0-9_-], or holds the separator, cannot become a document id (the separator cannot be forged)', () => {
    expect(docId('t_1', 'x')).toBe('t_1__x');
    expect(parseDocId('t_1__x')).toEqual({ tenantId: 't_1', entityId: 'x' });
    expect(() => docId('a__b', 'c')).toThrow(/cannot build a document id/);
    expect(() => docId('tenant', 'x y')).toThrow(/cannot build a document id/);
    expect(() => docId('', 'x')).toThrow(/cannot build a document id/);
  });
});

describe('the filter builder never concatenates a raw value', () => {
  it('escapes quotes and backslashes so operator syntax stays literal inside the value', () => {
    expect(escapeFilterValue('cuisineTypes', 'creole')).toBe('"creole"');
    expect(escapeFilterValue('cuisineTypes', 'x" OR tenantId = "other')).toBe('"x\\" OR tenantId = \\"other"');
    expect(escapeFilterValue('cuisineTypes', 'back\\slash')).toBe('"back\\\\slash"');
    expect(renderClause({ attribute: 'cuisineTypes', op: '=', value: 'a) OR (b' })).toBe('cuisineTypes = "a) OR (b"');
  });

  it('refuses empty, over-long and control-character values, non-attribute names, and non-finite numbers — by name', () => {
    expect(() => escapeFilterValue('dietaryTags', '')).toThrow(FilterValueRejected);
    expect(() => escapeFilterValue('dietaryTags', 'x'.repeat(121))).toThrow(/longer than 120/);
    expect(() => escapeFilterValue('dietaryTags', 'a\nb')).toThrow(/control character/);
    expect(() => escapeFilterValue('dietaryTags', 'a\tb')).toThrow(/control character/);
    expect(escapeFilterValue('dietaryTags', 'a b')).toBe('"a b"'); // a space is not a control character
    expect(() => renderClause({ attribute: 'cuisineTypes = "x" OR y', op: '=', value: 'v' })).toThrow(/not an attribute name/);
    expect(() => renderClause({ attribute: 'basePrice', op: '<=', value: Number.NaN })).toThrow(/not a finite number/);
    expect(() => renderClause({ attribute: 'basePrice', op: '<=', value: Number.POSITIVE_INFINITY })).toThrow(/not a finite number/);
  });

  it('renders booleans and numbers as such', () => {
    expect(renderClause({ attribute: 'isAvailable', op: '=', value: true })).toBe('isAvailable = true');
    expect(renderClause({ attribute: 'basePrice', op: '<=', value: 2500 })).toBe('basePrice <= 2500');
  });

  it('the tenant clause is first and always; a missing tenant is refused, never widened', () => {
    expect(buildScopedFilter('swift-default', [])).toEqual(['tenantId = "swift-default"']);
    expect(buildScopedFilter('t-b', [{ attribute: 'vendorType', op: '=', value: 'STORE' }, { attribute: 'isCurrentlyOpen', op: '=', value: true }]))
      .toEqual(['tenantId = "t-b"', 'vendorType = "STORE"', 'isCurrentlyOpen = true']);
    expect(() => buildScopedFilter('', [])).toThrow(FilterValueRejected);
    // the tenant id itself goes through the same escaping
    expect(buildScopedFilter('t"b', [])[0]).toBe('tenantId = "t\\"b"');
  });
});

describe('a page cursor names its tenant and its sort', () => {
  it('round-trips inside one tenant and one sort', () => {
    const c = encodeScopedCursor('t-a', 'item-9', 'popular');
    expect(decodeScopedCursor(c, 't-a', 'popular')).toBe('item-9');
  });

  it('is refused for another tenant (counted), another sort, and when unreadable', async () => {
    const c = encodeScopedCursor('t-a', 'item-9', 'popular');
    const before = await count('cross_tenant_cursor');
    expect(() => decodeScopedCursor(c, 't-b', 'popular')).toThrow(/different catalogue/);
    expect(await count('cross_tenant_cursor')).toBe(before + 1);
    expect(() => decodeScopedCursor(c, 't-a', 'new')).toThrow(/different sort/);
    expect(() => decodeScopedCursor('not-base64-json', 't-a', 'popular')).toThrow(/not readable/);
    // a hand-made cursor with no tenant is another catalogue's, not this one's
    const legacy = Buffer.from(JSON.stringify({ i: 'item-9', s: 'popular' })).toString('base64url');
    expect(() => decodeScopedCursor(legacy, 't-a', 'popular')).toThrow(/different catalogue/);
  });
});
