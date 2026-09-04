import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchIncidents, incidentAction, decideIncident, fetchEvidenceForCase, evidenceAction,
  fetchSosAlerts, ackSosAlert, resolveSosAlert, fetchOpsAlerts, ackOpsAlert, raiseIncident,
  type OpsAlertRow,
} from '../lib/api';
import {
  availableActions, clocksFor, worstSla, queueOrder, reasonProblem, evidenceActions,
  sosUrgency, pretty, DECISION_CODES, SOS_RESOLUTION_CODES, SEAL_WARNING, EXPORT_WARNING,
  INCIDENT_CATEGORIES, SEVERITIES, defaultSeverityFor, intakeProblem,
  type IncidentRow, type SosRow, type DecisionCode, type IncidentSeverity,
  type SosResolutionCode, type IncidentAction, type EvidenceAction, type SlaState,
  type IntakeDraft,
} from '../lib/safetyView';

// ---------------------------------------------------------------------------
// THE SAFETY OPERATIONS CONSOLE.
//
// Swift could already detect an incident, page ops, open and seal an evidence
// bundle, place a legal hold and prepare an encrypted police export. 23 routes,
// tested, and no screen anywhere let a human do any of it. On the day something
// happened there was nowhere to stand.
//
// No optimistic UI (standing order 38): every action renders the server's
// result. During an emergency an operator has to be able to trust that what the
// screen says happened, happened.
// ---------------------------------------------------------------------------

const SLA_TONE: Record<SlaState, string> = {
  breached: 'bg-[var(--swift-red)] text-white',
  due: 'bg-amber-500 text-white',
  ok: 'bg-neutral-100 text-neutral-600',
  met: 'bg-neutral-100 text-neutral-500',
};

const SEVERITY_TONE: Record<string, string> = {
  S0: 'bg-[var(--swift-red)] text-white',
  S1: 'bg-[var(--swift-red)]/80 text-white',
  S2: 'bg-amber-500 text-white',
  S3: 'bg-neutral-200 text-neutral-700',
  S4: 'bg-neutral-200 text-neutral-700',
};

function Clocks({ c }: { c: IncidentRow }) {
  return (
    <span className="flex gap-1">
      {clocksFor(c).map((k) => (
        <span key={k.label} className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${SLA_TONE[k.state]}`}>
          {k.label}{' '}
          {k.state === 'met' ? 'done'
            : k.state === 'breached' ? `${Math.abs(k.minutes)}m over`
            : `${k.minutes}m`}
        </span>
      ))}
    </span>
  );
}

/** The chain-of-custody gate. Nothing that touches evidence happens without a
 *  reason that will still make sense when it is read back in an investigation. */
function ReasonGate({
  label, warning, busy, onConfirm, onCancel,
}: { label: string; warning?: string; busy: boolean; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const problem = reasonProblem(reason);
  return (
    <div className="mt-2 rounded-lg border border-neutral-300 bg-neutral-50 p-3">
      <p className="text-xs font-semibold text-neutral-700">{label}</p>
      {warning && <p className="mt-1 text-xs text-neutral-600">{warning}</p>}
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        autoFocus
        placeholder="Why are you opening this? It is logged against your name."
        className="mt-2 w-full rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-[var(--swift-red)]"
      />
      {reason.trim().length > 0 && problem && <p className="mt-1 text-xs text-[var(--swift-red)]">{problem}</p>}
      <div className="mt-2 flex gap-2">
        <button
          disabled={problem !== null || busy}
          onClick={() => onConfirm(reason.trim())}
          className="rounded-lg bg-[var(--swift-red)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >
          {busy ? 'Working…' : label}
        </button>
        <button onClick={onCancel} className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs">Cancel</button>
      </div>
    </div>
  );
}

function EvidencePanel({ caseId }: { caseId: string }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<EvidenceAction | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['evidence', caseId], queryFn: () => fetchEvidenceForCase(caseId) });

  const mut = useMutation({
    mutationFn: ({ action, reason }: { action: EvidenceAction; reason: string }) =>
      evidenceAction(q.data!.id, action, reason),
    onSuccess: (data, vars) => {
      setPending(null);
      setError(null);
      // §9.2 — the export passphrase is returned EXACTLY once and Swift keeps
      // no copy. Showing it and then losing it on a refetch would be worse
      // than not offering the export at all, so it is held in view until the
      // operator dismisses it.
      const pass = (data as { passphrase?: string }).passphrase;
      setResult(vars.action === 'export' && pass
        ? `Export ready. Passphrase (shown once, hand it over separately): ${pass}`
        : `${pretty(vars.action)} recorded.`);
      void qc.invalidateQueries({ queryKey: ['evidence', caseId] });
    },
    onError: (e) => setError((e as Error).message),
  });

  if (q.isPending) return <p className="mt-2 text-xs text-neutral-500">Looking for the evidence bundle…</p>;
  if (!q.data) return <p className="mt-2 text-xs text-neutral-500">No evidence bundle is attached to this case.</p>;

  const b = q.data;
  return (
    <div className="mt-3 rounded-lg border border-neutral-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono font-semibold">{b.bundleNumber}</span>
        <span className="text-neutral-500">{b._count.items} item{b._count.items === 1 ? '' : 's'}</span>
        {b.sealedAt
          ? <span className="rounded-md bg-neutral-800 px-1.5 py-0.5 text-[11px] text-white">Sealed</span>
          : <span className="rounded-md bg-amber-500 px-1.5 py-0.5 text-[11px] text-white">Unsealed</span>}
        {b.legalHold && <span className="rounded-md bg-[var(--swift-red)] px-1.5 py-0.5 text-[11px] text-white">Legal hold</span>}
      </div>
      {b.sealHash && <p className="mt-1 break-all font-mono text-[11px] text-neutral-500">seal {b.sealHash}</p>}

      <div className="mt-2 flex flex-wrap gap-2">
        {evidenceActions(b).map((a) => (
          <button
            key={a}
            onClick={() => { setPending(a); setResult(null); setError(null); }}
            className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs hover:border-[var(--swift-red)]"
          >
            {pretty(a)}
          </button>
        ))}
      </div>

      {pending && (
        <ReasonGate
          label={pretty(pending)}
          {...(pending === 'seal' ? { warning: SEAL_WARNING } : pending === 'export' ? { warning: EXPORT_WARNING } : {})}
          busy={mut.isPending}
          onConfirm={(reason) => mut.mutate({ action: pending, reason })}
          onCancel={() => setPending(null)}
        />
      )}
      {result && (
        <div className="mt-2 rounded-lg border border-neutral-300 bg-neutral-50 p-2">
          <p className="break-all text-xs text-neutral-800">{result}</p>
          <button onClick={() => setResult(null)} className="mt-1 text-[11px] underline">Dismiss</button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-[var(--swift-red)]">{error}</p>}
    </div>
  );
}

function IncidentCard({ c, onDone }: { c: IncidentRow; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<DecisionCode | ''>('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const sla = worstSla(c);

  const act = useMutation({
    mutationFn: (a: IncidentAction) =>
      a === 'decide' ? decideIncident(c.id, decision as DecisionCode, notes || undefined) : incidentAction(c.id, a),
    onSuccess: () => { setError(null); onDone(); },
    onError: (e) => setError((e as Error).message),
  });

  const actions = availableActions(c);
  return (
    <div className={`rounded-xl border p-4 ${sla === 'breached' ? 'border-[var(--swift-red)]/60 bg-[var(--swift-red)]/5' : 'border-neutral-200 bg-neutral-50'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${SEVERITY_TONE[c.severity] ?? 'bg-neutral-200'}`}>{c.severity}</span>
        <span className="font-mono text-xs font-semibold">{c.caseNumber}</span>
        <span className="text-xs text-neutral-500">{pretty(c.category)}</span>
        <span className="rounded-md bg-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-700">{pretty(c.status)}</span>
        {c.escalatedPoliceAt && <span className="rounded-md bg-[var(--swift-red)] px-1.5 py-0.5 text-[11px] text-white">Police</span>}
        {c.legalHold && <span className="rounded-md bg-neutral-800 px-1.5 py-0.5 text-[11px] text-white">Legal hold</span>}
        {c.interimAction !== 'NONE' && <span className="rounded-md bg-amber-500 px-1.5 py-0.5 text-[11px] text-white">{pretty(c.interimAction)}</span>}
        <span className="ml-auto"><Clocks c={c} /></span>
      </div>

      <p className="mt-2 text-sm text-neutral-800">{c.summary}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {actions.filter((a) => a !== 'decide').map((a) => (
          <button
            key={a}
            disabled={act.isPending}
            onClick={() => act.mutate(a)}
            className={`rounded-lg px-2.5 py-1 text-xs disabled:opacity-40 ${
              a === 'escalate-police'
                ? 'bg-[var(--swift-red)] font-semibold text-white'
                : 'border border-neutral-300 hover:border-[var(--swift-red)]'
            }`}
          >
            {pretty(a)}
          </button>
        ))}
        <button onClick={() => setOpen(!open)} className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs">
          {open ? 'Hide evidence' : 'Evidence'}
        </button>
      </div>

      {actions.includes('decide') && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-white p-2">
          <select
            value={decision}
            onChange={(e) => setDecision(e.target.value as DecisionCode)}
            className="rounded-lg border border-neutral-200 px-2 py-1 text-xs"
          >
            <option value="">Decision…</option>
            {DECISION_CODES.map((d) => <option key={d} value={d}>{pretty(d)}</option>)}
          </select>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            className="min-w-0 flex-1 rounded-lg border border-neutral-200 px-2 py-1 text-xs outline-none focus:border-[var(--swift-red)]"
          />
          <button
            disabled={!decision || act.isPending}
            onClick={() => act.mutate('decide')}
            className="rounded-lg bg-[var(--swift-red)] px-3 py-1 text-xs font-semibold text-white disabled:opacity-40"
          >
            Record decision
          </button>
        </div>
      )}

      {open && <EvidencePanel caseId={c.id} />}
      {error && <p className="mt-2 text-xs text-[var(--swift-red)]">{error}</p>}
    </div>
  );
}

function SosCard({ a, onDone }: { a: SosRow; onDone: () => void }) {
  const [code, setCode] = useState<SosResolutionCode | ''>('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const urgency = sosUrgency(a);

  const ack = useMutation({ mutationFn: () => ackSosAlert(a.id), onSuccess: onDone, onError: (e) => setError((e as Error).message) });
  const resolve = useMutation({
    mutationFn: () => resolveSosAlert(a.id, code as SosResolutionCode, notes || undefined),
    onSuccess: onDone,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className={`rounded-xl border p-4 ${urgency === 'critical' ? 'border-[var(--swift-red)] bg-[var(--swift-red)]/10' : 'border-neutral-200 bg-neutral-50'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-[var(--swift-red)] px-2 py-0.5 text-xs font-bold text-white">SOS</span>
        <span className="rounded-md bg-neutral-200 px-1.5 py-0.5 text-[11px]">{pretty(a.status)}</span>
        <span className="text-xs text-neutral-500">{pretty(a.actorRole)} · {pretty(a.triggerSource)}</span>
        {a.retriggerCount > 0 && (
          <span className="rounded-md bg-[var(--swift-red)] px-1.5 py-0.5 text-[11px] font-semibold text-white">
            asked again ×{a.retriggerCount}
          </span>
        )}
        <span className="ml-auto text-xs text-neutral-500">{new Date(a.triggeredAt).toLocaleTimeString()}</span>
      </div>

      {/* The coercion doctrine, on screen. The schema says it on the column
          itself — "NEVER auto-resolves; a human must" — because a person under
          duress can be made to tap it. So it is shown as a REASON TO CALL, and
          it never dims the row. */}
      {a.userSafeFlaggedAt && (
        <p className="mt-2 rounded-lg border border-amber-500 bg-amber-50 px-2 py-1.5 text-xs text-neutral-800">
          They tapped “I’m safe”. That does not close this — call back and verify before resolving.
        </p>
      )}

      <p className="mt-2 text-sm text-neutral-800">
        {a.triggerAddressText ?? (a.triggerLat != null && a.triggerLng != null ? `${a.triggerLat.toFixed(5)}, ${a.triggerLng.toFixed(5)}` : 'No location was captured.')}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!a.acknowledgedAt && (
          <button
            disabled={ack.isPending}
            onClick={() => ack.mutate()}
            className="rounded-lg bg-[var(--swift-red)] px-3 py-1 text-xs font-semibold text-white disabled:opacity-40"
          >
            Acknowledge
          </button>
        )}
        <select value={code} onChange={(e) => setCode(e.target.value as SosResolutionCode)} className="rounded-lg border border-neutral-300 px-2 py-1 text-xs">
          <option value="">Resolution…</option>
          {SOS_RESOLUTION_CODES.map((c) => <option key={c} value={c}>{pretty(c)}</option>)}
        </select>
        <input
          value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes"
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-2 py-1 text-xs outline-none focus:border-[var(--swift-red)]"
        />
        <button
          disabled={!code || resolve.isPending}
          onClick={() => resolve.mutate()}
          className="rounded-lg border border-neutral-300 px-3 py-1 text-xs disabled:opacity-40"
        >
          Resolve
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-[var(--swift-red)]">{error}</p>}
    </div>
  );
}

function OpsAlertCard({ p, onDone }: { p: OpsAlertRow; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({ mutationFn: () => ackOpsAlert(p.id), onSuccess: onDone, onError: (e) => setError((e as Error).message) });
  const overdue = new Date(p.ackDeadlineAt).getTime() < Date.now();
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-xl border p-3 ${overdue ? 'border-[var(--swift-red)]/60 bg-[var(--swift-red)]/5' : 'border-neutral-200 bg-neutral-50'}`}>
      <span className="rounded-md bg-neutral-200 px-1.5 py-0.5 text-[11px]">{pretty(p.kind)}</span>
      <span className="text-sm text-neutral-800">{p.title}</span>
      {p.escalationLevel > 0 && (
        <span className="rounded-md bg-[var(--swift-red)] px-1.5 py-0.5 text-[11px] text-white">escalated ×{p.escalationLevel}</span>
      )}
      <span className="ml-auto text-xs text-neutral-500">
        {overdue ? 'ack deadline passed' : `ack by ${new Date(p.ackDeadlineAt).toLocaleTimeString()}`}
      </span>
      <button
        disabled={mut.isPending}
        onClick={() => mut.mutate()}
        className="rounded-lg bg-[var(--swift-red)] px-3 py-1 text-xs font-semibold text-white disabled:opacity-40"
      >
        Acknowledge
      </button>
      {error && <p className="w-full text-xs text-[var(--swift-red)]">{error}</p>}
    </div>
  );
}

/**
 * Raising a case by hand — the operator on a phone call.
 *
 * Everything else in this console reacts to something the platform already
 * detected. This is the path for what it did not: a call to the office, a
 * message forwarded by a driver, a report that arrived any way but through the
 * app. Without it the queue only ever contains what the machine noticed.
 */
function RaiseCase({ onRaised }: { onRaised: () => void }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState<IntakeDraft>({ subjectUserId: '', category: '', severity: '', summary: '', orderId: '' });
  const [error, setError] = useState<string | null>(null);
  // Fixed per form instance: a retried submission is ONE case, not two. [S-08]
  const [key] = useState(() => `mc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const mut = useMutation({
    mutationFn: () => raiseIncident({
      subjectUserId: d.subjectUserId.trim(),
      category: d.category,
      summary: d.summary.trim(),
      idempotencyKey: key,
      ...(d.severity ? { severity: d.severity } : {}),
      ...(d.orderId.trim() ? { orderId: d.orderId.trim() } : {}),
    }),
    onSuccess: () => {
      setD({ subjectUserId: '', category: '', severity: '', summary: '', orderId: '' });
      setOpen(false);
      setError(null);
      onRaised();
    },
    onError: (e) => setError((e as Error).message),
  });

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="self-start rounded-lg border border-neutral-300 px-3 py-1.5 text-xs hover:border-[var(--swift-red)]">
        Raise a case
      </button>
    );
  }

  const problem = intakeProblem(d);
  const effective = d.severity || (d.category ? defaultSeverityFor(d.category) : '');
  return (
    <div className="rounded-xl border border-neutral-300 bg-white p-4">
      <p className="text-sm font-semibold">Raise a case</p>
      <div className="mt-2 flex flex-col gap-2">
        <input
          value={d.subjectUserId} onChange={(e) => setD({ ...d, subjectUserId: e.target.value })}
          placeholder="Who is this about? (user id)"
          className="rounded-lg border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-[var(--swift-red)]"
        />
        <div className="flex flex-wrap gap-2">
          <select
            value={d.category}
            onChange={(e) => setD({ ...d, category: e.target.value, severity: '' })}
            className="rounded-lg border border-neutral-200 px-2 py-1.5 text-sm"
          >
            <option value="">Category…</option>
            {INCIDENT_CATEGORIES.map((c) => <option key={c.code} value={c.code}>{pretty(c.code)} ({c.severity})</option>)}
          </select>
          <select
            value={d.severity}
            onChange={(e) => setD({ ...d, severity: e.target.value as IncidentSeverity })}
            className="rounded-lg border border-neutral-200 px-2 py-1.5 text-sm"
          >
            <option value="">{d.category ? `Default (${defaultSeverityFor(d.category)})` : 'Severity…'}</option>
            {SEVERITIES.map((sv) => <option key={sv} value={sv}>{sv}</option>)}
          </select>
          <input
            value={d.orderId} onChange={(e) => setD({ ...d, orderId: e.target.value })}
            placeholder="Order id (optional)"
            className="min-w-0 flex-1 rounded-lg border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-[var(--swift-red)]"
          />
        </div>
        <textarea
          value={d.summary} onChange={(e) => setD({ ...d, summary: e.target.value })}
          rows={2} placeholder="What happened?"
          className="rounded-lg border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-[var(--swift-red)]"
        />
        {/* The SLA the operator is committing to, BEFORE they commit to it —
            an S0 starts a five-minute acknowledgement clock. */}
        {effective && (
          <p className="text-xs text-neutral-600">
            This opens at <span className="font-semibold">{effective}</span>
            {effective === 'S0' && ' — a five-minute acknowledgement clock starts immediately.'}
          </p>
        )}
        <div className="flex gap-2">
          <button
            disabled={problem !== null || mut.isPending}
            onClick={() => mut.mutate()}
            className="rounded-lg bg-[var(--swift-red)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            {mut.isPending ? 'Opening…' : 'Open case'}
          </button>
          <button onClick={() => { setOpen(false); setError(null); }} className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs">Cancel</button>
          {problem && <span className="self-center text-xs text-neutral-500">{problem}</span>}
        </div>
        {error && <p className="text-xs text-[var(--swift-red)]">{error}</p>}
      </div>
    </div>
  );
}

type Tab = 'alerts' | 'cases' | 'pages';

export default function Safety() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('alerts');
  const [scope, setScope] = useState<'open' | 'breached' | 'all'>('open');

  // A live emergency is not a page you refresh by hand.
  const sos = useQuery({ queryKey: ['sos', 'open'], queryFn: () => fetchSosAlerts('open'), refetchInterval: 15_000 });
  const cases = useQuery({ queryKey: ['incidents', scope], queryFn: () => fetchIncidents(scope), refetchInterval: 60_000 });
  const pages = useQuery({ queryKey: ['ops-alerts'], queryFn: fetchOpsAlerts, refetchInterval: 30_000 });

  const liveCount = sos.data?.length ?? 0;
  const breachedCount = (cases.data ?? []).filter((c) => worstSla(c) === 'breached').length;

  const TABS: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'alerts', label: 'Live alerts', count: liveCount },
    { key: 'cases', label: 'Cases', count: cases.data?.length ?? 0 },
    { key: 'pages', label: 'Unacknowledged pages', count: pages.data?.length ?? 0 },
  ];

  return (
    <section className="flex flex-col gap-4 p-6">
      <header>
        <h1 className="text-lg font-semibold">Safety</h1>
        <p className="text-sm text-neutral-500">
          {liveCount > 0
            ? `${liveCount} alert${liveCount === 1 ? '' : 's'} still open.`
            : 'No open alerts.'}
          {breachedCount > 0 && ` ${breachedCount} case${breachedCount === 1 ? '' : 's'} past an SLA.`}
        </p>
      </header>

      <nav className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-sm ${tab === t.key ? 'bg-[var(--swift-red)] font-semibold text-white' : 'border border-neutral-300'}`}
          >
            {t.label}{t.count > 0 ? ` (${t.count})` : ''}
          </button>
        ))}
      </nav>

      {tab === 'alerts' && (
        <div className="flex flex-col gap-3">
          {sos.isPending && <p className="text-sm text-neutral-500">Loading the alert feed…</p>}
          {sos.error && <p className="text-sm text-[var(--swift-red)]">{(sos.error as Error).message}</p>}
          {sos.data?.length === 0 && <p className="text-sm text-neutral-500">Nothing open. This board reloads itself every 15 seconds.</p>}
          {sos.data?.map((a) => (
            <SosCard key={a.id} a={a} onDone={() => void qc.invalidateQueries({ queryKey: ['sos'] })} />
          ))}
        </div>
      )}

      {tab === 'cases' && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            {(['open', 'breached', 'all'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`rounded-lg px-2.5 py-1 text-xs ${scope === s ? 'bg-neutral-800 text-white' : 'border border-neutral-300'}`}
              >
                {pretty(s)}
              </button>
            ))}
          </div>
          <RaiseCase onRaised={() => void qc.invalidateQueries({ queryKey: ['incidents'] })} />
          {cases.isPending && <p className="text-sm text-neutral-500">Loading cases…</p>}
          {cases.error && <p className="text-sm text-[var(--swift-red)]">{(cases.error as Error).message}</p>}
          {cases.data?.length === 0 && <p className="text-sm text-neutral-500">No cases in this view.</p>}
          {queueOrder(cases.data ?? []).map((c) => (
            <IncidentCard key={c.id} c={c} onDone={() => void qc.invalidateQueries({ queryKey: ['incidents'] })} />
          ))}
        </div>
      )}

      {tab === 'pages' && (
        <div className="flex flex-col gap-3">
          {pages.isPending && <p className="text-sm text-neutral-500">Loading pages…</p>}
          {pages.error && <p className="text-sm text-[var(--swift-red)]">{(pages.error as Error).message}</p>}
          {pages.data?.length === 0 && <p className="text-sm text-neutral-500">Every page has been acknowledged.</p>}
          {pages.data?.map((p) => (
            <OpsAlertCard key={p.id} p={p} onDone={() => void qc.invalidateQueries({ queryKey: ['ops-alerts'] })} />
          ))}
        </div>
      )}
    </section>
  );
}
