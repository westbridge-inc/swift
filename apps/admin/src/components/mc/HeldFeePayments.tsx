'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchFeeConfirmations, resolveFeeConfirmation, type FeeConfirmation } from '@/lib/api';
import { DataTable } from './DataTable';
import { QueryFailed } from './QueryFailed';
import { Truncate } from './Truncate';
import { useActionRunner } from './useActionRunner';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · AD3] HELD WEEKLY-FEE PAYMENTS — the decision door.
//
// A weekly-fee payment the provider's answer left unproven (an MMG checkout
// held for review, a card payment or recorded payment held for checking)
// opens a confirmation hold. The partner is told "Support will contact you";
// the server lists the holds (GET /admin/billing/confirmations) and decides
// one (POST …/:id/resolve), but no screen called either. This is that screen.
//
// Money rules, all the server's (the console only asks):
//  - "Paid" is accepted only on the provider evidence Swift already recorded;
//    a typed claim is refused (409 SETTLEMENT_EVIDENCE_REQUIRED) and nothing
//    is credited. The evidence reference is the operator's pointer to it.
//  - "Not paid" is refused once the provider confirmed the money.
//  - Both are money (C4): a second admin approves in Approvals (202).
//  - The decision is bound to the version it was read at; a changed payment is
//    refused (409 CONFIRMATION_CHANGED) and the list is re-read.
// A paused obligation is listed but is not decided here (resolvable: false).
// ---------------------------------------------------------------------------

const SOURCE_WORDS: Record<FeeConfirmation['source'], string> = {
  MMG_CHECKOUT: 'MMG checkout', CARD_SESSION: 'Card payment', PAYMENT: 'Recorded payment', OBLIGATION: 'Paused fee',
};
/** Guyana time: support and partners speak in it. */
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const graceLeft = (ms: number) => {
  const h = Math.floor(ms / 3_600_000);
  return h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h of grace left` : h > 0 ? `${h} h of grace left` : 'grace used up';
};

const EVIDENCE = {
  kind: 'text' as const, name: 'evidenceReference', label: 'Evidence reference', required: true, maxLength: 128,
  hint: 'Where you checked it: the MMG statement line or the support case, 8 or more letters and numbers (no spaces)',
};

export function HeldFeePayments() {
  const qc = useQueryClient();
  const holds = useQuery({ queryKey: ['fee-confirmations'], queryFn: fetchFeeConfirmations, refetchOnWindowFocus: false });
  const actions = useActionRunner(() => void qc.invalidateQueries({ queryKey: ['fee-confirmations'] }));
  const rows: FeeConfirmation[] = holds.data?.data ?? [];

  const decide = (row: FeeConfirmation, decision: 'PAID' | 'UNPAID') => void actions.run({
    title: decision === 'PAID' ? `Confirm this ${SOURCE_WORDS[row.source]} as paid?` : `Confirm this ${SOURCE_WORDS[row.source]} as not paid?`,
    body: decision === 'PAID' ? (
      <>
        <p>
          Swift credits the week only if the provider&apos;s own record of this payment is already on file. If it is not,
          nothing is credited and you are told so.
        </p>
        <p>A second admin approves it before it takes effect.</p>
      </>
    ) : (
      <>
        <p>The payment is closed as not paid, and the partner&apos;s weekly fee is due again. This is refused if the provider confirmed the money.</p>
        <p>A second admin approves it before it takes effect.</p>
      </>
    ),
    confirmLabel: decision === 'PAID' ? 'Confirm paid' : 'Confirm not paid',
    reason: { hint: 'What you checked and what it showed. Kept on the permanent record.' },
    fields: decision === 'PAID'
      ? [EVIDENCE, { kind: 'text', name: 'providerPaymentId', label: "Provider's payment id", maxLength: 128, hint: "Optional: the provider's id for this payment, when the record names more than one" }]
      : [EVIDENCE],
    submit: ({ reason, values }) => resolveFeeConfirmation(row.id, {
      sourceId: row.sourceId, epoch: row.epoch, clockVersion: row.clockVersion,
      decision,
      evidenceReference: String(values['evidenceReference']),
      ...(values['providerPaymentId'] ? { providerPaymentId: String(values['providerPaymentId']) } : {}),
    }, reason),
    success: () => (decision === 'PAID' ? 'Confirmed as paid: the week is credited from the provider’s record.' : 'Confirmed as not paid: the weekly fee is due again.'),
  });

  return (
    <section aria-labelledby="held-fee-payments" className="mc-card mc-door mb-6 space-y-3">
      <h2 id="held-fee-payments" className="mc-label">Held weekly-fee payments{holds.data ? ` · ${rows.length}` : ''}</h2>
      <p className="mc-muted">
        Payments the provider&apos;s answer left unproven. The partner was told Swift support will contact them. Decide each
        one on the provider&apos;s record; a second admin approves it.
      </p>
      {actions.banner}
      {holds.isLoading ? (
        <p className="mc-muted" aria-busy="true">Loading held payments…</p>
      ) : holds.isError ? (
        <QueryFailed error={holds.error} what="the held payments" onRetry={() => void holds.refetch()} retrying={holds.isFetching} />
      ) : rows.length === 0 ? (
        <p className="mc-muted">No weekly-fee payments are held for a decision.</p>
      ) : (
        <DataTable<FeeConfirmation>
          label="Held weekly-fee payments"
          rows={rows}
          rowKey={(r) => r.id}
          empty="No weekly-fee payments are held for a decision."
          columns={[
            { key: 'source', header: 'Payment', width: '20%', primary: true, cell: (r) => SOURCE_WORDS[r.source] },
            { key: 'ref', header: 'Reference', width: '22%', cell: (r) => <Truncate text={r.sourceId} className="font-mono text-xs" /> },
            { key: 'since', header: 'Held since', width: '16%', cell: (r) => when(r.beganAt) },
            {
              key: 'due', header: 'Review', width: '18%',
              cell: (r) => <span>{r.overdue ? <span className="mc-badge mc-tone-bad">Overdue</span> : `By ${when(r.reviewDueAt)}`} · {graceLeft(r.remainingGraceMs)}</span>,
            },
            {
              key: 'act', header: 'Decision', width: '24%',
              cell: (r) => r.resolvable ? (
                <span className="flex flex-wrap gap-2">
                  <button type="button" className="mc-btn" onClick={() => decide(r, 'PAID')} aria-label={`Confirm ${r.sourceId} as paid`}>Paid…</button>
                  <button type="button" className="mc-btn" onClick={() => decide(r, 'UNPAID')} aria-label={`Confirm ${r.sourceId} as not paid`}>Not paid…</button>
                </span>
              ) : <span className="mc-muted">A paused fee: the billing team reviews it; it is not decided here.</span>,
            },
          ]}
        />
      )}
    </section>
  );
}
