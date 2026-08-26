import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orderStatusLabel, orderSubtitle } from './orderStatus';

// ---------------------------------------------------------------------------
// THE STATUS LINE.
//
// Home's old map had six entries and two defects.
//
// `READY: 'Ready for pickup'` was never a status — the Prisma enum value is
// READY_FOR_PICKUP — so the key could not match and the label was dead the day
// it was typed. Nothing caught it, because a Record<string,string> accepts any
// key and a missing one just falls through to the default.
//
// And the map had no idea what KIND of order it described. A taxi ride is born
// PENDING with no vendor, so a passenger in a moving car was told "Waiting for
// the store".
//
// The first test below reads the enum out of schema.prisma. That is the point:
// a label map typed by hand against an enum that lives somewhere else drifts
// silently, and the only way to notice is to go and look.
// ---------------------------------------------------------------------------

/** The real OrderStatus values, read from the schema rather than retyped. */
function enumValues(name: string): string[] {
  const schema = readFileSync(
    join(process.cwd(), '../../apps/api/prisma/schema.prisma'),
    'utf8',
  );
  const block = schema.match(new RegExp(`enum ${name} \\{([^}]*)\\}`));
  if (!block) throw new Error(`enum ${name} not found in schema.prisma`);
  return block[1]!
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => /^[A-Z_]+$/.test(l));
}

describe('every order status has words', () => {
  it('no status anywhere in the enum falls through to the fallback', () => {
    const statuses = enumValues('OrderStatus');
    const kinds = enumValues('OrderType');

    expect(statuses.length).toBeGreaterThan(10); // sanity: we really read it

    // A vertical legitimately never reaches some statuses — a taxi has no
    // PREPARING — so only flag a status that NO vertical can describe.
    const unlabelled = statuses.filter((status) =>
      kinds.every((kind) => orderStatusLabel(status, kind) === 'In progress'),
    );

    expect(
      unlabelled,
      'These statuses render as the bare fallback for every order type — the ' +
        'person waiting is told nothing.',
    ).toEqual([]);
  });

  it('READY_FOR_PICKUP is the real key — READY never was', () => {
    expect(orderStatusLabel('READY_FOR_PICKUP', 'FOOD_DELIVERY')).toBe('Ready for pickup');
    // The old map's key. It must NOT be mapped, or the same typo comes back
    // wearing a test as cover.
    expect(orderStatusLabel('READY', 'FOOD_DELIVERY')).toBe('In progress');
  });
});

describe('a ride is not a delivery', () => {
  it('a taxi is never "waiting for the store" — there is no store', () => {
    expect(orderStatusLabel('PENDING', 'TAXI')).toBe('Finding you a driver');
    expect(orderStatusLabel('PENDING', 'TAXI')).not.toMatch(/store/i);
  });

  it('a parcel is not waiting for a store either', () => {
    expect(orderStatusLabel('PENDING', 'COURIER')).not.toMatch(/store/i);
  });

  it('food still is, because for food it is true', () => {
    expect(orderStatusLabel('PENDING', 'FOOD_DELIVERY')).toBe('Waiting for the store');
    expect(orderStatusLabel('PENDING', 'GROCERY_DELIVERY')).toBe('Waiting for the store');
  });

  it('an unknown status admits it rather than guessing', () => {
    expect(orderStatusLabel('SOMETHING_NEW', 'TAXI')).toBe('In progress');
    expect(orderStatusLabel(null)).toBe('In progress');
    expect(orderStatusLabel(undefined)).toBe('In progress');
  });
});

describe('the subtitle never leads with a separator', () => {
  it('an order with no vendor shows just its number', () => {
    // A taxi and a parcel have no vendor. This used to render " · #ORD-0042".
    expect(orderSubtitle(null, 'ORD-0042')).toBe('#ORD-0042');
    expect(orderSubtitle(undefined, 'ORD-0042')).toBe('#ORD-0042');
  });

  it('joins the two when both are there', () => {
    expect(orderSubtitle("Mauby's Snackette", 'ORD-0042')).toBe("Mauby's Snackette · #ORD-0042");
  });

  it('is empty rather than a lone dot when it knows nothing', () => {
    expect(orderSubtitle(null, null)).toBe('');
  });
});
