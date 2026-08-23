'use client';

import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { getToken, getSelectedStore } from '@/lib/auth';
import { automapCsv, automapXlsx, confirmImport, templateUrl } from '@/lib/vendor-api';

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000';

type Preview = { mapping: Record<string, string>; rowCount: number; preview: Record<string, string>[]; normalizedCsv: string };
type Result = { imported: number; failedCount: number; failures: Array<{ row: number; errors: string[] }> };

export default function ImportPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const analyze = useMutation({
    mutationFn: async (file: File) => {
      setError(null);
      setResult(null);
      setFileName(file.name);
      if (/\.(xlsx|xls)$/i.test(file.name)) return automapXlsx(file);
      return automapCsv(await file.text());
    },
    onSuccess: setPreview,
    onError: (e) => { setPreview(null); setError((e as Error).message); },
  });

  const doImport = useMutation({
    mutationFn: () => confirmImport(preview!.normalizedCsv),
    onSuccess: (r) => { setResult(r); setPreview(null); },
    onError: (e) => setError((e as Error).message),
  });

  async function downloadTemplate() {
    // The template route needs the auth + store headers — fetch it, then save.
    const store = getSelectedStore();
    const res = await fetch(`${API_URL}/api/v1${templateUrl().replace('/api/v1', '')}`, {
      headers: { Authorization: `Bearer ${getToken()}`, ...(store ? { 'x-vendor-id': store } : {}) },
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

  const cols = preview ? Object.keys(preview.preview[0] ?? {}) : [];

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">Bulk import</h1>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">
          Upload your whole catalogue at once — CSV or Excel, up to thousands of rows. Swift maps your columns
          automatically; you confirm before anything is created.
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
          disabled={analyze.isPending}
          className="flex items-center gap-2 rounded-lg bg-[var(--swift-red)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--swift-red-600)] disabled:opacity-50"
        >
          <Upload className="h-4 w-4" /> {analyze.isPending ? 'Reading…' : 'Upload CSV / Excel'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,.xls,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) analyze.mutate(f);
            e.target.value = '';
          }}
        />
      </div>

      {error && <p className="rounded-xl bg-[var(--swift-red)]/5 p-4 text-sm text-[var(--swift-red)]">{error}</p>}

      {preview && (
        <div className="rounded-2xl border border-black/5 bg-white p-6">
          <p className="flex items-center gap-2 font-bold">
            <FileSpreadsheet className="h-5 w-5 text-[var(--swift-red)]" />
            {fileName} — {preview.rowCount.toLocaleString()} rows ready
          </p>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">
            Columns mapped: {Object.entries(preview.mapping).filter(([, v]) => v).map(([k, v]) => `${v} → ${k}`).join(' · ')}
          </p>

          <div className="mt-4 overflow-x-auto rounded-xl border border-black/5">
            <table className="w-full text-xs">
              <thead className="bg-[var(--swift-subtle)] text-left uppercase tracking-wide text-[var(--swift-muted)]">
                <tr>{cols.map((c) => <th key={c} className="px-3 py-2">{c}</th>)}</tr>
              </thead>
              <tbody>
                {preview.preview.map((row, i) => (
                  <tr key={i} className="border-t border-black/5">
                    {cols.map((c) => <td key={c} className="max-w-48 truncate px-3 py-2">{row[c]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-[var(--swift-muted)]">Showing the first {preview.preview.length} rows.</p>

          <div className="mt-4 flex gap-3">
            <button
              onClick={() => doImport.mutate()}
              disabled={doImport.isPending}
              className="rounded-lg bg-[var(--swift-red)] px-5 py-2.5 text-sm font-bold text-white hover:bg-[var(--swift-red-600)] disabled:opacity-50"
            >
              {doImport.isPending ? 'Importing…' : `Import ${preview.rowCount.toLocaleString()} items`}
            </button>
            <button onClick={() => setPreview(null)} className="text-sm font-medium text-[var(--swift-muted)]">Cancel</button>
          </div>
        </div>
      )}

      {result && (
        <div className="rounded-2xl border border-black/5 bg-white p-6">
          <p className="text-lg font-extrabold text-green-700">✓ {result.imported.toLocaleString()} items imported</p>
          {result.failedCount > 0 && (
            <>
              <p className="mt-2 text-sm font-semibold text-[var(--swift-red)]">{result.failedCount} rows failed:</p>
              <ul className="mt-2 max-h-64 space-y-1 overflow-auto text-sm text-[var(--swift-muted)]">
                {result.failures.map((f) => (
                  <li key={f.row}>Row {f.row}: {f.errors.join('; ')}</li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-3 text-sm text-[var(--swift-muted)]">
            New categories were created automatically from your category column. Review everything in{' '}
            <a href="/dashboard/inventory" className="font-semibold text-[var(--swift-red)]">Inventory</a>.
          </p>
        </div>
      )}

      <div className="rounded-2xl bg-[var(--swift-subtle)] p-5 text-sm text-[var(--swift-muted)]">
        <p className="font-semibold text-[var(--swift-ink)]">How mapping works</p>
        <p className="mt-1">
          Headers like <i>Product, Description, Price, Qty, Category, SKU</i> are recognized automatically — including
          most POS exports. Prices are never invented: a row without a valid price fails visibly instead of guessing.
        </p>
      </div>
    </div>
  );
}
