import { apiFetch } from './auth';

// [POS-SYNC] The catalogue import and till export sync calls. Only the import
// page uses them, so they live outside vendor-api.ts: every dashboard page that
// loads vendor-api.ts would otherwise download them too.

const V = '/api/v1/vendor';

// ── CSV / Excel import (the desktop star) ────────────────────────────────────

/** The Swift fields a file's columns can be read into (the server's MAPPABLE_FIELDS). */
export type ImportField = 'sku' | 'name' | 'category' | 'basePrice' | 'stockQuantity' | 'description' | 'unit' | 'isAvailable' | 'tracksStock';
export interface ColumnReading {
  mapping: Partial<Record<ImportField, string>>;
  profile?: { id: string; label: string };
  headers?: string[];
  tillStores?: string[];
  tillStore?: string | null;
  rowCount: number;
  preview: Record<string, string>[];
  normalizedCsv: string;
  /** An Excel file's own columns as CSV, so its columns can be chosen again. */
  sourceCsv?: string | null;
}
export interface ColumnChoice {
  /** 'sync' = a till re-upload matched by SKU; omitted = add new items. */
  mode?: 'sync';
  tillStore?: string;
  /** Header per field; '' = do not use this field. */
  mapping?: Partial<Record<ImportField, string>>;
}
export const automapCsv = (csv: string, choice: ColumnChoice = {}) =>
  apiFetch(`${V}/items/import/automap`, { method: 'POST', body: JSON.stringify({ csv, ...choice }) }).then(
    (r) => r.data as ColumnReading,
  );
export const automapXlsx = (file: File, choice: Pick<ColumnChoice, 'mode' | 'tillStore'> = {}) => {
  const form = new FormData();
  form.append('file', file);
  const query = new URLSearchParams();
  if (choice.mode) query.set('mode', choice.mode);
  if (choice.tillStore) query.set('tillStore', choice.tillStore);
  const qs = query.toString();
  return apiFetch(`${V}/items/import/xlsx${qs ? `?${qs}` : ''}`, { method: 'POST', body: form }).then(
    (r) => r.data as ColumnReading,
  );
};

// ── Till export sync (re-upload updates matching items) ──────────────────────
export type MissingPolicy = 'LEAVE' | 'SOLD_OUT';
export interface SyncChange {
  row: number; sku: string; itemId: string; name: string; fileName: string;
  /** `till` = the file's count; `held` = units in Swift orders not yet collected, taken off it. */
  stock: { from: number | null; to: number | null; till?: number; held?: number } | null;
  price: { from: number; to: number } | null;
  soldOut: 'BECOMES_SOLD_OUT' | 'BACK_ON_SALE' | 'STAYS_SWITCHED_OFF' | 'SWITCHED_OFF_BY_TILL' | null;
  notes: string[];
}
export interface SyncPlanView {
  storeId: string;
  storeName: string;
  uploadId: string;
  contentHash: string;
  missingPolicy: MissingPolicy;
  changes: SyncChange[];
  unchanged: number;
  newItems: Array<{ row: number; sku: string; name: string; category: string; price: number; stock: number | null; isAvailable: boolean }>;
  needsAttention: Array<{ row: number; sku: string; name: string; reason: string }>;
  missing: Array<{ itemId: string; sku: string; name: string; action: 'LEAVE' | 'SWITCH_OFF' | 'ALREADY_OFF' }>;
  notOnSku: number;
  totals: Record<'rows' | 'matched' | 'stockChanges' | 'priceChanges' | 'becomeSoldOut' | 'backOnSale' | 'switchedOffByTill' | 'newItems' | 'needsAttention' | 'missing' | 'switchedOffMissing' | 'unchanged', number>;
}
export interface SyncPreview extends SyncPlanView {
  planDigest: string;
  alreadyApplied: { uploadId: string; appliedAt: string } | null;
}
export interface SyncResult extends SyncPlanView {
  appliedAt: string; replayed: boolean;
  /** [GUARDRAILS §8] New items a banned word holds for a quick check (absent on older servers). */
  waitingForCheck?: Array<{ row: number; name: string }>;
}

export const previewTillSync = (csv: string, missing: MissingPolicy) =>
  apiFetch(`${V}/items/import/sync/preview`, { method: 'POST', body: JSON.stringify({ csv, missing }) }).then(
    (r) => r.data as SyncPreview,
  );
export const confirmTillSync = (csv: string, preview: SyncPreview) =>
  apiFetch(`${V}/items/import/sync/confirm`, {
    method: 'POST',
    body: JSON.stringify({
      csv, missing: preview.missingPolicy, uploadId: preview.uploadId,
      contentHash: preview.contentHash, planDigest: preview.planDigest,
    }),
  }).then((r) => r.data as SyncResult);
export const confirmImport = (csv: string) =>
  apiFetch(`${V}/items/import`, { method: 'POST', body: JSON.stringify({ csv }) }).then(
    (r) => r.data as {
      imported: number; failedCount: number; failures: Array<{ row: number; errors: string[] }>;
      /** [GUARDRAILS §8] Imported rows a banned word is holding for a quick check (absent on older servers). */
      waitingForCheck?: Array<{ row: number; name: string }>; waitingForCheckCount?: number;
      /** [IMAGES-E2E PR4] Imported rows whose photo address was not used (absent on older servers). */
      notes?: Array<{ row: number; note: string }>; notesCount?: number;
    },
  );
