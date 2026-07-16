import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveDoc, documentViewUrl, fetchReviewQueue, rejectDoc, REASON_CODES, type ReviewDoc,
} from '../lib/api';

// The heart of Mission Control (spec §5.2): keyboard-first document review.
// J/K move · Space Quick Look · A approve · R reject · Esc close.
// No optimistic UI (standing order 38): a decision renders its server result.

const pretty = (t: string) => t.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const hoursSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 3600_000);

function QuickLook({ docId, onClose }: { docId: string; onClose: () => void }) {
  const url = useQuery({ queryKey: ['doc-url', docId], queryFn: () => documentViewUrl(docId), staleTime: 0 });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={onClose}>
      <div className="max-h-[85vh] max-w-[80vw]" onClick={(e) => e.stopPropagation()}>
        {url.isLoading && <p className="text-sm text-white/60">Fetching a fresh audited link…</p>}
        {url.isError && <p className="text-sm text-[var(--swift-red)]">{(url.error as Error).message}</p>}
        {url.data && (
          // The link is minted per-open and audited server-side; PDFs render
          // in the webview, images inline. Nothing is written to disk.
          <iframe
            src={url.data}
            title="document"
            className="h-[85vh] w-[70vw] rounded-xl border border-white/15 bg-white"
          />
        )}
        <p className="mt-2 text-center text-xs text-white/40">Space / Esc to close — every open is audit-logged</p>
      </div>
    </div>
  );
}

function ApprovePanel({ doc, onDone, onCancel }: { doc: ReviewDoc; onDone: () => void; onCancel: () => void }) {
  const isInsurance = doc.docType === 'vehicle_insurance';
  const [expiresAt, setExpiresAt] = useState('');
  const [insurerName, setInsurerName] = useState('');
  const [policyNumber, setPolicyNumber] = useState('');
  const [coverageClass, setCoverageClass] = useState<'HIRE' | 'PRIVATE'>('HIRE');
  const [hireConfirmed, setHireConfirmed] = useState(false);
  const [plateChecked, setPlateChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      approveDoc(doc.id, {
        ...(expiresAt ? { expiresAt } : {}),
        ...(isInsurance
          ? { insurance: { insurerName, policyNumber, coverageClass, hireClassConfirmed: hireConfirmed, plateCrossChecked: plateChecked } }
          : {}),
      }),
    onSuccess: onDone,
    onError: (e) => setError((e as Error).message),
  });

  const insuranceBlocked = isInsurance && (!insurerName || !policyNumber || !hireConfirmed || !plateChecked || coverageClass !== 'HIRE');

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <p className="text-sm font-bold text-green-400">Approve {pretty(doc.docType)}</p>
      <div className="mt-3 space-y-2">
        <label className="block text-xs text-white/50">
          Expiry date on the document (leave blank if none)
          <input
            type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm outline-none focus:border-green-500"
          />
        </label>
        {isInsurance && (
          <div className="space-y-2 border-t border-white/10 pt-2">
            <p className="text-xs font-bold text-amber-400">
              Liability gate — taxi work requires HIRE-class cover (blocking checks):
            </p>
            <input
              placeholder="Insurer name" value={insurerName} onChange={(e) => setInsurerName(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm outline-none"
            />
            <input
              placeholder="Policy number" value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm outline-none"
            />
            <select
              value={coverageClass} onChange={(e) => setCoverageClass(e.target.value as 'HIRE' | 'PRIVATE')}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm outline-none"
            >
              <option value="HIRE">HIRE / passenger coverage</option>
              <option value="PRIVATE">PRIVATE (cannot approve for taxi)</option>
            </select>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={hireConfirmed} onChange={(e) => setHireConfirmed(e.target.checked)} />
              I confirmed the policy covers hire/passenger use
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={plateChecked} onChange={(e) => setPlateChecked(e.target.checked)} />
              Plate on the policy matches the registration + photos
            </label>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => mut.mutate()}
          disabled={mut.isPending || insuranceBlocked}
          className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold disabled:opacity-40"
        >
          {mut.isPending ? 'Approving…' : 'Approve'}
        </button>
        <button onClick={onCancel} className="text-sm text-white/50">Cancel (Esc)</button>
        {error && <span className="text-xs text-[var(--swift-red)]">{error}</span>}
      </div>
    </div>
  );
}

function RejectPanel({ doc, onDone, onCancel }: { doc: ReviewDoc; onDone: () => void; onCancel: () => void }) {
  const [code, setCode] = useState<string>('UNREADABLE');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () => rejectDoc(doc.id, text.trim() || pretty(code), code),
    onSuccess: onDone,
    onError: (e) => setError((e as Error).message),
  });
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <p className="text-sm font-bold text-[var(--swift-red)]">Reject {pretty(doc.docType)}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {REASON_CODES.map((c) => (
          <button
            key={c}
            onClick={() => setCode(c)}
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${code === c ? 'bg-[var(--swift-red)] text-white' : 'border border-white/15 text-white/60'}`}
          >
            {pretty(c)}
          </button>
        ))}
      </div>
      <textarea
        value={text} onChange={(e) => setText(e.target.value)}
        placeholder="Specifics for the applicant (appended to the templated opener)"
        rows={2}
        className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm outline-none focus:border-[var(--swift-red)]"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => mut.mutate()}
          disabled={mut.isPending}
          className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold disabled:opacity-40"
        >
          {mut.isPending ? 'Rejecting…' : 'Reject + notify'}
        </button>
        <button onClick={onCancel} className="text-sm text-white/50">Cancel (Esc)</button>
        {error && <span className="text-xs text-[var(--swift-red)]">{error}</span>}
      </div>
    </div>
  );
}

export default function ReviewCenter() {
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState(0);
  const [look, setLook] = useState(false);
  const [panel, setPanel] = useState<'approve' | 'reject' | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const q = useQuery({
    queryKey: ['review-queue'],
    queryFn: () => fetchReviewQueue('PENDING'),
    refetchInterval: 30_000,
  });
  const rows = q.data?.rows ?? [];
  const current: ReviewDoc | undefined = rows[Math.min(cursor, Math.max(rows.length - 1, 0))];

  const refresh = () => {
    setPanel(null);
    queryClient.invalidateQueries({ queryKey: ['review-queue'] });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (e.key === 'Escape') setPanel(null);
        return;
      }
      if (e.key === 'j' || e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, rows.length - 1));
      if (e.key === 'k' || e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0));
      if (e.key === ' ') { e.preventDefault(); setLook((v) => !v); }
      if (e.key === 'Escape') { setLook(false); setPanel(null); }
      if (e.key === 'a' && current) setPanel('approve');
      if (e.key === 'r' && current) setPanel('reject');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows.length, current]);

  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (q.isLoading) return <p className="text-sm text-white/40">Loading the queue…</p>;
  if (q.isError) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
        <p className="text-sm text-white/60">{(q.error as Error).message}</p>
        <button onClick={() => q.refetch()} className="mt-4 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold">Try again</button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[1.1fr_1fr] gap-5">
      <div>
        <p className="mb-2 text-xs text-white/40">
          {q.data?.meta.total ?? 0} waiting · J/K move · Space quick look · A approve · R reject
        </p>
        <div ref={listRef} className="max-h-[75vh] space-y-1.5 overflow-auto pr-1">
          {rows.length === 0 && (
            <p className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-white/40">
              Queue is clear — nobody is waiting on you.
            </p>
          )}
          {rows.map((d, i) => {
            const waited = hoursSince(d.createdAt);
            const breach = waited >= 24;
            return (
              <button
                key={d.id}
                onClick={() => setCursor(i)}
                className={`block w-full rounded-xl border p-3 text-left ${i === cursor ? 'border-[var(--swift-red)] bg-[var(--swift-red)]/10' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">
                    {[d.user?.firstName, d.user?.lastName].filter(Boolean).join(' ') || d.user?.phone}
                    <span className="ml-2 text-white/40">{d.user?.countryCode}</span>
                  </p>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${breach ? 'bg-[var(--swift-red)]/20 text-[var(--swift-red)]' : 'bg-white/10 text-white/50'}`}>
                    {breach ? `${waited}h — SLA breached` : `${waited}h`}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-white/50">{pretty(d.docType)} · {d.role}</p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        {current ? (
          <>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm font-bold">{pretty(current.docType)}</p>
              <p className="mt-1 text-xs text-white/50">
                {[current.user?.firstName, current.user?.lastName].filter(Boolean).join(' ')} · {current.user?.phone} · submitted{' '}
                {new Date(current.createdAt).toLocaleString()}
              </p>
              <button
                onClick={() => setLook(true)}
                className="mt-3 rounded-lg border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5"
              >
                Quick Look (Space)
              </button>
            </div>
            {panel === 'approve' && <ApprovePanel doc={current} onDone={refresh} onCancel={() => setPanel(null)} />}
            {panel === 'reject' && <RejectPanel doc={current} onDone={refresh} onCancel={() => setPanel(null)} />}
            {panel === null && (
              <div className="flex gap-2">
                <button onClick={() => setPanel('approve')} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold">Approve (A)</button>
                <button onClick={() => setPanel('reject')} className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold">Reject (R)</button>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-white/40">Select a document.</p>
        )}
      </div>
      {look && current && <QuickLook docId={current.id} onClose={() => setLook(false)} />}
    </div>
  );
}
