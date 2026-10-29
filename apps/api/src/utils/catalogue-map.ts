// ---------------------------------------------------------------------------
// Retail catalogue import (spec §4.5): map a store's messy CSV headers onto
// Swift's import fields. Deterministic synonym matching is the baseline (and
// keeps it testable). Columns the synonym table cannot place are left for the
// vendor to map in the preview step — nothing guesses them.
// We only RELABEL columns — values (prices, stock) are copied verbatim, never
// invented.
//
// [POS-SYNC F1] Two till exports used to be read wrongly, both money-adjacent:
//  - "Cost" (what the store PAYS) was a price synonym, and Cost comes before
//    Price in a Loyverse items export and a QuickBooks Desktop item listing, so
//    the cost became the selling price. Cost is never a price now.
//  - The substring pass matched short synonyms inside unrelated words:
//    "Preferred Vendor" became the SKU (pREFerred), "Location" a category
//    (loCATion), "Quantity of included item" the stock. Short synonyms are now
//    exact-only, and each field names the words that disqualify a column.
// Known exports are recognised by their tell-tale columns and mapped by an
// exact profile; the store can still change any column in the preview.
// ---------------------------------------------------------------------------

/** Matched as a whole header OR inside a longer one ("Qty on Hand"). */
const SYNONYMS = {
  name: ['name', 'product', 'item', 'title', 'productname', 'itemname'],
  basePrice: ['price', 'baseprice', 'unitprice', 'sellingprice', 'retailprice', 'saleprice'],
  category: ['category', 'department', 'dept', 'section', 'group'],
  description: ['description', 'desc', 'details', 'about', 'notes'],
  sku: ['sku', 'code', 'barcode', 'itemcode', 'productcode'],
  unit: ['unit', 'uom', 'measure', 'units'],
  stockQuantity: ['stock', 'qty', 'quantity', 'stockquantity', 'onhand', 'inventory', 'count'],
} as const;

/** Matched only as the WHOLE header: too short or too vague to find inside another word. */
const EXACT_ONLY: Partial<Record<keyof typeof SYNONYMS, readonly string[]>> = {
  basePrice: ['amount'],
  category: ['cat', 'type'],
  sku: ['ref'],
};

/** A column whose header contains one of these is never this field by a substring match. */
const AVOID: Partial<Record<keyof typeof SYNONYMS, readonly string[]>> = {
  name: ['option', 'variant', 'modifier', 'included', 'category', 'supplier', 'vendor', 'customer', 'brand', 'store', 'location'],
  basePrice: ['cost', 'purchase', 'wholesale', 'compare', 'discount', 'margin', 'profit'],
  category: ['modifier', 'option', 'tax'],
  description: ['purchase'],
  sku: ['included', 'vendor', 'supplier', 'tax', 'account', 'postal', 'zip'],
  unit: ['price', 'cost'],
  stockQuantity: ['track', 'low', 'reorder', 'included', 'alert', 'minimum', 'maximum', 'order', 'sold', 'committed'],
};

export type CatalogueField = keyof typeof SYNONYMS;
/** Fields only an export profile or the store's own choice maps — never a synonym. */
export type ProfileField = 'isAvailable' | 'tracksStock';
export type MappableField = CatalogueField | ProfileField;
export type ColumnMapping = Partial<Record<MappableField, string>>;
export const MAPPABLE_FIELDS: readonly MappableField[] = [
  'name', 'basePrice', 'category', 'description', 'sku', 'unit', 'stockQuantity', 'isAvailable', 'tracksStock',
];

export const REQUIRED_FIELDS: CatalogueField[] = ['name', 'basePrice', 'category'];

/** A till sync matches on SKU and needs something to update. */
export function missingForSync(mapping: ColumnMapping): string[] {
  const missing: string[] = [];
  if (!mapping.sku) missing.push('sku');
  if (!mapping.basePrice && !mapping.stockQuantity && !mapping.isAvailable) missing.push('basePrice or stockQuantity');
  return missing;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Best-effort deterministic header -> Swift-field mapping. Pass 1 takes exact
 *  normalized matches; pass 2 falls back to substring matches for compound
 *  headers (e.g. "Qty on Hand" -> stockQuantity), skipping exact-only synonyms
 *  and any header carrying one of the field's disqualifying words. A header
 *  maps to one field. */
export function guessColumnMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  const fields = Object.keys(SYNONYMS) as CatalogueField[];

  for (const field of fields) {
    const syns = [...SYNONYMS[field], ...(EXACT_ONLY[field] ?? [])] as readonly string[];
    const hit = headers.find((h) => !used.has(h) && syns.includes(norm(h)));
    if (hit) { mapping[field] = hit; used.add(hit); }
  }
  for (const field of fields) {
    if (mapping[field]) continue;
    const syns = SYNONYMS[field] as readonly string[];
    const avoid = AVOID[field] ?? [];
    const hit = headers.find((h) => !used.has(h)
      && !avoid.some((a) => norm(h).includes(a))
      && syns.some((s) => norm(h).includes(s)));
    if (hit) { mapping[field] = hit; used.add(hit); }
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Known till exports (column layouts from the makers' own documentation; the
// fixtures in the tests are built from those layouts, never from a store's file).
// ---------------------------------------------------------------------------

export type ExportProfileId = 'loyverse' | 'quickbooks-item-listing' | 'generic';
export interface ExportProfile { id: ExportProfileId; label: string }

const PROFILE_LABELS: Record<ExportProfileId, string> = {
  loyverse: 'Loyverse items export',
  'quickbooks-item-listing': 'QuickBooks item list',
  generic: 'Your own columns',
};

/** Loyverse names a store's own columns "Price [Store]", "In stock [Store]"… */
const LOYVERSE_STORE_COLUMN = /^(price|in stock|available for sale|low stock)\s*\[(.+)\]\s*$/i;

export interface ColumnPlan {
  profile: ExportProfile;
  mapping: ColumnMapping;
  /** A multi-store Loyverse export: the till stores it covers. */
  tillStores: string[];
  /** The till store whose columns were used, when there is a choice. */
  tillStore: string | null;
}

export class TillStoreChoiceError extends Error {
  constructor(readonly stores: string[], readonly asked: string | null) {
    super(asked ? `"${asked}" is not a store in this file` : 'This file covers more than one till store');
  }
}

function detectProfile(headers: string[]): ExportProfileId {
  const has = (n: string) => headers.some((h) => norm(h) === n);
  if (has('handle') && has('trackstock')) return 'loyverse';
  if (has('item') && has('type') && has('onhand')) return 'quickbooks-item-listing';
  return 'generic';
}

function loyverseMapping(headers: string[], tillStore: string | undefined): Omit<ColumnPlan, 'profile'> {
  const exact = (n: string) => headers.find((h) => norm(h) === n);
  const stores = [...new Set(headers.map((h) => LOYVERSE_STORE_COLUMN.exec(h)?.[2]?.trim()).filter((s): s is string => !!s))];
  let chosen: string | null = null;
  if (stores.length > 1) {
    if (!tillStore) throw new TillStoreChoiceError(stores, null);
    chosen = stores.find((s) => s === tillStore.trim()) ?? null;
    if (!chosen) throw new TillStoreChoiceError(stores, tillStore);
  } else if (stores.length === 1) {
    chosen = stores[0]!;
  }
  const perStore = (label: string) => {
    if (chosen) {
      const hit = headers.find((h) => {
        const m = LOYVERSE_STORE_COLUMN.exec(h);
        return !!m && m[1]!.toLowerCase() === label && m[2]!.trim() === chosen;
      });
      if (hit) return hit;
    }
    return exact(norm(label)) ?? (label === 'price' ? exact('defaultprice') : undefined);
  };
  const mapping: ColumnMapping = {
    sku: exact('sku'),
    name: exact('name'),
    category: exact('category'),
    description: exact('description'),
    basePrice: perStore('price'),
    stockQuantity: perStore('in stock'),
    isAvailable: perStore('available for sale'),
    tracksStock: exact('trackstock'),
  };
  // "Cost", "Barcode", "SKU of included item", "Quantity of included item",
  // "Low stock" are deliberately never mapped.
  for (const k of Object.keys(mapping) as MappableField[]) if (!mapping[k]) delete mapping[k];
  return { mapping, tillStores: stores, tillStore: chosen };
}

function quickbooksMapping(headers: string[]): Omit<ColumnPlan, 'profile'> {
  const exact = (n: string) => headers.find((h) => norm(h) === n);
  // QuickBooks has no SKU column: an item's name/number ("Item") is its unique
  // key, so it is both the name and the code Swift matches on. "Type"
  // (Inventory Part, Service…) is not a category and "Preferred Vendor" is a
  // supplier — neither is mapped.
  const mapping: ColumnMapping = {
    name: exact('item'),
    sku: exact('item'),
    description: exact('description'),
    basePrice: exact('price'),
    stockQuantity: exact('onhand'),
    unit: exact('um') ?? exact('uom'),
  };
  for (const k of Object.keys(mapping) as MappableField[]) if (!mapping[k]) delete mapping[k];
  return { mapping, tillStores: [], tillStore: null };
}

/**
 * The column plan for a file: an exact profile for a recognised till export,
 * the synonym table otherwise, then the store's own choices on top. An override
 * names a header for a field, or '' to leave the field unmapped; a header that
 * is not in the file is refused by the caller (see `unknownOverrideHeaders`).
 */
export function planColumns(
  headers: string[],
  opts: { tillStore?: string; override?: ColumnMapping } = {},
): ColumnPlan {
  const id = detectProfile(headers);
  const base = id === 'loyverse'
    ? loyverseMapping(headers, opts.tillStore)
    : id === 'quickbooks-item-listing'
      ? quickbooksMapping(headers)
      : { mapping: guessColumnMapping(headers), tillStores: [], tillStore: null };
  const mapping: ColumnMapping = { ...base.mapping };
  for (const [field, header] of Object.entries(opts.override ?? {}) as Array<[MappableField, string | undefined]>) {
    if (header === undefined) continue;
    if (header === '') delete mapping[field];
    else mapping[field] = header;
  }
  return { profile: { id, label: PROFILE_LABELS[id] }, mapping, tillStores: base.tillStores, tillStore: base.tillStore };
}

export function unknownOverrideHeaders(headers: string[], override: ColumnMapping | undefined): string[] {
  return Object.values(override ?? {}).filter((h): h is string => !!h && !headers.includes(h));
}

export interface NormalizedRow {
  category: string;
  name: string;
  description: string;
  basePrice: string;
  sku: string;
  unit: string;
  stockQuantity: string;
  /** 'true' | 'false' when the file says so; '' when it does not. */
  isAvailable?: string;
}

const YES = new Set(['y', 'yes', 'true', '1']);
const NO = new Set(['n', 'no', 'false', '0']);
/** A yes/no cell as the canonical 'true'/'false'; anything else is kept verbatim (and refused downstream). */
function yesNo(value: string): string {
  const v = value.trim().toLowerCase();
  if (v === '') return '';
  if (YES.has(v)) return 'true';
  if (NO.has(v)) return 'false';
  return value.trim();
}

/** Relabel each messy row to Swift fields. Copies values verbatim; the only
 *  readings are yes/no columns, and a "does not track stock" row drops its count
 *  (a till that does not count an item has no count to give). */
export function applyMapping(rows: Record<string, string>[], mapping: ColumnMapping): NormalizedRow[] {
  const pick = (row: Record<string, string>, field: MappableField) =>
    mapping[field] ? (row[mapping[field]!] ?? '').trim() : '';
  return rows.map((row) => {
    const tracks = mapping.tracksStock ? yesNo(pick(row, 'tracksStock')) : '';
    return {
      category: pick(row, 'category'),
      name: pick(row, 'name'),
      description: pick(row, 'description'),
      basePrice: pick(row, 'basePrice'),
      sku: pick(row, 'sku'),
      unit: pick(row, 'unit'),
      stockQuantity: tracks === 'false' ? '' : pick(row, 'stockQuantity'),
      isAvailable: mapping.isAvailable ? yesNo(pick(row, 'isAvailable')) : '',
    };
  });
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Serialize normalized rows into the canonical import-template CSV. */
export function toImportCsv(rows: NormalizedRow[]): string {
  const header = 'category,name,description,basePrice,sku,unit,stockQuantity,isAvailable,fulfillment,imageUrl';
  const lines = rows.map((r) =>
    [r.category, r.name, r.description, r.basePrice, r.sku, r.unit, r.stockQuantity, r.isAvailable ?? '', '', '']
      .map(csvCell)
      .join(','),
  );
  return [header, ...lines].join('\n');
}

/** A header->value row set back to CSV with its own headers (so a workbook can be re-mapped by the store). */
export function toSourceCsv(headers: string[], rows: Record<string, string>[]): string {
  return [headers.map(csvCell).join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h] ?? '')).join(','))].join('\n');
}
