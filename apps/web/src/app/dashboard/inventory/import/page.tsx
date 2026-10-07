'use client';

import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { ApiRequestError, BROWSER_CLIENT, getSelectedStore } from '@/lib/auth';
import { BROWSER_API_ORIGIN as API_URL } from '@/lib/browser-api-origin';
import { formatMoney } from '@/lib/money';
import {
  automapCsv, automapXlsx, confirmImport, confirmTillSync, previewTillSync, templateUrl,
  type ColumnChoice, type ColumnReading, type ImportField, type MissingPolicy, type SyncChange, type SyncPreview, type SyncResult,
} from '@/lib/vendor-api';

// ---------------------------------------------------------------------------
// [POS-SYNC] Upload → preview → confirm → result.
//
// A file with an item-code (SKU) column is a till export: items Swift already
// has are matched by SKU and updated, new SKUs are added, and the store sees
// every change before anything is saved. A file with no SKU column can still be
// added as new items (the old import), but it can never update anything.
// ---------------------------------------------------------------------------

type AddResult = { imported: number; failedCount: number; failures: Array<{ row: number; errors: string[] }> };
type Problem = { code: string; message: string; stores: string[]; headers: string[]; mapping: Partial<Record<ImportField, string>> };

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
  SWITCHED_OFF_BY_TILL: 'Will be switched off (your till says not for sale)',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function problemOf(e: unknown): Problem | null {
  if (!(e instanceof ApiRequestError) || !e.code) return null;
  const d = e.errorDetails ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const mapping = d['mapping'] && typeof d['mapping'] === 'object' ? (d['mapping'] as Partial<Record<ImportField, string>>) : {};
  return { code: e.code, message: e.message, stores: list(d['stores']), headers: list(d['headers']), mapping };
}

export default function ImportPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  /** The file's own columns as CSV (a CSV's text, or a workbook's copy), so columns can be chosen again. */
  const [sourceCsv, setSourceCsv] = useState<string | null>(null);
  const [choice, setChoice] = useState<ColumnChoice>({});
  const [reading, setReading] = useState<ColumnReading | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [missing, setMissing] = useState<MissingPolicy>('LEAVE');
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [addReading, setAddReading] = useState<ColumnReading | null>(null);
  const [addResult, setAddResult] = useState<AddResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setReading(null); setProblem(null); setPreview(null); setResult(null);
    setAddReading(null); setAddResult(null); setError(null);
  }

  /** Read the columns, then (when there is a SKU column) preview the sync. */
  const read = useMutation({
    mutationFn: async (input: { file?: File; csv?: string; choice: ColumnChoice; missing: MissingPolicy }) => {
      const mode = { ...input.choice, mode: 'sync' as const };
      let r: ColumnReading;
      try {
        r = input.file ? await automapXlsx(input.file, mode) : await automapCsv(input.csv!, mode);
      } catch (e) {
        const workbookCopy = e instanceof ApiRequestError ? e.errorDetails?.['sourceCsv'] : undefined;
        if (typeof workbookCopy === 'string') setSourceCsv(workbookCopy);
        throw e;
      }
      if (r.sourceCsv !== undefined) setSourceCsv(r.sourceCsv);
      const p = await previewTillSync(r.normalizedCsv, input.missing);
      return { r, p };
    },
    onSuccess: ({ r, p }) => { setReading(r); setPreview(p); setProblem(null); },
    onError: (e) => {
      setPreview(null);
      const p = problemOf(e);
      if (p && (p.code === 'CHOOSE_TILL_STORE' || p.code === 'UNMAPPED_COLUMNS' || p.code === 'UNKNOWN_COLUMN')) {
        setProblem(p);
        setError(null);
      } else {
        setError((e as Error).message);
      }
    },
  });

  const apply = useMutation({
    mutationFn: () => confirmTillSync(reading!.normalizedCsv, preview!),
    onSuccess: (r) => { setResult(r); setPreview(null); },
    onError: (e) => setError((e as Error).message),
  });

  /** The old path: no SKU column, so every row is added as a new item. */
  const readAsNew = useMutation({
    mutationFn: () => automapCsv(sourceCsv!, { tillStore: choice.tillStore, mapping: choice.mapping }),
    onSuccess: (r) => { setAddReading(r); setProblem(null); setError(null); },
    onError: (e) => setError((e as Error).message),
  });
  const addAll = useMutation({
    mutationFn: () => confirmImport(addReading!.normalizedCsv),
    onSuccess: (r) => { setAddResult(r); setAddReading(null); },
    onError: (e) => setError((e as Error).message),
  });

  async function onFile(file: File) {
    reset();
    setFileName(file.name);
    setChoice({});
    setMissing('LEAVE');
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      setSourceCsv(null);
      read.mutate({ file, choice: {}, missing: 'LEAVE' });
    } else {
      const text = await file.text();
      setSourceCsv(text);
      read.mutate({ csv: text, choice: {}, missing: 'LEAVE' });
    }
  }

  /** Read the same file again with the store's own choices. */
  function reread(next: ColumnChoice, nextMissing = missing) {
    if (!sourceCsv) return;
    setChoice(next);
    setMissing(nextMissing);
    setResult(null);
    setError(null);
    read.mutate({ csv: sourceCsv, choice: next, missing: nextMissing });
  }

  function chooseColumn(field: ImportField, header: string) {
    reread({ ...choice, mapping: { ...(choice.mapping ?? {}), [field]: header } });
  }

  async function downloadTemplate() {
    // The template route needs the session + store headers — fetch it, then save.
    // [W-01] The session rides as an HttpOnly cookie, so this raw fetch must send
    // credentials and name itself a browser client; there is no bearer to attach.
    const store = getSelectedStore();
    const res = await fetch(`${API_URL}/api/v1${templateUrl().replace('/api/v1', '')}`, {
      credentials: 'include',
      headers: { 'X-Swift-Client': BROWSER_CLIENT, ...(store ? { 'x-vendor-id': store } : {}) },
    });
    // [WR-042] An error body must never download as a .csv the vendor opens
    // in Excel and mistakes for the template.
    if (!res.ok) {
      setError(`Couldn't download the template (${res.status}) — try again.`);
      return;
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'swift-catalogue-template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const headers = reading?.headers ?? problem?.headers ?? [];
  const mapping = reading?.mapping ?? problem?.mapping ?? {};
  const busy = read.isPending || apply.isPending;
  const nothingToApply = preview
    && preview.changes.length === 0 && preview.newItems.length === 0 && preview.totals.switchedOffMissing === 0;

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">Import or update your items</h1>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">
          Upload the file your till exports, as CSV or Excel. Swift matches each row to your items by its item code (SKU):
          items you already have are updated, new codes are added. You see every change first. Nothing is saved until you
          press Apply.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={downloadTemplate}
          className="flex items-center gap-2 rounded-lg border border-black/10 bg-white px-4 py-2.5 text-sm font-semibold hover:bg-[var(--swift-subtle)]"
        >
          <Download className="h-4 w-4" /> Download the template
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg bg-[var(--swift-red)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--swift-red-600)] disabled:opacity-50"
        >
          <Upload className="h-4 w-4" /> {read.isPending ? 'Reading…' : 'Upload a file'}
        </button>
        <input
          ref={fileRef}
          type="file"
          aria-label="Choose a CSV or Excel file"
          accept=".csv,.xlsx,.xls,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = '';
          }}
        />
      </div>

      {error && <p role="alert" className="rounded-xl bg-[var(--swift-red)]/5 p-4 text-sm text-[var(--swift-red)]">{error}</p>}

      {problem?.code === 'CHOOSE_TILL_STORE' && (
        <section className="rounded-2xl border border-black/5 bg-white p-6">
          <p className="font-bold">This file has more than one till store.</p>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">Choose the till store that is this Swift store. Only its prices and stock are used.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {problem.stores.map((s) => (
              <button key={s} onClick={() => reread({ ...choice, tillStore: s })}
                className="rounded-lg border border-black/10 px-4 py-2 text-sm font-semibold hover:bg-[var(--swift-subtle)]">
                {s}
              </button>
            ))}
          </div>
        </section>
      )}

      {problem && problem.code !== 'CHOOSE_TILL_STORE' && (
        <section className="rounded-2xl border border-black/5 bg-white p-6">
          <p className="font-bold">Swift could not find all the columns it needs.</p>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">{problem.message}</p>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">
            Choose the column that holds each one below. To update items, Swift needs the item code (SKU) and a price or a stock count.
          </p>
          {sourceCsv && (
            <button onClick={() => readAsNew.mutate()} disabled={readAsNew.isPending}
              className="mt-3 rounded-lg border border-black/10 px-4 py-2 text-sm font-semibold hover:bg-[var(--swift-subtle)] disabled:opacity-50">
              My file has no item codes: add every row as a new item
            </button>
          )}
        </section>
      )}

      {fileName && headers.length > 0 && !result && !addResult && (
        <section className="rounded-2xl border border-black/5 bg-white p-6">
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
                  className="mt-1 w-full rounded-lg border border-black/10 bg-white px-2 py-1.5"
                  value={mapping[field] ?? ''}
                  disabled={!sourceCsv || busy}
                  onChange={(e) => chooseColumn(field, e.target.value)}
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
      )}

      {preview && (
        <SyncPreviewPanel
          preview={preview}
          missing={missing}
          busy={busy}
          nothingToApply={!!nothingToApply}
          onMissing={(m) => reread(choice, m)}
          onApply={() => { setError(null); apply.mutate(); }}
          onCancel={() => { reset(); setFileName(null); }}
        />
      )}

      {result && <SyncResultPanel result={result} />}

      {addReading && (
        <section className="rounded-2xl border border-black/5 bg-white p-6">
          <p className="font-bold">{plural(addReading.rowCount, 'row')} ready to add as new items</p>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">
            Without item codes, a later file cannot update these items. Uploading this file again would add them again.
          </p>
          <div className="mt-4 flex gap-3">
            <button onClick={() => addAll.mutate()} disabled={addAll.isPending}
              className="rounded-lg bg-[var(--swift-red)] px-5 py-2.5 text-sm font-bold text-white hover:bg-[var(--swift-red-600)] disabled:opacity-50">
              {addAll.isPending ? 'Adding…' : `Add ${plural(addReading.rowCount, 'item')}`}
            </button>
            <button onClick={() => setAddReading(null)} className="text-sm font-medium text-[var(--swift-muted)]">Cancel</button>
          </div>
        </section>
      )}

      {addResult && (
        <section className="rounded-2xl border border-black/5 bg-white p-6">
          <p className="text-lg font-extrabold text-green-700">{plural(addResult.imported, 'item')} added</p>
          {addResult.failedCount > 0 && (
            <>
              <p className="mt-2 text-sm font-semibold text-[var(--swift-red)]">{plural(addResult.failedCount, 'row')} not added:</p>
              <ul className="mt-2 max-h-64 space-y-1 overflow-auto text-sm text-[var(--swift-muted)]">
                {addResult.failures.map((f) => <li key={f.row}>Row {f.row}: {f.errors.join('; ')}</li>)}
              </ul>
            </>
          )}
          <p className="mt-3 text-sm text-[var(--swift-muted)]">
            Review everything in <a href="/dashboard/inventory" className="font-semibold text-[var(--swift-red)]">Inventory</a>.
          </p>
        </section>
      )}

      <div className="rounded-2xl bg-[var(--swift-subtle)] p-5 text-sm text-[var(--swift-muted)]">
        <p className="font-semibold text-[var(--swift-ink)]">How it works</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>Loyverse and QuickBooks item lists are recognised by their own columns. Other files are read by their column names, and you can change any choice.</li>
          <li>Stock changes are saved in your stock history as &ldquo;till export&rdquo;. An item at zero shows as sold out, and comes back when stock returns, unless you switched it off yourself.</li>
          <li>A price, count or code Swift cannot read is never guessed. That row is listed for you to fix.</li>
          <li>The same file cannot be applied twice, so items sold since then are never counted back in.</li>
        </ul>
      </div>
    </div>
  );
}

function SyncPreviewPanel({ preview, missing, busy, nothingToApply, onMissing, onApply, onCancel }: {
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
    <section aria-label="Preview" className="space-y-5 rounded-2xl border border-black/5 bg-white p-6">
      <div>
        <h2 className="text-lg font-extrabold">What will change in {preview.storeName}</h2>
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
          <div className="mt-2 overflow-x-auto rounded-xl border border-black/5">
            <table className="w-full text-sm">
              <thead className="bg-[var(--swift-subtle)] text-left text-xs uppercase tracking-wide text-[var(--swift-muted)]">
                <tr><th className="px-3 py-2">Item</th><th className="px-3 py-2">Stock</th><th className="px-3 py-2">Price</th><th className="px-3 py-2">Sold out</th></tr>
              </thead>
              <tbody>
                {preview.changes.map((c) => (
                  <tr key={c.itemId} className="border-t border-black/5 align-top">
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
            <p className="mt-2 text-xs text-[var(--swift-muted)]">{plural(preview.notOnSku, 'item')} on Swift {preview.notOnSku === 1 ? 'has' : 'have'} no SKU, so a file never changes {preview.notOnSku === 1 ? 'it' : 'them'}.</p>
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

function SyncResultPanel({ result }: { result: SyncResult }) {
  const t = result.totals;
  const prices = result.changes.filter((c) => c.price);
  return (
    <section aria-label="Result" className="rounded-2xl border border-black/5 bg-white p-6">
      <p className="text-lg font-extrabold text-green-700">Done. Your items are updated.</p>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        {plural(t.stockChanges, 'stock count')} and {plural(t.priceChanges, 'price')} changed, {plural(t.newItems, 'item')} added
        {t.switchedOffMissing > 0 ? `, ${plural(t.switchedOffMissing, 'missing item')} marked sold out` : ''}.
        {t.needsAttention > 0 ? ` ${plural(t.needsAttention, 'row')} still need attention.` : ''}
      </p>
      {result.replayed && <p className="mt-1 text-sm text-[var(--swift-muted)]">This file had already been applied, so nothing was changed twice.</p>}
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
