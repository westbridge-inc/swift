'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  assignCustodyRelay,
  claimCustodyCase,
  confirmCustodyReturn,
  directCustodyCase,
  fetchCustodyCase,
  fetchCustodyCases,
  revealCustodyPartyPhone,
} from '@/lib/api';
import { StatusPill } from '@/components/detail';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { PhoneReveal, usePhoneReveal } from '@/components/mc/PhoneReveal';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { gyDateTime } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [AF-MOB-006] CUSTODY CASES — deliveries that went wrong AFTER pickup.
//
// The rider holds someone else's goods (and, on cash, the money they fronted
// the store). Each case needs one owner and one decision: hold where they are,
// send the goods back, or hand them to a relay rider. Nothing here moves the
// goods by itself: a relay completes only when the relay rider types the
// holder's code, and a return completes when the store (or, failing that, an
// operator) confirms the goods are back.
// ---------------------------------------------------------------------------

type Outcome = 'SUPPORT_HOLD' | 'RELAY_REQUIRED' | 'RETURN_REQUIRED';

const OUTCOME_LABEL: Record<Outcome, string> = {
  SUPPORT_HOLD: 'Hold where they are',
  RELAY_REQUIRED: 'Relay to another rider',
  RETURN_REQUIRED: 'Send it back',
};

const words = (s: string) => s.toLowerCase().replace(/_/g, ' ');
const gyd = (n: number) => `GY$${Math.round(n).toLocaleString('en-US')}`;

function CaseDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const caseQ = useQuery({ queryKey: ['custody-case', id], queryFn: () => fetchCustodyCase(id) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['custody-case', id] });
    void qc.invalidateQueries({ queryKey: ['custody-cases'] });
  };
  const [error, setError] = useState<string | null>(null);
  const onError = (e: unknown) => setError(e instanceof Error ? e.message : 'The action failed.');
  const claim = useMutation({ mutationFn: () => claimCustodyCase(id), onSuccess: refresh, onError });
  // Directing a case, naming a relay rider and confirming a return move goods
  // that belong to someone else: each is asked in the in-page panel (no browser
  // prompt), run once, and its refusal stays in view.
  const actions = useActionRunner(() => refresh());
  // [FOLLOWUPS · follows O-1] Riders' numbers are masked; "Show number" is the audited read, for this page view only.
  const { revealed, revealFor } = usePhoneReveal(actions.run);
  const busy = claim.isPending;

  if (caseQ.isLoading) return <div className="mc-loading mt-4" aria-busy="true">Loading the case…</div>;
  if (caseQ.isError) {
    return <QueryFailed error={caseQ.error} what="this custody case" onRetry={() => void caseQ.refetch()} retrying={caseQ.isFetching} className="mt-4" />;
  }
  const k = caseQ.data?.data;
  if (!k) return null;
  // The server's own marker: a case is open exactly while it has no resolvedAt.
  const open = k.resolvedAt == null;
  // What the server would accept from here: never the current state, and never
  // a return while a relay rider is on the way (call the handoff off first).
  const directable = (['SUPPORT_HOLD', 'RELAY_REQUIRED', 'RETURN_REQUIRED'] as const)
    .filter((o) => o !== k.state && !(k.state === 'TRANSFER_IN_PROGRESS' && o === 'RETURN_REQUIRED'));
  const person = (r: any, party: 'holder' | 'relay') => {
    if (!r) return '—';
    const who = `${r.user?.firstName ?? ''} ${r.user?.lastName ?? ''}`.trim();
    const role = party === 'holder' ? 'holding rider' : 'relay rider';
    return (
      <>
        {who}
        {r.user?.phone ? <>{' · '}<PhoneReveal phone={r.user.phone} revealed={revealed[`${party}:${r.id}`]} onReveal={revealFor(`${party}:${r.id}`, `Show the ${role}'s full number for order ${k.order?.orderNumber}?`, `The ${role}'s number is shown.`, (reason) => revealCustodyPartyPhone(id, party, reason))} /></> : null}
        {r.isOnline ? ' · online' : ' · offline'}
      </>
    );
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-[var(--mc-radius-sm)] bg-[var(--mc-surface)] p-3 md:grid-cols-2">
        <div><span className="mc-muted">Holding the goods: </span>{person(k.holder, 'holder')}</div>
        <div><span className="mc-muted">Relay rider: </span>{k.relayRiderId ? person(k.relay, 'relay') : '—'}</div>
        <div><span className="mc-muted">Payment: </span>{k.order?.paymentMethod}{k.order?.floatAttached > 0 ? ` · rider fronted ${gyd(k.order.floatAttached)}` : ''}</div>
        <div><span className="mc-muted">Owner: </span>{k.ownerUserId ?? 'nobody yet'}</div>
        <div><span className="mc-muted">Next page at: </span>{open ? gyDateTime(k.deadlineAt) : '—'}{k.escalationCount ? ` · escalated ${k.escalationCount}×` : ''}</div>
        <div><span className="mc-muted">Reported: </span>{words(k.reason)}{k.reasonNote ? ` — “${k.reasonNote}”` : ''}</div>
      </div>
      {k.order?.paymentMethod === 'MOBILE_MONEY' ? (
        <p className="mc-note mc-note-warn">MMG-paid: if this order is returned, the store refunds the customer directly — Swift never holds order money.</p>
      ) : null}

      {error ? <p role="alert" className="mc-alert">{error}</p> : null}
      {actions.banner}

      {open ? (
        <div className="mc-actions">
          {!k.ownerUserId ? (
            <button type="button" onClick={() => claim.mutate()} disabled={busy} className="mc-btn mc-btn-primary">
              Take this case
            </button>
          ) : null}
          {k.state !== 'RETURN_REQUIRED' && directable.map((o) => (
            <button
              key={o}
              disabled={busy}
              type="button"
              onClick={() => void actions.run({
                title: `${OUTCOME_LABEL[o]} for order ${k.order?.orderNumber}?`,
                confirmLabel: OUTCOME_LABEL[o],
                submit: ({ reason }) => directCustodyCase(id, o, reason),
                success: () => `Order ${k.order?.orderNumber}: ${OUTCOME_LABEL[o].toLowerCase()}.`,
              })}
              className="mc-btn"
            >
              {OUTCOME_LABEL[o]}
            </button>
          ))}
          {k.state === 'RELAY_REQUIRED' ? (
            <button
              disabled={busy}
              type="button"
              onClick={() => void actions.run({
                title: `Name the relay rider for order ${k.order?.orderNumber}?`,
                body: <p>The rider collects the goods from whoever holds them now.</p>,
                confirmLabel: 'Name the relay rider',
                fields: [{ kind: 'text', name: 'riderId', label: 'Rider id (from Riders)', required: true, maxLength: 64 }],
                submit: ({ reason, values }) => assignCustodyRelay(id, String(values['riderId']), reason),
                success: () => 'Relay rider named.',
              })}
              className="mc-btn mc-btn-primary"
            >
              Name the relay rider
            </button>
          ) : null}
          {k.state === 'RETURN_REQUIRED' && k.order?.status === 'RETURNING' ? (
            <button
              disabled={busy}
              type="button"
              onClick={() => void actions.run({
                title: `Record that the goods for order ${k.order?.orderNumber} are back where they came from?`,
                body: <p>Do this only when the store (or sender) cannot confirm it themselves.</p>,
                confirmLabel: 'Confirm the goods are back',
                submit: ({ reason }) => confirmCustodyReturn(id, reason),
                success: () => 'Return confirmed.',
              })}
              className="mc-btn"
            >
              Confirm the goods are back
            </button>
          ) : null}
        </div>
      ) : null}

      <div>
        <h3 className="mc-label mb-2">Trail</h3>
        <ol className="mc-muted space-y-1 text-xs">
          {(k.trail ?? []).map((t: any, i: number) => (
            <li key={i}>
              {gyDateTime(t.createdAt)} — {words(String(t.action).replace(/^CUSTODY_CASE_/, ''))}
              {t.changes?.to ? ` → ${words(t.changes.to)}` : ''}
              {t.changes?.actorRole ? ` (${words(t.changes.actorRole)})` : ''}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export default function CustodyCasesPage() {
  const [showOpen, setShowOpen] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['custody-cases', showOpen], queryFn: () => fetchCustodyCases(showOpen), refetchInterval: 30_000 });
  const rows: any[] = data?.data ?? [];

  return (
    <div className="mc-page">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="mc-muted max-w-3xl">
          Deliveries that went wrong after pickup. Each needs an owner and a decision: hold, send back, or relay. A relay completes
          only when the relay rider enters the code the holder shows them; a return completes when the store confirms the goods are back.
        </p>
        <div className="mc-tabs mb-0" role="group" aria-label="Which cases">
          {([true, false] as const).map((o) => (
            <button key={String(o)} type="button" onClick={() => setShowOpen(o)} aria-pressed={showOpen === o} className="mc-tab">
              {o ? 'Open' : 'All'}
            </button>
          ))}
        </div>
      </div>
      <div className="mc-list">
        {isLoading ? (
          <div className="mc-loading" aria-busy="true">Loading custody cases…</div>
        ) : isError ? (
          <QueryFailed error={error} what="the custody cases" onRetry={() => void refetch()} retrying={isFetching} />
        ) : rows.length === 0 ? (
          <div className="mc-empty">
            {showOpen ? 'No open custody cases.' : 'No custody cases.'}
          </div>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="mc-card">
              <button type="button" className="w-full min-h-[44px] text-left" onClick={() => setSelected(selected === r.id ? null : r.id)} aria-expanded={selected === r.id}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <StatusPill value={r.state} />
                  {r.overdue ? <span className="mc-badge mc-tone-bad">OVERDUE</span> : null}
                  <span className="font-semibold">Order {r.order?.orderNumber} · {r.order?.vendor?.name ?? 'courier'} · {words(r.reason)}</span>
                  <span className="mc-muted mc-numbers ml-auto text-xs">{gyDateTime(r.createdAt)}</span>
                </div>
              </button>
              <div className="mt-1">
                <Link href={`/orders/${r.orderId}`} className="font-semibold text-[var(--mc-accent)]">View order →</Link>
              </div>
              {selected === r.id ? <CaseDetail id={r.id} /> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
