import type { VendorPreviewType } from '../stores/vendorPreview';

/**
 * Per-business-type SAMPLE data for the vendor PREVIEW (vendor excellence R4).
 * A prospective RESTAURANT / GROCERY / SHOP / SERVICE owner taps through the
 * REAL dashboard fed these canned values — no account, no store, no network,
 * clearly labelled and read-only (mutations no-op; the existing preview banner +
 * locked controls apply). Illustrative Georgetown data, round GYD figures; the
 * screens render it through their normal paths, so preview never drifts from
 * production.
 */

const TYPE_LABEL: Record<VendorPreviewType, string> = {
  RESTAURANT: 'Georgetown Grill',
  SUPERMARKET: 'Kitty Fresh Market',
  STORE: 'Regent Street Shop',
  SERVICE: 'Sheriff Street Salon',
};

// Type-tailored catalogue rows (menu / inventory / products / services).
const CATALOGUE: Record<VendorPreviewType, Array<{ name: string; basePrice: number; stockQuantity: number | null; unit?: string }>> = {
  RESTAURANT: [
    { name: 'Pepperpot & rice', basePrice: 1800, stockQuantity: null },
    { name: 'Chicken chow mein', basePrice: 1600, stockQuantity: null },
    { name: 'Fish & bakes', basePrice: 1400, stockQuantity: null },
    { name: 'Fresh lime juice', basePrice: 500, stockQuantity: null },
  ],
  SUPERMARKET: [
    { name: 'Rice — 5kg bag', basePrice: 2200, stockQuantity: 40, unit: 'bag' },
    { name: 'Plantain chips', basePrice: 450, stockQuantity: 120, unit: 'pack' },
    { name: 'Coconut water — 1L', basePrice: 700, stockQuantity: 8, unit: 'bottle' },
    { name: 'Brown sugar — 1kg', basePrice: 600, stockQuantity: 0, unit: 'kg' },
  ],
  STORE: [
    { name: 'Cotton T-shirt', basePrice: 3000, stockQuantity: 25 },
    { name: 'Baseball cap', basePrice: 2000, stockQuantity: 12 },
    { name: 'Canvas tote', basePrice: 2500, stockQuantity: 0 },
  ],
  SERVICE: [
    { name: 'Haircut & style', basePrice: 3000, stockQuantity: null, unit: '45 min' },
    { name: 'Manicure', basePrice: 2500, stockQuantity: null, unit: '30 min' },
    { name: 'Deluxe spa package', basePrice: 8000, stockQuantity: null, unit: '90 min' },
  ],
};

// Type-tailored live orders. Services surface as APPOINTMENT; the rest DELIVERY.
function ordersFor(type: VendorPreviewType) {
  const fulfillment = type === 'SERVICE' ? 'APPOINTMENT' : 'DELIVERY';
  const orderType = type === 'RESTAURANT' ? 'FOOD_DELIVERY' : type === 'SUPERMARKET' ? 'GROCERY_DELIVERY' : type === 'SERVICE' ? 'SERVICE' : 'STORE_DELIVERY';
  const rows = CATALOGUE[type];
  return [
    { id: 'pv-o1', orderNumber: 'SW-3041', status: 'PENDING', orderType, fulfillment, isExpress: type === 'RESTAURANT', totalAmount: 2300, createdAt: '2026-07-28T13:40:00Z', customer: { firstName: 'Ava' }, items: [{ id: 'pv-o1-line-1', name: rows[0]!.name, quantity: 1 }] },
    { id: 'pv-o2', orderNumber: 'SW-3040', status: 'ACCEPTED', orderType, fulfillment, totalAmount: 1600, createdAt: '2026-07-28T13:22:00Z', customer: { firstName: 'Ken' }, items: [{ id: 'pv-o2-line-1', name: rows[1 % rows.length]!.name, quantity: 2 }] },
    { id: 'pv-o3', orderNumber: 'SW-3038', status: type === 'SERVICE' ? 'ACCEPTED' : 'READY_FOR_PICKUP', orderType, fulfillment, totalAmount: 3400, createdAt: '2026-07-28T12:58:00Z', customer: { firstName: 'Mara' }, items: [{ id: 'pv-o3-line-1', name: rows[2 % rows.length]!.name, quantity: 1 }] },
  ];
}

export interface VendorPreviewDataset {
  owner: any;
  store: any;
  stores: any[];
  orders: any[];
  analytics: any;
  revenue: any;
  ops: any;
  busyHours: any;
  popularItems: any[];
  hours: any;
  subscription: any;
  menu: any;
  verification: any;
  bookings: any[];
  loyalty: any;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Repeat-customers sample (GET /vendor/analytics/repeat-customers shape). A
// repeat customer has >=2 finished orders; repeatRate is derived, never stored,
// so the sample can't contradict itself. Busier verticals show more loyalty.
const LOYALTY_BASE: Record<VendorPreviewType, { totalCustomers: number; repeatCustomers: number; totalOrders: number }> = {
  RESTAURANT: { totalCustomers: 214, repeatCustomers: 96, totalOrders: 512 },
  SUPERMARKET: { totalCustomers: 168, repeatCustomers: 71, totalOrders: 389 },
  STORE: { totalCustomers: 92, repeatCustomers: 28, totalOrders: 141 },
  SERVICE: { totalCustomers: 76, repeatCustomers: 34, totalOrders: 158 },
};

export function vendorPreviewDataset(type: VendorPreviewType): VendorPreviewDataset {
  const store = {
    id: 'pv-store',
    name: TYPE_LABEL[type],
    slug: 'preview-store',
    vendorType: type,
    status: 'ACTIVE',
    isVerified: true,
    isCurrentlyOpen: true,
    acceptingOrders: true,
    selfDeliveryEnabled: false,
    addressLine1: '1 Regent Street',
    city: 'Georgetown',
    region: 'Demerara-Mahaica',
    prepTimeMinutes: type === 'RESTAURANT' ? 20 : 10,
  };
  const orders = ordersFor(type);
  const items = CATALOGUE[type].map((r, i) => ({
    id: `pv-item-${i}`,
    name: r.name,
    basePrice: r.basePrice,
    markedUpPrice: r.basePrice,
    stockQuantity: r.stockQuantity,
    unit: r.unit ?? null,
    isAvailable: r.stockQuantity !== 0,
  }));
  return {
    owner: { id: 'pv-owner', myRole: 'OWNER', vendors: [store] },
    store,
    stores: [store],
    orders,
    analytics: { queueValue: orders.reduce((s, o) => s + o.totalAmount, 0), today: { total: 84600, count: 32 } },
    revenue: DAY_LABELS.map((d, i) => ({ date: d, total: 40000 + i * 9000, isToday: i === 6 })),
    ops: { avgPrepMinutes: type === 'RESTAURANT' ? 18 : 9, completionRate: 98, avgFulfilMinutes: 34 },
    busyHours: [11, 12, 13, 18, 19, 20].map((h) => ({ hour: h, orders: 6 + (h % 5) })),
    popularItems: items.slice(0, 3).map((it, i) => ({ name: it.name, count: 40 - i * 8, revenue: (40 - i * 8) * it.basePrice })),
    hours: DAY_LABELS.map((d) => ({ day: d, open: '09:00', close: '21:00', closed: false })),
    subscription: { status: 'ACTIVE', type: 'VENDOR', weeklyRate: type === 'RESTAURANT' ? 20000 : 15000, currencyCode: 'GYD', currentPeriodEnd: '2026-08-04T00:00:00Z', nextBillingDate: '2026-08-04T00:00:00Z' },
    // useVendorMenu shape: categories with items (grocery/goods) or a flat menu.
    menu: { categories: [{ id: 'pv-cat', name: type === 'SERVICE' ? 'Services' : type === 'SUPERMARKET' ? 'Groceries' : 'Menu', items }] },
    // A fully-approved store so the dashboard shows the working experience.
    verification: { roleVerified: true, checklist: [], documents: [] },
    // Services surface a schedule; the goods types have no appointments.
    bookings: type === 'SERVICE'
      ? [
          { id: 'pv-b1', serviceName: items[0]!.name, price: items[0]!.basePrice, slotStart: '2026-07-28T10:00:00Z', slotEnd: '2026-07-28T10:45:00Z', status: 'RESERVED', orderId: null, customer: { firstName: 'Ava' } },
          { id: 'pv-b2', serviceName: items[1 % items.length]!.name, price: items[1 % items.length]!.basePrice, slotStart: '2026-07-28T13:30:00Z', slotEnd: '2026-07-28T14:00:00Z', status: 'CONFIRMED', orderId: null, customer: { firstName: 'Ken' } },
          { id: 'pv-b3', serviceName: items[2 % items.length]!.name, price: items[2 % items.length]!.basePrice, slotStart: '2026-07-29T11:00:00Z', slotEnd: '2026-07-29T12:30:00Z', status: 'RESERVED', orderId: null, customer: { firstName: 'Mara' } },
        ]
      : [],
    loyalty: {
      ...LOYALTY_BASE[type],
      repeatRate: Math.round((LOYALTY_BASE[type].repeatCustomers / LOYALTY_BASE[type].totalCustomers) * 100),
    },
  };
}

// ---------------------------------------------------------------------------
// react-query-shaped stubs (same as the earner preview) so a hook can return
// sample data / a no-op mutation without the screens knowing they're in preview.
// ---------------------------------------------------------------------------

export function previewQuery<T>(data: T): any {
  return { data, isLoading: false, isFetching: false, isRefetching: false, isPending: false, isError: false, error: null, isSuccess: true, status: 'success', refetch: async () => ({ data }) };
}

export function previewMutation(): any {
  // [WR-036] Same honest no-op as the mover preview: say it, change nothing.
  const explain = () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../kit/toast').toast.show('Preview is read-only — nothing was changed.');
    } catch { /* non-UI context (tests) */ }
  };
  return { mutate: () => explain(), mutateAsync: async () => { explain(); return undefined; }, isPending: false, isError: false, error: null, isSuccess: false, reset: () => {}, data: undefined };
}
