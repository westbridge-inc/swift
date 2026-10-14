'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ActionResult } from '@/components/mc/ActionResult';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { fetchDocumentReviewers, setCatalogueApprover, type DocumentReviewerRow } from '@/lib/api';
import type { Outcome } from '@/lib/outcome';

/**
 * [GUARDRAILS §8 · Opus S3-9] WHO MAY SHOW A HELD ITEM — the console door to the
 * catalogue-approver grant.
 *
 * Approving an item a banned word is holding puts it in front of customers, so
 * it needs an explicit grant that `*` never implies; a super-admin may grant it
 * to themselves with a recorded reason. The server refuses every approval
 * without it, so without this panel the catalogue check's Approve button would
 * dead-end. A copy of the document-reviewer panel (ReviewerAccess, #1525): the
 * same team list (403 → the panel is absent), the same founder door, a reason
 * on every change, and nothing shown as granted until the server says so.
 */
export function CatalogueApproverAccess() {
  const client = useQueryClient();
  const dialog = useActionDialog();
  const [result, setResult] = useState<Outcome | null>(null);
  const team = useQuery({ queryKey: ['document-reviewers'], queryFn: fetchDocumentReviewers, retry: false });
  if (!team.data?.data) return null;
  const rows = team.data.data;
  const me = rows.find((row) => row.you);
  const granted = rows.filter((row) => row.catalogueApprover && row.active).length;

  const change = async (row: DocumentReviewerRow, grant: boolean) => {
    const who = row.you ? 'yourself' : row.name;
    const outcome = await dialog.run({
      title: grant ? `Grant the catalogue-approver permission to ${who}?` : `Remove the catalogue-approver permission from ${who}?`,
      body: <p>{grant
        ? 'They will be able to approve items a banned word is holding, which shows them to customers. Every approval is logged.'
        : 'They will no longer be able to approve held items. They can still remove items.'}</p>,
      confirmLabel: grant ? 'Grant permission' : 'Remove permission',
      reason: { hint: 'Kept on the permanent record with your name.' },
      submit: ({ reason }) => setCatalogueApprover(row.userId, grant, reason),
      success: () => grant
        ? `${row.you ? 'You have' : `${row.name} has`} the catalogue-approver permission.`
        : `${row.you ? 'You no longer have' : `${row.name} no longer has`} the catalogue-approver permission.`,
    });
    if (!outcome) return;
    setResult(outcome);
    await client.invalidateQueries({ queryKey: ['document-reviewers'] });
  };

  return <section className="rc-reviewers" aria-label="Catalogue approvers">
    <h2>Catalogue approvers <span className="rc-muted">{granted} with the permission</span></h2>
    {me && (me.catalogueApprover
      ? <p className="rc-muted">You can approve items held by the catalogue check.</p>
      : <p className="rc-notice">You cannot approve items held by the catalogue check yet. Only staff given the catalogue-approver permission can.
        {' '}<button type="button" onClick={() => void change(me, true)}>Grant myself the catalogue-approver permission</button></p>)}
    <ActionResult outcome={result} onDismiss={() => setResult(null)} />
    <ul>{rows.map((row) => <li key={row.userId}>
      <span><strong>{row.name}</strong>{row.you ? ' (you)' : ''} · {row.role === 'SUPER_ADMIN' ? 'Super-admin' : 'Admin'}{row.active ? '' : ' · inactive'}</span>
      <span>{row.catalogueApprover ? 'Can approve held items' : 'Cannot approve held items'}</span>
      {row.active && !(row.you && !row.catalogueApprover) && <button type="button" onClick={() => void change(row, !row.catalogueApprover)}>
        {row.catalogueApprover
          ? row.you ? 'Remove my catalogue-approver permission' : `Remove the catalogue-approver permission from ${row.name}`
          : `Grant the catalogue-approver permission to ${row.name}`}
      </button>}
    </li>)}</ul>
  </section>;
}
