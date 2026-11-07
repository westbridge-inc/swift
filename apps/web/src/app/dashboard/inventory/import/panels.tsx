'use client';

import { FileSpreadsheet } from 'lucide-react';
import { formatMoney } from '@/lib/money';
import type {
  ColumnReading, ImportField, MissingPolicy, SyncChange, SyncPreview, SyncResult, confirmImport,
} from '@/lib/catalogue-import-api';

// [POS-SYNC] The import page's panels. Each one shows only after a file is
// chosen, so the page loads them on demand (page.tsx) and its first load stays
// small.
//
// [W2] The import calls ride in this module too (one on-demand piece for the page, page.tsx).
export { automapCsv, automapXlsx, confirmImport, confirmTillSync, previewTillSync } from '@/lib/catalogue-import-api';

export type AddResult = Awaited<ReturnType<typeof confirmImport>>;
export type Problem = { code: string; message: string; stores: string[]; headers: string[]; mapping: Partial<Record<ImportField, string>> };

const FIELD_LABELS: Array<[ImportField, string]> = [
  ['sku', 'Item code (SKU)'],
  ['name', 'Name'],
  ['category', 'Category'],
  ['basePrice', 'Selling price'],
  ['stockQuantity', 'Stock count'],
  ['isAvailable', 'For sale (yes / no)'],
  ['tracksStock', 'Till counts stock (yes / no)'],
  ['description', 'Description'],
  ['unit', 'Unit'],
];

const SOLD_OUT_WORDS: Record<NonNullable<SyncChange['soldOut']>, string> = {
  BECOMES_SOLD_OUT: 'Will show as sold out',
  BACK_ON_SALE: 'Back on sale',
  STAYS_SWITCHED_OFF: 'Stays off (you switched it off)',
  SWITCHED_OFF_BY_TILL: 'Off until your till has it for sale again, or you switch it on (your till says not for sale)',
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** A file with more than one till store, or columns Swift could not find. */
export function ProblemPanel({ problem, sourceCsv, addPending, onTillStore, onAddAsNew }: {
  problem: Problem;
  sourceCsv: string | null;
  addPending: boolean;
  onTillStore: (_store: string) => void;
  onAddAsNew: () => void;
}) {
  if (problem.code === 'CHOOSE_TILL_STORE') {
    return (
      <section className="sw-card p-6">
        <p className="font-bold">This file has more than one till store.</p>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">Choose the till store that is this Swift store. Only its prices and stock are used.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {problem.stores.map((s) => (
            <button key={s} onClick={() => onTillStore(s)}
              className="rounded-lg border border-[var(--swift-border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--swift-subtle)]">
              {s}
            </button>
          ))}
        </div>
      </section>
    );
  }
  return (
    <section className="sw-card p-6">
      <p className="font-bold">Swift could not find all the columns it needs.</p>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">{problem.message}</p>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        Choose the column that holds each one below. To update items, Swift needs the item code (SKU) and a price or a stock count.
      </p>
      {sourceCsv && (
        <button onClick={() => onAddAsNew()} disabled={addPending}
          className="mt-3 rounded-lg border border-[var(--swift-border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--swift-subtle)] disabled:opacity-50">
          My file has no item codes: add every row as a new item
        </button>
      )}
    </section>
  );
}

/** Which column holds what; the store can change any of them. */
export function ColumnsPanel({ fileName, reading, headers, mapping, sourceCsv, busy, onChoose }: {
  fileName: string;
  reading: ColumnReading | null;
  headers: string[];
  mapping: Partial<Record<ImportField, string>>;
  sourceCsv: string | null;
  busy: boolean;
  onChoose: (_field: ImportField, _header: string) => void;
}) {
  return (
    <section className="sw-card p-6">
      <p className="flex items-center gap-2 font-bold">
        <FileSpreadsheet className="h-5 w-5 text-[var(--swift-red)]" />
        {fileName}{reading?.profile && reading.profile.id !== 'generic' ? ` — read as a ${reading.profile.label}` : ''}
        {reading?.tillStore ? ` (till store: ${reading.tillStore})` : ''}
      </p>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        Which column holds what. Change any of them if Swift picked the wrong one. A cost column is never used as the price.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {FIELD_LABELS.map(([field, label]) => (
          <label key={field} className="text-sm">
            <span className="block font-semibold">{label}</span>
            <select
              aria-label={label}
              className="mt-1 w-full rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-2 py-1.5"
              value={mapping[field] ?? ''}
              disabled={!sourceCsv || busy}
              onChange={(e) => onChoose(field, e.target.value)}
            >
              <option value="">Not used</option>
              {headers.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>
        ))}
      </div>
      {!sourceCsv && (
        <p className="mt-2 text-xs text-[var(--swift-muted)]">This workbook is too large to change its columns here. Save it as CSV and upload that instead.</p>
      )}
    </section>
  );
}

export function SyncPreviewPanel({ preview, missing, busy, nothingToApply, onMissing, onApply, onCancel }: {
  preview: SyncPreview;
  missing: MissingPolicy;
  busy: boolean;
  nothingToApply: boolean;
  onMissing: (_policy: MissingPolicy) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const t = preview.totals;
  return (
    <section aria-label="Preview" className="space-y-5 sw-card p-6">
      <div>
        <h2 className="sw-heading">What will change in {preview.storeName}</h2>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">
          {plural(t.rows, 'row')} read. {plural(t.stockChanges, 'stock count')} and {plural(t.priceChanges, 'price')} change,{' '}
          {plural(t.newItems, 'new item')}, {t.unchanged.toLocaleString()} already up to date, {plural(t.needsAttention, 'row')} need attention.
        </p>
      </div>

      {preview.alreadyApplied && (
        <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
          You already applied this exact file on {new Date(preview.alreadyApplied.appliedAt).toLocaleString()}. It cannot be applied
          again, so items sold since then are not counted back in. Export a fresh file from your till.
        </p>
      )}

      {preview.changes.length > 0 && (
        <div>
          <h3 className="font-bold">Changes to your items</h3>
          <div className="mt-2 overflow-x-auto rounded-xl border border-[var(--swift-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--swift-subtle)] text-left text-xs text-[var(--swift-muted)]">
                <tr><th className="px-3 py-2">Item</th><th className="px-3 py-2">Stock</th><th className="px-3 py-2">Price</th><th className="px-3 py-2">Sold out</th></tr>
              </thead>
              <tbody>
                {preview.changes.map((c) => (
                  <tr key={c.itemId} className="border-t border-[var(--swift-border)] align-top">
                    <td className="px-3 py-2">
                      <span className="font-semibold">{c.name}</span>
                      <span className="block text-xs text-[var(--swift-muted)]">SKU {c.sku}</span>
                      {c.notes.map((n) => <span key={n} className="block text-xs text-[var(--swift-muted)]">{n}</span>)}
                    </td>
                    <td className="px-3 py-2">
                      {c.stock ? `${c.stock.from} → ${c.stock.to}` : 'No change'}
                      {c.stock?.held ? <span className="block text-xs text-[var(--swift-muted)]">till {c.stock.till}, less {c.stock.held} in open orders</span> : null}
                    </td>
                    <td className="px-3 py-2">{c.price ? `${formatMoney(c.price.from)} → ${formatMoney(c.price.to)}` : 'No change'}</td>
                    <td className="px-3 py-2">{c.soldOut ? SOLD_OUT_WORDS[c.soldOut] : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {t.priceChanges > 0 && (
            <p className="mt-2 text-xs text-[var(--swift-muted)]">
              Orders already placed keep the price they were placed at. A customer with this item in their cart sees the new price the next time the cart opens.
            </p>
          )}
        </div>
      )}

      {preview.newItems.length > 0 && (
        <div>
          <h3 className="font-bold">New items to add</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {preview.newItems.map((n) => (
              <li key={n.row}>
                {n.name} <span className="text-[var(--swift-muted)]">· SKU {n.sku} · {n.category} · {formatMoney(n.price)} · {n.stock === null ? 'stock not counted' : `${n.stock} in stock`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.needsAttention.length > 0 && (
        <div>
          <h3 className="font-bold text-[var(--swift-red)]">Rows that need attention (not used)</h3>
          <ul className="mt-2 max-h-64 space-y-1 overflow-auto text-sm text-[var(--swift-muted)]">
            {preview.needsAttention.map((n) => (
              <li key={n.row}>Row {n.row}{n.sku ? ` · SKU ${n.sku}` : ''}{n.name ? ` · ${n.name}` : ''}: {n.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {(preview.missing.length > 0 || preview.notOnSku > 0) && (
        <div>
          <h3 className="font-bold">Items on Swift that are not in this file</h3>
          {preview.missing.length > 0 && (
            <>
              <p className="mt-1 text-sm text-[var(--swift-muted)]">{plural(preview.missing.length, 'item')}: {preview.missing.slice(0, 30).map((m) => m.name).join(', ')}{preview.missing.length > 30 ? '…' : ''}</p>
              <fieldset className="mt-2 space-y-1 text-sm">
                <legend className="sr-only">What to do with items not in this file</legend>
                <label className="flex items-center gap-2">
                  <input type="radio" name="missing" checked={missing === 'LEAVE'} disabled={busy} onChange={() => onMissing('LEAVE')} />
                  Leave them as they are
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="missing" checked={missing === 'SOLD_OUT'} disabled={busy} onChange={() => onMissing('SOLD_OUT')} />
                  Mark them sold out
                </label>
              </fieldset>
            </>
          )}
          {preview.notOnSku > 0 && (
            <p className="mt-2 text-xs text-[var(--swift-muted)]">{plural(preview.notOnSku, 'item')} on Swift {preview.notOnSku === 1 ? 'is' : 'are'} without a SKU, so a file never changes {preview.notOnSku === 1 ? 'it' : 'them'}.</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onApply}
          disabled={busy || !!preview.alreadyApplied || nothingToApply}
          className="rounded-lg bg-[var(--swift-red)] px-5 py-2.5 text-sm font-bold text-white hover:bg-[var(--swift-red-600)] disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Apply these changes'}
        </button>
        <button onClick={onCancel} className="text-sm font-medium text-[var(--swift-muted)]">Cancel</button>
        {nothingToApply && !preview.alreadyApplied && <span className="text-sm text-[var(--swift-muted)]">Nothing to change: your items already match this file.</span>}
      </div>
    </section>
  );
}

export function SyncResultPanel({ result }: { result: SyncResult }) {
  const t = result.totals;
  const prices = result.changes.filter((c) => c.price);
  const waiting = result.waitingForCheck ?? [];
  return (
    <section aria-label="Result" className="sw-card p-6">
      <p className="sw-heading text-green-700">Done. Your items are updated.</p>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        {plural(t.stockChanges, 'stock count')} and {plural(t.priceChanges, 'price')} changed, {plural(t.newItems, 'item')} added
        {t.switchedOffMissing > 0 ? `, ${plural(t.switchedOffMissing, 'missing item')} marked sold out` : ''}.
        {t.needsAttention > 0 ? ` ${plural(t.needsAttention, 'row')} still need attention.` : ''}
      </p>
      {result.replayed && <p className="mt-1 text-sm text-[var(--swift-muted)]">This file had already been applied, so nothing was changed twice.</p>}
      {waiting.length > 0 && (
        <>
          <p className="mt-3 text-sm font-semibold text-amber-700">
            {plural(waiting.length, 'new item')} waiting for a quick check — hidden from customers until Swift checks {waiting.length === 1 ? 'it' : 'them'}:
          </p>
          <ul className="mt-1 max-h-64 space-y-1 overflow-auto text-sm text-[var(--swift-muted)]">
            {waiting.map((w) => <li key={w.row}>Row {w.row}: {w.name}</li>)}
          </ul>
        </>
      )}
      {prices.length > 0 && (
        <>
          <p className="mt-3 text-sm font-semibold">Price changes</p>
          <ul className="mt-1 max-h-64 space-y-1 overflow-auto text-sm text-[var(--swift-muted)]">
            {prices.map((c) => <li key={c.itemId}>{c.name}: {formatMoney(c.price!.from)} → {formatMoney(c.price!.to)}</li>)}
          </ul>
        </>
      )}
      <p className="mt-3 text-sm text-[var(--swift-muted)]">
        Review everything in <a href="/dashboard/inventory" className="font-semibold text-[var(--swift-red)]">Inventory</a>.
      </p>
    </section>
  );
}

/** The add-only import: rows ready to add as new items. */
export function AddReadyPanel({ reading, pending, onAdd, onCancel }: { reading: ColumnReading; pending: boolean; onAdd: () => void; onCancel: () => void }) {
  return (
    <section className="sw-card p-6">
      <p className="font-bold">{plural(reading.rowCount, 'row')} ready to add as new items</p>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        Without item codes, a later file cannot update these items. Uploading this file again would add them again.
      </p>
      <div className="mt-4 flex gap-3">
        <button onClick={() => onAdd()} disabled={pending}
          className="rounded-lg bg-[var(--swift-red)] px-5 py-2.5 text-sm font-bold text-white hover:bg-[var(--swift-red-600)] disabled:opacity-50">
          {pending ? 'Adding…' : `Add ${plural(reading.rowCount, 'item')}`}
        </button>
        <button onClick={() => onCancel()} className="text-sm font-medium text-[var(--swift-muted)]">Cancel</button>
      </div>
    </section>
  );
}

/** The add-only import's result. */
export function AddResultPanel({ result }: { result: AddResult }) {
  return (
    <section className="sw-card p-6">
      <p className="sw-heading text-green-700">{plural(result.imported, 'item')} added</p>
      {(result.waitingForCheckCount ?? 0) > 0 && (
        <>
          <p className="mt-2 text-sm font-semibold text-amber-700">
            {result.waitingForCheckCount} waiting for a quick check — hidden from customers until Swift checks them:
          </p>
          <ul className="mt-2 max-h-64 space-y-1 overflow-auto text-sm text-[var(--swift-muted)]">
            {(result.waitingForCheck ?? []).map((w) => (
              <li key={w.row}>Row {w.row}: {w.name}</li>
            ))}
            {(result.waitingForCheckCount ?? 0) > (result.waitingForCheck ?? []).length && (
              <li>…and {(result.waitingForCheckCount ?? 0) - (result.waitingForCheck ?? []).length} more</li>
            )}
          </ul>
        </>
      )}
      {(result.notesCount ?? 0) > 0 && (
        <>
          <p className="mt-2 text-sm font-semibold text-amber-700">
            {result.notesCount === 1 ? '1 row was' : `${result.notesCount} rows were`} imported without a photo. Photos are uploaded, never imported: add them on each item.
          </p>
          <ul className="mt-2 max-h-64 space-y-1 overflow-auto text-sm text-[var(--swift-muted)]">
            {(result.notes ?? []).map((n) => (
              <li key={n.row}>Row {n.row}: {n.note}</li>
            ))}
          </ul>
        </>
      )}
      {result.failedCount > 0 && (
        <>
          <p className="mt-2 text-sm font-semibold text-[var(--swift-red)]">{plural(result.failedCount, 'row')} not added:</p>
          <ul className="mt-2 max-h-64 space-y-1 overflow-auto text-sm text-[var(--swift-muted)]">
            {result.failures.map((f) => <li key={f.row}>Row {f.row}: {f.errors.join('; ')}</li>)}
          </ul>
        </>
      )}
      <p className="mt-3 text-sm text-[var(--swift-muted)]">
        Review everything in <a href="/dashboard/inventory" className="font-semibold text-[var(--swift-red)]">Inventory</a>.
      </p>
    </section>
  );
}
