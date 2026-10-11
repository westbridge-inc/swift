'use client';

import Link from 'next/link';
import type { ActivationChecklistItem, ActivationItemState } from '@/lib/api';
import { docLabel } from '@/lib/review-center';
import { reviewCenterHref } from '@/lib/outcome';
import type { Tone } from '@/lib/labels';

/** A document type, in words: the Review Center's names, or the type made readable — never the raw key. */
export function documentName(docType: string): string {
  const known = docLabel(docType);
  if (known !== 'Document') return known;
  const words = docType.replaceAll('_', ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Document';
}

const STATE: Record<ActivationItemState, { words: string; tone: Tone }> = {
  APPROVED: { words: 'Approved', tone: 'good' },
  PENDING: { words: 'Waiting for review', tone: 'warn' },
  REJECTED: { words: 'Rejected', tone: 'bad' },
  EXPIRED: { words: 'Out of date', tone: 'bad' },
  MISSING: { words: 'Not sent yet', tone: 'neutral' },
};

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;

function detail(item: ActivationChecklistItem): string | null {
  if (item.state === 'APPROVED') {
    const until = day(item.expiresAt);
    return [until ? `Valid until ${until}` : null, item.renewalPending ? 'a renewal is waiting for review' : null].filter(Boolean).join(' · ') || null;
  }
  if (item.state === 'PENDING') return item.submittedAt ? `Sent ${day(item.submittedAt)}` : null;
  if (item.state === 'EXPIRED') return item.expiresAt ? `Lapsed ${day(item.expiresAt)}; a current one must be sent` : 'No longer counts; a current one must be sent';
  if (item.state === 'MISSING') return 'The applicant has not sent this yet';
  return null;
}

/**
 * [MISSION CONTROL · PR-2] The required documents for activation, one row
 * each, in the gate's own terms (the server decides APPROVED exactly as the
 * activation gate does), with the reviewer's note on a rejection and a link
 * that opens this applicant in the Review Center.
 */
export function ActivationChecklist({ title, items, applicantId, verdict, children }: {
  title: string;
  items: ActivationChecklistItem[];
  applicantId: string;
  /** One plain sentence: where this stands and what happens next. */
  verdict: { tone: Tone; text: string };
  children?: React.ReactNode;
}) {
  const approved = items.filter((i) => i.state === 'APPROVED').length;
  return (
    <section aria-labelledby="activation-checklist" className="mc-card mc-checklist">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h2 id="activation-checklist" className="mc-label" style={{ margin: 0 }}>{title}</h2>
        <span className="flex gap-1" aria-hidden="true">
          {items.map((i) => <span key={i.docType} className={`mc-pip mc-pip-${STATE[i.state].tone}`} />)}
        </span>
        <span className="mc-numbers mc-muted text-xs font-semibold">{approved} of {items.length} approved</span>
      </div>
      <p className={`mc-verdict mc-verdict-${verdict.tone}`}>{verdict.text}</p>
      <ul className="grid gap-2 mt-3">
        {items.map((item) => {
          const state = STATE[item.state];
          const more = detail(item);
          return (
            <li key={item.docType} className={`mc-doc mc-doc-${state.tone}`}>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{documentName(item.docType)}</p>
                {more ? <p className="mc-muted text-xs">{more}</p> : null}
                {item.state === 'REJECTED' && item.note ? <p className="text-xs mt-1">Reviewer: {item.note}</p> : null}
              </div>
              <span className={`mc-badge${state.tone === 'neutral' ? '' : ` mc-tone-${state.tone}`}`}>{state.words}</span>
            </li>
          );
        })}
      </ul>
      {children}
      <div className="flex flex-wrap gap-2 mt-3">
        <Link href={reviewCenterHref(applicantId)} className="mc-btn">Open in Review Center</Link>
      </div>
    </section>
  );
}
