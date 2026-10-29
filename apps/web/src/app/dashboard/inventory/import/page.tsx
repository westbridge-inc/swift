'use client';

import { Suspense, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { ApiRequestError, BROWSER_CLIENT, getSelectedStore } from '@/lib/auth';
import { BROWSER_API_ORIGIN as API_URL } from '@/lib/browser-api-origin';
import { lazyRetry } from '@/lib/chunk-retry';
import type { ColumnChoice, ColumnReading, ImportField, MissingPolicy, SyncPreview, SyncResult } from '@/lib/catalogue-import-api';
import type { AddResult, Problem } from './panels';

// ---------------------------------------------------------------------------
// [POS-SYNC] Upload → preview → confirm → result.
//
// A file with an item-code (SKU) column is a till export: items Swift already
// has are matched by SKU and updated, new SKUs are added, and the store sees
// every change before anything is saved. A file with no SKU column can still be
// added as new items (the old import), but it can never update anything.
//
// Everything after the upload (the calls, the columns, the preview, the result)
// loads when a file is chosen, so the page's first load stays small.
// ---------------------------------------------------------------------------

const importApi = () => import('@/lib/catalogue-import-api');
const panels = () => import('./panels');
const ProblemPanel = lazyRetry(() => panels().then((m) => ({ default: m.ProblemPanel })));
const ColumnsPanel = lazyRetry(() => panels().then((m) => ({ default: m.ColumnsPanel })));
const SyncPreviewPanel = lazyRetry(() => panels().then((m) => ({ default: m.SyncPreviewPanel })));
const SyncResultPanel = lazyRetry(() => panels().then((m) => ({ default: m.SyncResultPanel })));
const AddReadyPanel = lazyRetry(() => panels().then((m) => ({ default: m.AddReadyPanel })));
const AddResultPanel = lazyRetry(() => panels().then((m) => ({ default: m.AddResultPanel })));

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
        const api = await importApi();
        r = input.file ? await api.automapXlsx(input.file, mode) : await api.automapCsv(input.csv!, mode);
      } catch (e) {
        const workbookCopy = e instanceof ApiRequestError ? e.errorDetails?.['sourceCsv'] : undefined;
        if (typeof workbookCopy === 'string') setSourceCsv(workbookCopy);
        throw e;
      }
      if (r.sourceCsv !== undefined) setSourceCsv(r.sourceCsv);
      const p = await (await importApi()).previewTillSync(r.normalizedCsv, input.missing);
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
    mutationFn: async () => (await importApi()).confirmTillSync(reading!.normalizedCsv, preview!),
    onSuccess: (r) => { setResult(r); setPreview(null); },
    onError: (e) => setError((e as Error).message),
  });

  /** The old path: no SKU column, so every row is added as a new item. */
  const readAsNew = useMutation({
    mutationFn: async () => (await importApi()).automapCsv(sourceCsv!, { tillStore: choice.tillStore, mapping: choice.mapping }),
    onSuccess: (r) => { setAddReading(r); setProblem(null); setError(null); },
    onError: (e) => setError((e as Error).message),
  });
  const addAll = useMutation({
    mutationFn: async () => (await importApi()).confirmImport(addReading!.normalizedCsv),
    onSuccess: (r) => { setAddResult(r); setAddReading(null); },
    onError: (e) => setError((e as Error).message),
  });

  async function onFile(file: File) {
    // [C2] A file chosen while the last one is still being read waits its turn: never two reads at once.
    if (read.isPending) return;
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
    const res = await fetch(`${API_URL}/api/v1/vendor/items/import/template`, {
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
        <h1 className="sw-title">Import or update your items</h1>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">
          Upload the file your till exports, as CSV or Excel. Swift matches each row to your items by its item code (SKU):
          items you already have are updated, new codes are added. You see every change first. Nothing is saved until you
          press Apply.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={downloadTemplate}
          className="flex items-center gap-2 rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-4 py-2.5 text-sm font-semibold hover:bg-[var(--swift-subtle)]"
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

      <Suspense fallback={null}>
        {problem && (
          <ProblemPanel
            problem={problem}
            sourceCsv={sourceCsv}
            addPending={readAsNew.isPending}
            onTillStore={(s) => reread({ ...choice, tillStore: s })}
            onAddAsNew={() => readAsNew.mutate()}
          />
        )}

        {fileName && headers.length > 0 && !result && !addResult && (
          <ColumnsPanel fileName={fileName} reading={reading} headers={headers} mapping={mapping} sourceCsv={sourceCsv} busy={busy} onChoose={chooseColumn} />
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
          <AddReadyPanel reading={addReading} pending={addAll.isPending} onAdd={() => addAll.mutate()} onCancel={() => setAddReading(null)} />
        )}

        {addResult && <AddResultPanel result={addResult} />}
      </Suspense>

      <div className="rounded-2xl bg-[var(--swift-subtle)] p-5 text-sm text-[var(--swift-muted)]">
        <p className="font-semibold text-[var(--swift-ink)]">How it works</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>Loyverse and QuickBooks item lists are recognised by their own columns. Other files are read by their column names, and you can change any choice.</li>
          <li>Stock changes are saved in your stock history as &ldquo;till export&rdquo;. An item at zero shows as sold out, and comes back when stock returns, unless you switched it off yourself.</li>
          <li>An item your till says is not for sale stays off, even when stock comes back, until a later file has it for sale or you switch it on.</li>
          <li>An item you mark sold out because it is not in the file comes back when a later file has it for sale, with stock if Swift counts it.</li>
          <li>A price, count or code Swift cannot read is never guessed. That row is listed for you to fix.</li>
          <li>The same file cannot be applied twice, so items sold since then are never counted back in.</li>
        </ul>
      </div>
    </div>
  );
}
