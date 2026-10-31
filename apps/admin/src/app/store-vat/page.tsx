'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { approveStoreVat, decideStoreVatMode, fetchStoreVatPending, rejectStoreVat, type StoreVatPendingRow } from '@/lib/api';
import type { Outcome } from '@/lib/outcome';
import { ActionResult } from '@/components/mc/ActionResult';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { DocumentViewer } from '@/components/verification/DocumentViewer';
import { gyDate } from '@/lib/dates';
import { vatModeChangeWords, vatModeWords } from '@/lib/store-vat-mode';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5] Stores waiting for a VAT decision, oldest certificate first.
//
// Only a business registered for VAT with the GRA may charge VAT, and a false VAT number is an offence (VAT Act
// s.67(7)): so a PERSON opens the store's GRA VAT certificate here and TYPES what it says (the VAT number, the
// registered name, the date it takes effect) before the store's prices may say "incl. VAT". The server refuses a
// number that differs from the store's, a future date, a reviewer who is the owner, and a certificate only a machine
// approved. Approve is locked until the certificate has been opened, as in the Review Center.
// [VAT-DOCS · owner ruling 31 Oct 2026] An APPROVED store's change of price choice waits here too: its prices stay as they
// are until a person approves the change; a refusal tells the store why.
// ---------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The certificate's document status, in words (VerificationDocumentStatus). */
const CERTIFICATE_WORDS: Readonly<Record<string, string>> = {
  PENDING: 'not decided yet',
  APPROVED: 'already approved by a person',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
};

export default function StoreVatPage() {
  const qc = useQueryClient();
  const dialog = useActionDialog();
  const pending = useQuery({ queryKey: ['store-vat-pending'], queryFn: fetchStoreVatPending });
  const [openId, setOpenId] = useState<string | null>(null);
  const [viewed, setViewed] = useState(false);
  const [result, setResult] = useState<Outcome | null>(null);

  const show = (outcome: Outcome | null) => {
    if (!outcome) return;
    setResult(outcome);
    setOpenId(null);
    setViewed(false);
    void qc.invalidateQueries({ queryKey: ['store-vat-pending'] });
  };

  const approve = async (row: StoreVatPendingRow) => show(await dialog.run({
    title: `Approve VAT for ${row.name}?`,
    body: (
      <p>
        Type what the certificate says. The server checks the number against the one the store gave and refuses a
        mismatch. Once approved, the store&apos;s prices say &ldquo;incl. VAT&rdquo; and its receipts name it as the one
        charging VAT.{row.mode === 'ADD_VAT_AT_CHECKOUT' ? ' This store\u2019s prices do not include VAT, so approving adds VAT to each standard-rated price its customers see.' : ''}
      </p>
    ),
    confirmLabel: 'Approve VAT',
    reason: { hint: 'Kept on the permanent record with your decision.' },
    fields: [
      { kind: 'text', name: 'vatNumber', label: 'VAT registration number on the certificate', required: true, maxLength: 40 },
      { kind: 'text', name: 'registeredName', label: 'Registered name on the certificate', required: true, minLength: 2, maxLength: 200 },
      { kind: 'text', name: 'effectiveFrom', label: 'Date it takes effect (YYYY-MM-DD)', required: true, pattern: DATE, patternMessage: 'Type the date as YYYY-MM-DD, as on the certificate.' },
      { kind: 'choice', name: 'nameMatchesStore', label: 'Is the registered name this store’s business?', options: [{ value: 'yes', label: 'Yes, it is this store’s business' }] },
    ],
    submit: ({ reason, values }) => approveStoreVat(row.vendorId, {
      certificateDocId: row.certificate!.id,
      vatNumber: String(values['vatNumber']),
      registeredName: String(values['registeredName']),
      effectiveFrom: String(values['effectiveFrom']),
      nameMatchesStore: true,
    }, reason),
    success: () => `${row.name}'s VAT is approved. Its new orders carry VAT inside their prices.`,
  }));

  const reject = async (row: StoreVatPendingRow) => show(await dialog.run({
    title: `Do not approve VAT for ${row.name}?`,
    body: <p>Your reason shows on the store&apos;s VAT settings. Nothing changes for its customers; it can correct it and send its certificate again.</p>,
    confirmLabel: 'Reject',
    reason: { label: 'What the store must fix', hint: 'The store sees this on its VAT settings.' },
    submit: ({ reason }) => rejectStoreVat(row.vendorId, reason),
    success: () => `${row.name}'s VAT was not approved. The store sees your reason on its VAT settings.`,
  }));

  const approveChange = async (row: StoreVatPendingRow) => show(await dialog.run({
    title: `Approve ${row.name}’s price change?`,
    body: <p>{vatModeChangeWords(row.modeRequested)} The store&apos;s VAT stays approved; only how its prices relate to VAT changes.</p>,
    confirmLabel: 'Approve the change',
    reason: { hint: 'Kept on the permanent record with your decision.' },
    submit: ({ reason }) => decideStoreVatMode(row.vendorId, { approve: true, mode: String(row.modeRequested) }, reason),
    success: () => `${row.name}'s price change is approved. Its prices follow it now.`,
  }));

  const refuseChange = async (row: StoreVatPendingRow) => show(await dialog.run({
    title: `Refuse ${row.name}’s price change?`,
    body: <p>Nothing changes: the store&apos;s prices and what its customers pay stay as they are. The store reads your reason.</p>,
    confirmLabel: 'Refuse the change',
    reason: { label: 'Why (what the store reads)', hint: 'The store is told in these words.' },
    submit: ({ reason }) => decideStoreVatMode(row.vendorId, { approve: false, mode: String(row.modeRequested) }, reason),
    success: () => `${row.name}'s price change was refused. The store is told why.`,
  }));

  const rows = pending.data ?? [];
  return (
    <div className="mc-page">
      {/* The shell's header names the page (REVIEW-F #2087 S4: no second h1). */}
      <p className="text-sm mb-5" style={{ color: 'var(--mc-muted)' }}>
        Stores that say they are VAT-registered with the GRA, waiting for a person to check the certificate. A withdrawal
        of an approved store&apos;s VAT is on the store&apos;s own page.
      </p>
      {result && <ActionResult outcome={result} onDismiss={() => setResult(null)} />}
      {pending.isError ? (
        <QueryFailed error={pending.error} what="the stores waiting for a VAT decision" onRetry={() => void pending.refetch()} retrying={pending.isFetching} />
      ) : pending.isLoading ? (
        <div className="mc-card" aria-busy="true">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="mc-card">No store is waiting for a VAT decision.</div>
      ) : (
        <ul className="space-y-3" aria-label="Stores waiting for a VAT decision">
          {rows.map((row) => row.modeRequested ? (
            <li key={row.vendorId} className="mc-card space-y-2">
              <div className="flex flex-wrap items-baseline gap-3">
                <Link href={`/vendors/${row.vendorId}`} className="font-semibold underline">{row.name}</Link>
                <span className="text-sm">VAT approved.</span>
                <span className="text-sm">{vatModeChangeWords(row.modeRequested)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="mc-btn mc-btn-primary" onClick={() => void approveChange(row)}>Approve the change</button>
                <button type="button" className="mc-btn" onClick={() => void refuseChange(row)}>Refuse the change</button>
              </div>
            </li>
          ) : (
            <li key={row.vendorId} className="mc-card space-y-2">
              <div className="flex flex-wrap items-baseline gap-3">
                <Link href={`/vendors/${row.vendorId}`} className="font-semibold underline">{row.name}</Link>
                <span className="text-sm">Number the store gave: <span className="mc-numbers">{row.vatRegistrationNumber ?? '—'}</span></span>
                <span className="text-sm">{vatModeWords(row.mode)}</span>
                <span className="text-sm">
                  {row.certificate ? `Certificate sent ${gyDate(row.certificate.createdAt)} (${CERTIFICATE_WORDS[row.certificate.status] ?? 'in a state this page does not know'})` : 'No certificate sent yet'}
                </span>
              </div>
              {row.certificate && openId === row.vendorId && (
                <DocumentViewer key={row.certificate.id} id={row.certificate.id} label="VAT registration certificate" onViewed={setViewed} />
              )}
              <div className="flex flex-wrap gap-2">
                {row.certificate && openId !== row.vendorId && (
                  <button type="button" className="mc-btn" onClick={() => { setOpenId(row.vendorId); setViewed(false); }}>Open the certificate</button>
                )}
                <button
                  type="button"
                  className="mc-btn mc-btn-primary"
                  disabled={!row.certificate || openId !== row.vendorId || !viewed}
                  title={!row.certificate ? 'No certificate to check yet' : openId !== row.vendorId || !viewed ? 'Open the certificate first' : undefined}
                  onClick={() => void approve(row)}
                >
                  Approve VAT
                </button>
                <button type="button" className="mc-btn" onClick={() => void reject(row)}>Reject</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
