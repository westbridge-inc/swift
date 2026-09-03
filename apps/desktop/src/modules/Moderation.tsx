import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchModerationQueue, resolveReport, type ModerationReport } from '../lib/api';
import {
  CSAE_DISPOSITIONS, closureBody, csaeActions, fieldsFor, targetSummary,
  type ClosureStatus, type CsaeDisposition,
} from '../lib/moderationView';

// UGC moderation queue (store-compliance §5.4). Consumes the STORE-001/002 API:
// report → queue → resolve. No optimistic UI (standing order 38): a decision
// renders its server result. Enforcement (ban/remove) uses the People/Vendors
// modules — resolving a report records the DECISION.

const pretty = (t: string) => t.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const hoursSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 3600_000);

function Row({ r, onResolved }: { r: ModerationReport; onResolved: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const isCsae = r.reason === 'CSAE';
  // [D-17] A child-safety closure states WHAT was decided and carries the
  // evidence that decision implies (A-17). This console used to send
  // { status, note? } with the note optional, on CSAE rows too.
  const [disposition, setDisposition] = useState<CsaeDisposition | ''>('');
  const [enforcementRef, setEnforcementRef] = useState('');
  const [authorityRef, setAuthorityRef] = useState('');
  const [evidencePreserved, setEvidencePreserved] = useState(false);
  const fields = fieldsFor(disposition);

  const mut = useMutation({
    mutationFn: (status: ClosureStatus) => resolveReport(
      r.id,
      closureBody(status, note, isCsae ? { disposition, enforcementRef, authorityRef, evidencePreserved } : null),
    ),
    onSuccess: onResolved,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className={`rounded-xl border p-4 ${isCsae ? 'border-[var(--swift-red)]/60 bg-[var(--swift-red)]/10' : 'border-neutral-200 bg-neutral-100'}`}>
      <div className="flex items-center gap-2">
        <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${isCsae ? 'bg-[var(--swift-red)] text-white' : 'bg-neutral-100 text-neutral-600'}`}>
          {pretty(r.reason)}
        </span>
        <span className="text-xs text-neutral-400">on a {pretty(r.targetType).toLowerCase()}</span>
        <span className="ml-auto text-xs text-neutral-400">{hoursSince(r.createdAt)}h ago</span>
      </div>

      <p className="mt-2 text-sm text-neutral-800">{targetSummary(r)}</p>
      {r.detail && <p className="mt-1 text-xs italic text-neutral-500">Reporter said: “{r.detail}”</p>}

      <div className="mt-3 flex items-center gap-2">
        <input
          value={note} onChange={(e) => setNote(e.target.value)} placeholder="Resolution note (optional)"
          className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-sm outline-none focus:border-[var(--swift-red)]"
        />
        {isCsae ? (
          csaeActions().map((a) => (
            <button
              key={a.status}
              onClick={() => mut.mutate(a.status)} disabled={mut.isPending}
              className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-semibold text-neutral-700 hover:bg-neutral-200 disabled:opacity-50"
            >
              {a.label}
            </button>
          ))
        ) : (
          <>
            <button
              onClick={() => mut.mutate('ACTIONED')} disabled={mut.isPending}
              className="rounded-lg bg-green-100 px-3 py-1.5 text-sm font-semibold text-green-700 hover:bg-green-200 disabled:opacity-50"
            >
              Mark handled
            </button>
            <button
              onClick={() => mut.mutate('DISMISSED')} disabled={mut.isPending}
              className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-semibold text-neutral-600 hover:bg-neutral-200 disabled:opacity-50"
            >
              Dismiss
            </button>
          </>
        )}
      </div>

      {isCsae && (
        <div className="mt-3 space-y-2 rounded-lg border border-[var(--swift-red)]/40 p-3">
          <p className="text-xs font-bold uppercase tracking-wider text-[var(--swift-red)]">
            Child-safety closure — what was decided
          </p>
          <select
            value={disposition}
            onChange={(e) => setDisposition(e.target.value as CsaeDisposition | '')}
            aria-label="Disposition"
            className="w-full rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-sm"
          >
            <option value="">Choose what was decided…</option>
            {CSAE_DISPOSITIONS.map((d) => <option key={d} value={d}>{pretty(d)}</option>)}
          </select>
          {fields.enforcementRef && (
            <input
              value={enforcementRef} onChange={(e) => setEnforcementRef(e.target.value)}
              aria-label="Enforcement reference" placeholder="Enforcement reference (the ban/removal you performed)"
              className="w-full rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-sm"
            />
          )}
          {fields.authorityRef && (
            <input
              value={authorityRef} onChange={(e) => setAuthorityRef(e.target.value)}
              aria-label="Authority reference" placeholder="Authority reference (the report you filed)"
              className="w-full rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-sm"
            />
          )}
          {fields.evidence && (
            <label className="flex items-center gap-2 text-xs text-neutral-600">
              <input
                type="checkbox" checked={evidencePreserved}
                onChange={(e) => setEvidencePreserved(e.target.checked)}
                aria-label="Evidence preserved"
              />
              The evidence is preserved and under legal hold
            </label>
          )}
          <p className="text-xs text-neutral-500">
            A dismissal takes two people. Proposing one records who asked and why, and leaves the report open for a
            second reviewer.
          </p>
        </div>
      )}
      {/* [WR-021 / VG-007] "Action taken" implied enforcement; the server only
          records the decision. Say exactly what this does — especially on CSAE
          rows, where implying content was removed would be dangerous. */}
      <p className="mt-2 text-xs text-neutral-400">
        Marking handled records your decision on the report — it does not remove content or suspend anyone. Do that
        directly on the user/vendor first if the report warrants it.
      </p>
      {error && <p className="mt-2 text-xs text-[var(--swift-red)]">{error}</p>}
    </div>
  );
}

export default function Moderation() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['moderation', 'PENDING'], queryFn: () => fetchModerationQueue('PENDING') });
  const onResolved = () => qc.invalidateQueries({ queryKey: ['moderation'] });

  if (q.isLoading) return <p className="text-sm text-neutral-500">Loading the moderation queue…</p>;
  if (q.isError) return <p className="text-sm text-[var(--swift-red)]">{(q.error as Error).message}</p>;

  // Child-safety reports float to the top of the queue (the rest stay FIFO).
  const rows = [...(q.data?.rows ?? [])].sort((a, b) => Number(b.reason === 'CSAE') - Number(a.reason === 'CSAE'));
  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-sm text-neutral-500">
        {q.data?.pendingTotal ?? 0} open report{(q.data?.pendingTotal ?? 0) === 1 ? '' : 's'} — child-safety (CSAE) first.
      </p>
      {rows.length === 0 && <p className="text-sm text-neutral-400">Nothing to review. 🎉</p>}
      {rows.map((r) => <Row key={r.id} r={r} onResolved={onResolved} />)}
    </div>
  );
}
