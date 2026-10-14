'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ActionResult } from '@/components/mc/ActionResult';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { fetchDocumentReviewers, setDocumentReviewer, type DocumentReviewerRow } from '@/lib/api';
import type { Outcome } from '@/lib/outcome';

/**
 * [VERIFY-DOCS V3] WHO MAY OPEN DOCUMENTS — the console door to the grant.
 *
 * Owner rulings, 6 Oct 2026: opening, approving and rejecting a document need
 * an explicit document-reviewer grant that `*` never implies; a super-admin
 * may grant it to themselves with a recorded reason; after the update the
 * owner grants himself once before reviewing. The server refuses every
 * document door without the grant, so without this panel nobody could review
 * at all.
 *
 * Only a super-admin can read the team list (the route answers 403 to anyone
 * else), so for everyone else the panel is simply absent and the refusal on
 * the document itself says who to ask. Every change asks for a reason and the
 * list is read again from the server afterwards — nothing is shown as granted
 * until the server says so.
 */
export function ReviewerAccess() {
  const client = useQueryClient();
  const dialog = useActionDialog();
  const [result, setResult] = useState<Outcome | null>(null);
  const team = useQuery({ queryKey: ['document-reviewers'], queryFn: fetchDocumentReviewers, retry: false });
  if (!team.data?.data) return null;
  const rows = team.data.data;
  const me = rows.find((row) => row.you);
  const granted = rows.filter((row) => row.documentReviewer && row.active).length;

  const change = async (row: DocumentReviewerRow, grant: boolean) => {
    const who = row.you ? 'yourself' : row.name;
    const outcome = await dialog.run({
      title: grant ? `Grant the document-reviewer permission to ${who}?` : `Remove the document-reviewer permission from ${who}?`,
      body: <p>{grant
        ? 'They will be able to open people\'s identity documents and approve or reject them. Every document they open is logged.'
        : 'They will no longer be able to open, approve or reject documents. Links they already have open stop working.'}</p>,
      confirmLabel: grant ? 'Grant permission' : 'Remove permission',
      reason: { hint: 'Kept on the permanent record with your name.' },
      submit: ({ reason }) => setDocumentReviewer(row.userId, grant, reason),
      success: () => grant
        ? `${row.you ? 'You have' : `${row.name} has`} the document-reviewer permission.`
        : `${row.you ? 'You no longer have' : `${row.name} no longer has`} the document-reviewer permission.`,
    });
    if (!outcome) return;
    setResult(outcome);
    await client.invalidateQueries({ queryKey: ['document-reviewers'] });
  };

  return <section className="rc-reviewers" aria-label="Document reviewers">
    <h2>Document reviewers <span className="rc-muted">{granted} with the permission</span></h2>
    {me && (me.documentReviewer
      ? <p className="rc-muted">You can open, approve and reject documents.</p>
      : <p className="rc-notice">You cannot open, approve or reject documents yet. Only staff given the document-reviewer permission can.
        {' '}<button type="button" onClick={() => void change(me, true)}>Grant myself the document-reviewer permission</button></p>)}
    <ActionResult outcome={result} onDismiss={() => setResult(null)} />
    <ul>{rows.map((row) => <li key={row.userId}>
      <span><strong>{row.name}</strong>{row.you ? ' (you)' : ''} · {row.role === 'SUPER_ADMIN' ? 'Super-admin' : 'Admin'}{row.active ? '' : ' · inactive'}</span>
      <span>{row.documentReviewer ? 'Can open documents' : 'Cannot open documents'}</span>
      {row.active && !(row.you && !row.documentReviewer) && <button type="button" onClick={() => void change(row, !row.documentReviewer)}>
        {row.documentReviewer
          ? row.you ? 'Remove my document-reviewer permission' : `Remove the permission from ${row.name}`
          : `Grant the permission to ${row.name}`}
      </button>}
    </li>)}</ul>
  </section>;
}
