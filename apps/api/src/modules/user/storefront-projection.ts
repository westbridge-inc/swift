/**
 * [Row 77] The public storefront's field allowlist.
 *
 * GET /customer/vendors/:id is a guest read: anyone with a link sees it. It
 * used to spread raw category and item rows into the response, which shipped
 * tenant ids, exact stock counts and alert thresholds, SKUs and barcodes, the
 * internal load integer (`bulkUnits`, which the item schema says never crosses
 * the wire) and audit timestamps. Every row below is built field
 * by field, so a column added to the schema later stays private until someone
 * decides to publish it here.
 */

/** Item stock is published only as "sold out" (0) or "not sold out" (null):
 *  clients test `stockQuantity === 0`; the real count is the store's business. */
export function publicStockQuantity(stockQuantity: number | null): 0 | null {
  return stockQuantity === 0 ? 0 : null;
}

interface OptionRow {
  id: string;
  name: string;
  additionalPrice: unknown;
  isDefault: boolean;
  isAvailable: boolean;
  sortOrder: number;
}

interface OptionGroupRow {
  id: string;
  name: string;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
  options: OptionRow[];
}

interface ItemRow {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  basePrice: unknown;
  fulfillment: string;
  bookingConfig: unknown;
  isAvailable: boolean;
  isPopular: boolean;
  unit: string | null;
  stockQuantity: number | null;
  dietaryTags: string[];
  allergens: string[];
  totalOrdered: number;
  sortOrder: number;
  optionGroups: OptionGroupRow[];
}

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  sortOrder: number;
  items: ItemRow[];
}

interface ImageRow { id: string; url: string; caption: string | null; sortOrder: number }
interface HoursRow { id: string; dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean }

function publicOption(o: OptionRow) {
  // additionalPrice keeps its existing wire form (the web client types it as a
  // string); this projection changes WHICH fields ship, never their encoding.
  return {
    id: o.id,
    name: o.name,
    additionalPrice: o.additionalPrice,
    isDefault: o.isDefault,
    isAvailable: o.isAvailable,
    sortOrder: o.sortOrder,
  };
}

function publicOptionGroup(g: OptionGroupRow) {
  return {
    id: g.id,
    name: g.name,
    isRequired: g.isRequired,
    minSelect: g.minSelect,
    maxSelect: g.maxSelect,
    sortOrder: g.sortOrder,
    options: g.options.map(publicOption),
  };
}

export function publicStorefrontItem(item: ItemRow) {
  // Zero markup — customers pay the vendor base price (revenue = subscriptions).
  const price = Number(item.basePrice);
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    imageUrl: item.imageUrl,
    basePrice: price,
    customerPrice: price,
    fulfillment: item.fulfillment,
    bookingConfig: item.bookingConfig,
    isAvailable: item.isAvailable,
    isPopular: item.isPopular,
    unit: item.unit,
    stockQuantity: publicStockQuantity(item.stockQuantity),
    dietaryTags: item.dietaryTags,
    allergens: item.allergens,
    // Kept on purpose: the store app build under review (1.0.0 build 9) sorts
    // its "Best sellers" row by this field. The store-level `totalOrders` is
    // already public on the same page. Replace with a rank once build 9 is
    // superseded.
    totalOrdered: item.totalOrdered,
    sortOrder: item.sortOrder,
    optionGroups: item.optionGroups.map(publicOptionGroup),
  };
}

export function publicStorefrontCategory(cat: CategoryRow) {
  return {
    id: cat.id,
    name: cat.name,
    description: cat.description,
    imageUrl: cat.imageUrl,
    sortOrder: cat.sortOrder,
    items: cat.items.map(publicStorefrontItem),
  };
}

export function publicStorefrontImage(img: ImageRow) {
  return { id: img.id, url: img.url, caption: img.caption, sortOrder: img.sortOrder };
}

export function publicOperatingHours(h: HoursRow) {
  return { id: h.id, dayOfWeek: h.dayOfWeek, openTime: h.openTime, closeTime: h.closeTime, isClosed: h.isClosed };
}
