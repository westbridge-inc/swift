import { money } from './money';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5] What the phone says about a store's VAT, in ONE place.
//
// Only a store whose GRA VAT certificate a PERSON at Swift checked has VAT, and the server decides it: the storefront
// sends `vat` (null for every other store) and each item's `vatClass`; the cart quote sends `vendors[].vat` (null
// for every other store); a placed order carries the VAT it froze. The phone never computes VAT and never holds a
// rate: every number and the rate come from the API.
//
// The law (VAT Act s.90(2)): a VAT-registered store's advertised price must include the VAT AND say so. So the
// price itself never changes here; a standard-rated item of an approved store says "incl. VAT" beside its price.
// Zero-rated and exempt items carry no VAT and say nothing. Swift's own fees never carry a store's VAT.
// ---------------------------------------------------------------------------

/** GET /customer/vendors/:id `vat`: present only while a person-approved store's VAT is in effect. */
export interface StorefrontVat {
  pricesIncludeVat: true;
  ratePercent: number;
}

/** POST/GET cart quote `vendors[].vat`: the VAT INCLUDED in that store's goods (never added on top). */
export interface CartVat {
  included: number;
  ratePercent: number;
  standardGoods: number;
  zeroRatedGoods: number;
  exemptGoods: number;
}

export type VatClass = 'STANDARD' | 'ZERO_RATED' | 'EXEMPT';

/** Reads the storefront's `vat` defensively: an older server, or any other shape, means no VAT. */
export function storefrontVat(raw: unknown): StorefrontVat | null {
  const v = raw as { pricesIncludeVat?: unknown; ratePercent?: unknown } | null | undefined;
  if (!v || v.pricesIncludeVat !== true || typeof v.ratePercent !== 'number' || !Number.isFinite(v.ratePercent)) return null;
  return { pricesIncludeVat: true, ratePercent: v.ratePercent };
}

/** The note beside an item's price: "incl. VAT" for a standard-rated item of an approved VAT store, else nothing. */
export function itemVatNote(vat: StorefrontVat | null, item: { vatClass?: string | null } | null | undefined): string | null {
  if (!vat || !item) return null;
  const cls = item.vatClass ?? 'STANDARD';
  return cls === 'STANDARD' ? 'incl. VAT' : null;
}

/** The one line under the store's name. */
export function storefrontVatLine(vat: StorefrontVat | null): string | null {
  if (!vat) return null;
  return `Prices include VAT at ${vat.ratePercent}% where it applies. Zero-rated and exempt items carry none.`;
}

/** Reads a cart store plan's `vat` defensively. */
export function cartVat(raw: unknown): CartVat | null {
  const v = raw as Partial<Record<keyof CartVat, unknown>> | null | undefined;
  if (!v || typeof v.included !== 'number' || typeof v.ratePercent !== 'number') return null;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return { included: v.included, ratePercent: v.ratePercent, standardGoods: n(v.standardGoods), zeroRatedGoods: n(v.zeroRatedGoods), exemptGoods: n(v.exemptGoods) };
}

/** The cart line under a VAT store's goods: the VAT is INSIDE the total shown, never added to it. */
export function cartVatLine(vat: CartVat | null): string | null {
  if (!vat) return null;
  return `Includes VAT of ${money(vat.included)} (${vat.ratePercent}%) on this store's goods`;
}

/** A placed order's frozen VAT (Decimal columns arrive as strings or numbers; null = the order carries no VAT). */
export function orderVatLine(order: { vatRateBps?: unknown; vatAmount?: unknown; vatSellerName?: unknown } | null | undefined): string | null {
  if (!order || order.vatRateBps == null || order.vatAmount == null) return null;
  const bps = Number(order.vatRateBps);
  const amount = Number(order.vatAmount);
  if (!Number.isFinite(bps) || !Number.isFinite(amount)) return null;
  const rate = (bps / 100).toFixed(2).replace(/\.?0+$/, '');
  const by = typeof order.vatSellerName === 'string' && order.vatSellerName.trim() ? `, charged by ${order.vatSellerName.trim()}` : '';
  return `Includes VAT of ${money(amount)} (${rate}%)${by}`;
}

/** [VAT-DOCS · owner 30 Oct 2026] How a VAT-registered store's typed prices relate to VAT. */
export type StoreVatMode = 'PRICES_INCLUDE_VAT' | 'ADD_VAT_AT_CHECKOUT';

/** The two choices, in the owner's words (the same on the web dashboard). */
export const VAT_MODE_CHOICES: ReadonlyArray<{ value: StoreVatMode; label: string }> = [
  { value: 'PRICES_INCLUDE_VAT', label: 'My prices already include VAT' },
  { value: 'ADD_VAT_AT_CHECKOUT', label: 'My prices do not include VAT' },
];

/** What each choice means for the customer (the rate always from the API). VAT Act s.90(2): the customer always sees
 *  the full price, VAT included, before ordering: Swift adds it INTO the price, never as a surprise at checkout. */
export function vatModeHelp(mode: StoreVatMode, ratePercent: number): string {
  return mode === 'ADD_VAT_AT_CHECKOUT'
    ? `Once a person at Swift approves your certificate, Swift adds ${ratePercent}% VAT to the price you type for each standard-rated item, so customers see and pay the full price, VAT included, before they order. Zero-rated and exempt items stay as you type them.`
    : 'Customers pay the prices you type; receipts show the VAT inside them.';
}

/** [VAT-DOCS] The optional row in a store's Documents list. Never required to go live. */
export const VAT_DOCUMENT_ROW = {
  title: 'VAT certificate (only if VAT-registered)',
  body: 'Only if your business is registered for VAT with the GRA. You do not need it to go live.',
} as const;

/** [VAT-DOCS] An item's price as the store edits it: the price it typed before VAT while Swift adds VAT to it (the
 *  server sends `vatListedPrice`), else the price itself. */
export function editablePrice(item: { basePrice?: unknown; vatListedPrice?: unknown } | null | undefined): string {
  if (!item) return '';
  const typed = item.vatListedPrice ?? item.basePrice;
  return typed == null ? '' : String(Number(typed));
}

/** [VAT-DOCS] The price field of an item save: an item Swift adds VAT to is edited by its price BEFORE VAT
 *  (`vatListedPrice`); any other item, and every new one, by its price as typed (`basePrice`). */
export function itemPricePayload(item: { vatListedPrice?: unknown } | null | undefined, price: number): { basePrice: number } | { vatListedPrice: number } {
  return item?.vatListedPrice != null ? { vatListedPrice: price } : { basePrice: price };
}

/** [VAT-DOCS] The line under the price of an item Swift adds VAT to: what customers pay. */
export function beforeVatNote(item: { basePrice?: unknown; vatListedPrice?: unknown } | null | undefined): string | null {
  if (item?.vatListedPrice == null || item.basePrice == null) return null;
  return `Before VAT. Customers pay ${money(Number(item.basePrice))} incl. VAT.`;
}

/** What the store's own VAT screen reads (GET /vendor/vat), as far as the status line needs it. */
export interface StoreVatStatusView {
  status: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';
  /** [VAT-DOCS] An older server sends no mode words beyond these two. */
  mode?: StoreVatMode | null;
  effective: boolean;
  ratePercent: number;
  reviewNote: string | null;
  certificate: { status: string } | null;
  approved: { number: string | null; registeredName: string | null; effectiveFrom: string | null } | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** [REVIEW-F #2103 S4] A certificate's effective date as people read it ("1 Jan 2026"): a calendar day stored as midnight
 *  UTC, read in UTC (never the evening before). A fixed month table, not Intl: the same words on every phone. */
export function calendarDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The store owner's status line (the same words as the web dashboard). Never promises VAT a person has not approved. */
export function storeVatStatusLine(v: StoreVatStatusView): string {
  switch (v.status) {
    case 'NONE':
      return 'Not VAT-registered: your prices and receipts show no VAT.';
    case 'PENDING':
      return v.certificate
        ? 'Your certificate is waiting for a person at Swift to check it. Nothing has changed for your customers yet.'
        : 'Send your GRA VAT registration certificate below. A person at Swift checks it before anything changes.';
    case 'APPROVED':
      if (!v.effective) return 'Approved, but VAT is not on your orders right now. Your prices and receipts show no VAT.';
      return `Approved from ${calendarDay(v.approved?.effectiveFrom)}. ${v.mode === 'ADD_VAT_AT_CHECKOUT'
        ? `Swift adds VAT at ${v.ratePercent}% to the prices you type for standard-rated items`
        : `Your prices include VAT at ${v.ratePercent}%`}, and receipts say “VAT charged by ${v.approved?.registeredName ?? ''} · VAT reg. no. ${v.approved?.number ?? ''}”.`;
    case 'REJECTED':
      return `Not approved${v.reviewNote ? `: ${v.reviewNote}` : ''}. Correct it and send your certificate again.`;
    case 'REVOKED':
      return `VAT withdrawn${v.reviewNote ? `: ${v.reviewNote}` : ''}. New orders carry no VAT.`;
  }
}

/** The classes a store gives its items (the rate always from the API). Before a person approved the store's VAT, nothing
 *  carries VAT yet, so the words do not say it does (REVIEW-F #2087 S4). */
export const vatClassChoices = (ratePercent: number, effective = true): ReadonlyArray<{ value: VatClass; label: string }> => [
  { value: 'STANDARD', label: effective ? `Standard (${ratePercent}% VAT inside the price)` : 'Standard (VAT once your VAT is approved)' },
  { value: 'ZERO_RATED', label: 'Zero-rated (no VAT)' },
  { value: 'EXEMPT', label: 'Exempt (no VAT)' },
];
