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
} from '@/lib/api';
import { StatusPill } from '@/components/detail';
import { askReason } from '@/lib/ask-reason';

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
  const { data, isLoading } = useQuery({ queryKey: ['custody-case', id], queryFn: () => fetchCustodyCase(id) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['custody-case', id] });
    void qc.invalidateQueries({ queryKey: ['custody-cases'] });
  };
  const [error, setError] = useState<string | null>(null);
  const onError = (e: unknown) => setError(e instanceof Error ? e.message : 'The action failed.');
  const claim = useMutation({ mutationFn: () => claimCustodyCase(id), onSuccess: refresh, onError });
  const direct = useMutation({
    mutationFn: ({ outcome, reason }: { outcome: Outcome; reason: string }) => directCustodyCase(id, outcome, reason),
    onSuccess: refresh, onError,
  });
  const relay = useMutation({
    mutationFn: ({ riderId, reason }: { riderId: string; reason: string }) => assignCustodyRelay(id, riderId, reason),
    onSuccess: refresh, onError,
  });
  const back = useMutation({ mutationFn: (reason: string) => confirmCustodyReturn(id, reason), onSuccess: refresh, onError });
  const busy = claim.isPending || direct.isPending || relay.isPending || back.isPending;

  if (isLoading) return <div className="h-24 rounded-xl bg-[var(--panel)] animate-pulse" />;
  const k = data?.data;
  if (!k) return null;
  // The server's own marker: a case is open exactly while it has no resolvedAt.
  const open = k.resolvedAt == null;
  // What the server would accept from here: never the current state, and never
  // a return while a relay rider is on the way (call the handoff off first).
  const directable = (['SUPPORT_HOLD', 'RELAY_REQUIRED', 'RETURN_REQUIRED'] as const)
    .filter((o) => o !== k.state && !(k.state === 'TRANSFER_IN_PROGRESS' && o === 'RETURN_REQUIRED'));
  const person = (r: any) => (r ? `${r.user?.firstName ?? ''} ${r.user?.lastName ?? ''}`.trim() + (r.user?.phone ? ` · ${r.user.phone}` : '') + (r.isOnline ? ' · online' : ' · offline') : '—');

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        <div><span className="text-[var(--muted)]">Holding the goods: </span>{person(k.holder)}</div>
        <div><span className="text-[var(--muted)]">Relay rider: </span>{k.relayRiderId ? person(k.relay) : '—'}</div>
        <div><span className="text-[var(--muted)]">Payment: </span>{k.order?.paymentMethod}{k.order?.floatAttached > 0 ? ` · rider fronted ${gyd(k.order.floatAttached)}` : ''}</div>
        <div><span className="text-[var(--muted)]">Owner: </span>{k.ownerUserId ?? 'nobody yet'}</div>
        <div><span className="text-[var(--muted)]">Next page at: </span>{open ? new Date(k.deadlineAt).toLocaleString() : '—'}{k.escalationCount ? ` · escalated ${k.escalationCount}×` : ''}</div>
        <div><span className="text-[var(--muted)]">Reported: </span>{words(k.reason)}{k.reasonNote ? ` — “${k.reasonNote}”` : ''}</div>
      </div>
      {k.order?.paymentMethod === 'MOBILE_MONEY' ? (
        <p className="text-sm text-amber-400">MMG-paid: if this order is returned, the store refunds the customer directly — Swift never holds order money.</p>
      ) : null}

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {open ? (
        <div className="flex flex-wrap gap-2">
          {!k.ownerUserId ? (
            <button onClick={() => claim.mutate()} disabled={busy} className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] disabled:opacity-50">
              Take this case
            </button>
          ) : null}
          {k.state !== 'RETURN_REQUIRED' && directable.map((o) => (
            <button
              key={o}
              disabled={busy}
              onClick={() => {
                const reason = askReason({ action: OUTCOME_LABEL[o].toLowerCase(), subject: `order ${k.order?.orderNumber}` });
                if (reason) direct.mutate({ outcome: o, reason });
              }}
              className="px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
            >
              {OUTCOME_LABEL[o]}
            </button>
          ))}
          {k.state === 'RELAY_REQUIRED' ? (
            <button
              disabled={busy}
              onClick={() => {
                const riderId = window.prompt('Rider id of the relay rider (from Riders):')?.trim();
                if (!riderId) return;
                const reason = askReason({ action: 'name this relay rider', subject: `order ${k.order?.orderNumber}` });
                if (reason) relay.mutate({ riderId, reason });
              }}
              className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] disabled:opacity-50"
            >
              Name the relay rider
            </button>
          ) : null}
          {k.state === 'RETURN_REQUIRED' && k.order?.status === 'RETURNING' ? (
            <button
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Record that the goods are back where they came from? Do this only when the store (or sender) cannot confirm it themselves.')) return;
                const reason = askReason({ action: 'confirm this return', subject: `order ${k.order?.orderNumber}` });
                if (reason) back.mutate(reason);
              }}
              className="px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
            >
              Confirm the goods are back
            </button>
          ) : null}
        </div>
      ) : null}

      <div>
        <h3 className="text-sm font-semibold mb-2">Trail</h3>
        <ol className="space-y-1 text-xs text-[var(--muted)]">
          {(k.trail ?? []).map((t: any, i: number) => (
            <li key={i}>
              {new Date(t.createdAt).toLocaleString()} — {words(String(t.action).replace(/^CUSTODY_CASE_/, ''))}
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
  const { data, isLoading } = useQuery({ queryKey: ['custody-cases', showOpen], queryFn: () => fetchCustodyCases(showOpen), refetchInterval: 30_000 });
  const rows: any[] = data?.data ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">Custody cases</h1>
        <div className="flex gap-1">
          {([true, false] as const).map((o) => (
            <button
              key={String(o)}
              onClick={() => setShowOpen(o)}
              className={`px-2.5 py-1 rounded-lg text-xs ${showOpen === o ? 'bg-white text-black font-semibold' : 'bg-white/5 text-[var(--muted)] hover:bg-white/10'}`}
            >
              {o ? 'open' : 'all'}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[var(--muted)] text-sm mb-6">
        Deliveries that went wrong after pickup. Each needs an owner and a decision: hold, send back, or relay. A relay completes
        only when the relay rider enters the code the holder shows them; a return completes when the store confirms the goods are back.
      </p>
      <div className="space-y-3">
        {isLoading ? (
          <div className="h-24 rounded-xl bg-[var(--panel)] border border-[var(--border)] animate-pulse" />
        ) : rows.length === 0 ? (
          <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-8 text-center text-[var(--muted)]">
            {showOpen ? 'No open custody cases.' : 'No custody cases.'}
          </div>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-5">
              <button className="w-full text-left" onClick={() => setSelected(selected === r.id ? null : r.id)} aria-expanded={selected === r.id}>
                <div className="flex flex-wrap items-center gap-3">
                  <StatusPill value={r.state} />
                  {r.overdue ? <span className="text-xs font-semibold text-red-400">OVERDUE</span> : null}
                  <span className="text-sm">Order {r.order?.orderNumber} · {r.order?.vendor?.name ?? 'courier'} · {words(r.reason)}</span>
                  <span className="text-xs text-[var(--muted)] ml-auto">{new Date(r.createdAt).toLocaleString()}</span>
                </div>
              </button>
              <div className="mt-2 text-sm">
                <Link href={`/orders/${r.orderId}`} className="text-[var(--muted)] hover:text-[var(--accent)]">View order →</Link>
              </div>
              {selected === r.id ? <CaseDetail id={r.id} /> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
