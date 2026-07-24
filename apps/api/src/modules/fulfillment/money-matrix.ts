import { zMoneyMinor } from '../../utils/money-schema';

/**
 * FUL-001 — THE MONEY MATRIX (fulfillment prompt Part 6.1).
 *
 * Swift never touches order money — it moves between customer, vendor, and
 * rider. This computes, for a given fulfillment × payment combination, EXACTLY
 * how it moves, as integer minor units (reusing SWIFT-103's `zMoneyMinor` so the
 * money-input invariant has one source). It is the reconciliation ORACLE: the
 * real settlement (`cash-rules` handover, `Earning`, `DeliveryCashSettlement`,
 * float) must reconcile against these movements — this does NOT move money
 * itself (reconcile, don't fork the money path).
 *
 * `VENDOR_DELIVERY` (vendor self-delivers) is modelled here though it isn't yet
 * a Swift fulfillment enum — it's a known build (RECONCILIATION.md Q3). For it,
 * the "rider" is the vendor's own courier, so the delivery money stays with the
 * vendor and no platform-rider obligation arises.
 */

export type FulfillmentMode = 'PLATFORM_RIDER' | 'VENDOR_DELIVERY' | 'PICKUP';
export type OrderPayment = 'CASH' | 'VENDOR_MMG';
export type Party = 'CUSTOMER' | 'VENDOR' | 'RIDER';

export type MovementType =
  | 'RIDER_FRONTED'
  | 'CUSTOMER_PAID_CASH'
  | 'CUSTOMER_PAID_VENDOR_MMG'
  | 'VENDOR_SETTLED_RIDER';

/** `amount` (minor units) leaves `from` and arrives at `to`. `deferred` = an
 *  obligation settled after delivery (row 2 vendor→rider), not at handover. */
export interface Movement {
  type: MovementType;
  from: Party;
  to: Party;
  amount: number;
  deferred?: boolean;
}

export interface Obligation {
  type: 'VENDOR_OWES_RIDER';
  from: Party; // VENDOR
  to: Party; // RIDER
  amount: number;
}

export interface Settlement {
  movements: Movement[];
  obligations: Obligation[];
  /** Net position per party once ALL movements (incl. deferred) complete. */
  net: Record<Party, number>;
  /** What the rider keeps (the delivery fee, when a platform rider delivers). */
  riderNets: number;
  /** Cash the rider fronts to the vendor at collection (row 1 only). */
  riderFronts: number;
  /** Double-entry invariant: money is conserved — Σ over all parties' net = 0. */
  reconciles: boolean;
}

export interface MatrixInput {
  /** Goods subtotal the customer owes for the items, integer minor units. */
  foodTotal: number;
  /** Delivery fee, integer minor units. MUST be 0 for PICKUP. */
  deliveryFee: number;
  mode: FulfillmentMode;
  payment: OrderPayment;
}

/** Compute the settlement for one order. Throws on non-integer/negative money
 *  or a pickup that carries a delivery fee (both are invariant violations). */
export function settle(input: MatrixInput): Settlement {
  const foodTotal = zMoneyMinor.parse(input.foodTotal);
  const deliveryFee = zMoneyMinor.parse(input.deliveryFee);
  const { mode, payment } = input;

  if (mode === 'PICKUP' && deliveryFee !== 0) {
    throw new Error('Pickup orders carry no delivery fee — deliveryFee must be 0.');
  }

  const movements: Movement[] = [];
  const obligations: Obligation[] = [];

  if (mode === 'PLATFORM_RIDER') {
    if (payment === 'CASH') {
      // Row 1: rider fronts the food to the vendor, collects food+delivery from
      // the customer, keeps the delivery fee.
      movements.push({ type: 'RIDER_FRONTED', from: 'RIDER', to: 'VENDOR', amount: foodTotal });
      movements.push({ type: 'CUSTOMER_PAID_CASH', from: 'CUSTOMER', to: 'RIDER', amount: foodTotal + deliveryFee });
    } else {
      // Row 2: customer pays the vendor (food+delivery) via MMG; the vendor now
      // OWES the rider the delivery fee — a tracked, later-settled obligation.
      movements.push({ type: 'CUSTOMER_PAID_VENDOR_MMG', from: 'CUSTOMER', to: 'VENDOR', amount: foodTotal + deliveryFee });
      movements.push({ type: 'VENDOR_SETTLED_RIDER', from: 'VENDOR', to: 'RIDER', amount: deliveryFee, deferred: true });
      obligations.push({ type: 'VENDOR_OWES_RIDER', from: 'VENDOR', to: 'RIDER', amount: deliveryFee });
    }
  } else if (mode === 'VENDOR_DELIVERY') {
    // Rows 3/4: the vendor's own courier delivers; the vendor keeps everything,
    // no platform rider, no obligation.
    const total = foodTotal + deliveryFee;
    movements.push(
      payment === 'CASH'
        ? { type: 'CUSTOMER_PAID_CASH', from: 'CUSTOMER', to: 'VENDOR', amount: total }
        : { type: 'CUSTOMER_PAID_VENDOR_MMG', from: 'CUSTOMER', to: 'VENDOR', amount: total },
    );
  } else {
    // Rows 5/6: pickup — no delivery fee, no rider; customer pays the vendor.
    movements.push(
      payment === 'CASH'
        ? { type: 'CUSTOMER_PAID_CASH', from: 'CUSTOMER', to: 'VENDOR', amount: foodTotal }
        : { type: 'CUSTOMER_PAID_VENDOR_MMG', from: 'CUSTOMER', to: 'VENDOR', amount: foodTotal },
    );
  }

  const net: Record<Party, number> = { CUSTOMER: 0, VENDOR: 0, RIDER: 0 };
  for (const m of movements) {
    net[m.from] -= m.amount;
    net[m.to] += m.amount;
  }
  const reconciles = net.CUSTOMER + net.VENDOR + net.RIDER === 0;

  return {
    movements,
    obligations,
    net,
    riderNets: net.RIDER,
    riderFronts: movements.find((m) => m.type === 'RIDER_FRONTED')?.amount ?? 0,
    reconciles,
  };
}
