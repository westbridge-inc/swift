import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type OrderType, type PaymentMethod, type PaymentStatus } from '@prisma/client';
import { nanoid } from 'nanoid';
import { mmgFulfilmentHold, isMmgHeld, NOT_MMG_HELD, type MmgHoldReason } from '../modules/order/mmg-hold';

// ---------------------------------------------------------------------------
// [DOC-INV-48 · F-108-01] THE PREDICATE AND THE FILTER MUST BE THE SAME RULE.
//
// "May this MMG order move?" is asked in two shapes: as a question about a row
// the code is holding (`mmgFulfilmentHold`), and as a question to the database
// about which rows are offerable (`NOT_MMG_HELD`). Two shapes of one rule is
// exactly how they came to disagree — the assignment gate enforced BOTH the
// dispute and the payment-first rule, while dispatch, the board and the demand
// map enforced only half of one of them, so an unpaid MMG order was advertised,
// counted, offered, and then refused to the first rider who acted on it.
//
// This test is the parity proof Codex required: EVERY combination of rail,
// order type, payment state and mismatch is written to a real database, and
// the two shapes must classify all of them identically. A disagreement here is
// a disagreement in production.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
const RUN = nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const TAG = `HOLDPAR-${RUN}`;

const RAILS: PaymentMethod[] = ['CASH', 'MOBILE_MONEY', 'CARD', 'BANK_TRANSFER'];
const TYPES: OrderType[] = ['FOOD_DELIVERY', 'GROCERY_DELIVERY', 'COURIER', 'TAXI'];
const STATES: PaymentStatus[] = ['PENDING', 'AUTHORIZED', 'CAPTURED', 'CLAIMED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'UNKNOWN', 'EXPIRED', 'CANCELLED'];
const MISMATCHES = [null, new Date('2026-09-07T12:00:00.000Z')];

interface Row { id: string; paymentMethod: PaymentMethod; orderType: OrderType; paymentStatus: PaymentStatus; mmgClaimMismatchAt: Date | null }
const rows: Row[] = [];
let customerId = '';

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { phone: `+5927${String(Math.floor(Math.random() * 9000000) + 1000000)}`, firstName: 'Hold', lastName: 'Parity', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' },
  });
  customerId = user.id;

  let n = 0;
  for (const paymentMethod of RAILS) {
    for (const orderType of TYPES) {
      for (const paymentStatus of STATES) {
        for (const mmgClaimMismatchAt of MISMATCHES) {
          n += 1;
          const order = await prisma.order.create({
            data: {
              orderNumber: `${TAG}-${n}`, orderType, customerId, status: 'ACCEPTED',
              fulfillment: 'DELIVERY', deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
              subtotalBase: 100, subtotalMarkup: 0, subtotalCustomer: 100,
              deliveryFee: 10, totalAmount: 110, paymentMethod, paymentStatus, mmgClaimMismatchAt,
            },
            select: { id: true },
          });
          rows.push({ id: order.id, paymentMethod, orderType, paymentStatus, mmgClaimMismatchAt });
        }
      }
    }
  }
}, 240_000);

afterAll(async () => {
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: TAG } } });
  if (customerId) await prisma.user.deleteMany({ where: { id: customerId } });
  await prisma.$disconnect();
});

describe('[F-108-01] the hold predicate and the hold filter are one rule', () => {
  it(`classifies all ${RAILS.length * TYPES.length * STATES.length * MISMATCHES.length} combinations identically`, async () => {
    const notHeldIds = new Set(
      (await prisma.order.findMany({
        where: { AND: [{ orderNumber: { startsWith: TAG } }, NOT_MMG_HELD] },
        select: { id: true },
      })).map((o) => o.id),
    );

    const disagreements: string[] = [];
    for (const row of rows) {
      const predicate = mmgFulfilmentHold(row);
      const filterSaysOfferable = notHeldIds.has(row.id);
      if ((predicate === null) !== filterSaysOfferable) {
        disagreements.push(
          `${row.paymentMethod}/${row.orderType}/${row.paymentStatus}/mismatch=${row.mmgClaimMismatchAt ? 'set' : 'null'}: ` +
          `predicate says ${predicate ?? 'offerable'}, filter says ${filterSaysOfferable ? 'offerable' : 'held'}`,
        );
      }
    }
    expect(disagreements, 'the database and the code must agree about every row this schema can hold').toEqual([]);
    // Sanity: the matrix genuinely contains both answers, or the test proves nothing.
    expect(notHeldIds.size).toBeGreaterThan(0);
    expect(notHeldIds.size).toBeLessThan(rows.length);
  }, 120_000);

  it('the reasons are the ones the contract names, and a dispute outranks an unlanded payment', () => {
    const held = (over: Partial<Row>): MmgHoldReason | null => mmgFulfilmentHold({
      paymentMethod: 'MOBILE_MONEY', orderType: 'FOOD_DELIVERY', paymentStatus: 'PENDING', mmgClaimMismatchAt: null, ...over,
    });
    expect(held({}), 'unpaid marketplace MMG').toBe('payment_pending');
    expect(held({ paymentStatus: 'CLAIMED' }), 'the store claimed: money moved').toBeNull();
    expect(held({ paymentStatus: 'CAPTURED' }), 'provider evidence: money moved').toBeNull();
    expect(held({ paymentStatus: 'CLAIMED', mmgClaimMismatchAt: MISMATCHES[1] as Date }), 'a dispute outranks a landed payment').toBe('mismatch');
    expect(held({ paymentStatus: 'PENDING', mmgClaimMismatchAt: MISMATCHES[1] as Date }), 'and outranks an unlanded one').toBe('mismatch');
  });

  it('CASH and TAXI are explicitly out of scope and stay that way', () => {
    for (const paymentStatus of STATES) {
      expect(mmgFulfilmentHold({ paymentMethod: 'CASH', orderType: 'FOOD_DELIVERY', paymentStatus, mmgClaimMismatchAt: null }), `CASH/${paymentStatus}`).toBeNull();
      expect(mmgFulfilmentHold({ paymentMethod: 'MOBILE_MONEY', orderType: 'TAXI', paymentStatus, mmgClaimMismatchAt: null }), `TAXI/${paymentStatus}`).toBeNull();
      // A ride settles at the kerb: even a disputed MMG TAXI row is not held by THIS rule.
      expect(mmgFulfilmentHold({ paymentMethod: 'MOBILE_MONEY', orderType: 'TAXI', paymentStatus, mmgClaimMismatchAt: new Date() }), `TAXI disputed/${paymentStatus}`).toBeNull();
    }
  });

  it('an unprojected mismatch column is a programming error, never a passing gate', () => {
    expect(() => mmgFulfilmentHold({ paymentMethod: 'MOBILE_MONEY', orderType: 'FOOD_DELIVERY', paymentStatus: 'CLAIMED', mmgClaimMismatchAt: undefined as never }))
      .toThrow(/was not projected/);
    // …and it is only a programming error where the rule actually applies.
    expect(isMmgHeld({ paymentMethod: 'CASH', orderType: 'FOOD_DELIVERY', paymentStatus: 'PENDING', mmgClaimMismatchAt: undefined as never })).toBe(false);
  });
});
