// ---------------------------------------------------------------------------
// Retail catalogue import (spec §4.5): map a store's messy CSV headers onto
// Swift's import fields. Deterministic synonym matching is the baseline (and
// keeps it testable without the AI); AiService.mapCatalogueColumns fills gaps.
// We only RELABEL columns — values (prices, stock) are copied verbatim, never
// invented.
// ---------------------------------------------------------------------------

const SYNONYMS = {
  name: ['name', 'product', 'item', 'title', 'productname', 'itemname'],
  basePrice: ['price', 'cost', 'amount', 'baseprice', 'unitprice', 'sellingprice', 'retailprice'],
  category: ['category', 'cat', 'department', 'dept', 'type', 'section', 'group'],
  description: ['description', 'desc', 'details', 'about', 'notes'],
  sku: ['sku', 'code', 'barcode', 'itemcode', 'productcode', 'ref'],
  unit: ['unit', 'uom', 'measure', 'units'],
  stockQuantity: ['stock', 'qty', 'quantity', 'stockquantity', 'onhand', 'inventory', 'count'],
} as const;

export type CatalogueField = keyof typeof SYNONYMS;
export type ColumnMapping = Partial<Record<CatalogueField, string>>;

export const REQUIRED_FIELDS: CatalogueField[] = ['name', 'basePrice', 'category'];

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Best-effort deterministic header -> Swift-field mapping. Pass 1 takes exact
 *  normalized matches; pass 2 falls back to substring matches for compound
 *  headers (e.g. "Qty on Hand" -> stockQuantity). A header maps to one field. */
export function guessColumnMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  const fields = Object.keys(SYNONYMS) as CatalogueField[];

  for (const field of fields) {
    const syns = SYNONYMS[field] as readonly string[];
    const hit = headers.find((h) => !used.has(h) && syns.includes(norm(h)));
    if (hit) { mapping[field] = hit; used.add(hit); }
  }
  for (const field of fields) {
    if (mapping[field]) continue;
    const syns = SYNONYMS[field] as readonly string[];
    const hit = headers.find((h) => !used.has(h) && syns.some((s) => norm(h).includes(s)));
    if (hit) { mapping[field] = hit; used.add(hit); }
  }
  return mapping;
}

export interface NormalizedRow {
  category: string;
  name: string;
  description: string;
  basePrice: string;
  sku: string;
  unit: string;
  stockQuantity: string;
}

/** Relabel each messy row to Swift fields. Copies values verbatim. */
export function applyMapping(rows: Record<string, string>[], mapping: ColumnMapping): NormalizedRow[] {
  const pick = (row: Record<string, string>, field: CatalogueField) =>
    mapping[field] ? (row[mapping[field]!] ?? '').trim() : '';
  return rows.map((row) => ({
    category: pick(row, 'category'),
    name: pick(row, 'name'),
    description: pick(row, 'description'),
    basePrice: pick(row, 'basePrice'),
    sku: pick(row, 'sku'),
    unit: pick(row, 'unit'),
    stockQuantity: pick(row, 'stockQuantity'),
  }));
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Serialize normalized rows into the canonical import-template CSV. */
export function toImportCsv(rows: NormalizedRow[]): string {
  const header = 'category,name,description,basePrice,sku,unit,stockQuantity,isAvailable,fulfillment,imageUrl';
  const lines = rows.map((r) =>
    [r.category, r.name, r.description, r.basePrice, r.sku, r.unit, r.stockQuantity, '', '', '']
      .map(csvCell)
      .join(','),
  );
  return [header, ...lines].join('\n');
}
