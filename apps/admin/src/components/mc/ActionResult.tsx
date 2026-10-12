'use client';

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Clock, XCircle } from 'lucide-react';
import type { Outcome } from '@/lib/outcome';

const ICON = { success: CheckCircle2, queued: Clock, refused: AlertTriangle, failed: XCircle } as const;

/** "Code CHECKLIST_INCOMPLETE · HTTP 409" — for support, beside the words, never alone. */
export function supportLine(outcome: Pick<Outcome, 'code' | 'status' | 'approvalId'>): string | null {
  const parts = [
    outcome.code ? `Code ${outcome.code}` : null,
    outcome.status ? `HTTP ${outcome.status}` : null,
    outcome.approvalId ? `Approval ${outcome.approvalId}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * [MISSION CONTROL · PR-1] The answer to an action, in plain words.
 *
 * What happened, the server's own sentence when it carries specifics, the next
 * step, a link to where it can be done, and the code for support in small
 * print. A refusal or failure is announced (role=alert); a success or a queued
 * approval is a polite status.
 */
export function ActionResult({ outcome, onDismiss, className = '' }: {
  outcome: Outcome | null | undefined;
  onDismiss?: () => void;
  className?: string;
}) {
  if (!outcome) return null;
  const Icon = ICON[outcome.tone];
  const support = supportLine(outcome);
  const alarming = outcome.tone === 'refused' || outcome.tone === 'failed';
  return (
    <div
      role={alarming ? 'alert' : 'status'}
      className={`mc-result mc-result-${outcome.tone} ${className}`}
      data-tone={outcome.tone}
    >
      <Icon className="mc-result-icon" size={20} aria-hidden="true" />
      <p className="mc-result-title">{outcome.title}</p>
      {outcome.serverMessage ? <p className="mc-result-server">{outcome.serverMessage}</p> : null}
      {outcome.next ? <p className="mc-result-next">{outcome.next}</p> : null}
      {outcome.link ? (
        <div className="mc-result-actions">
          <Link href={outcome.link.href} className="mc-btn mc-btn-primary">
            {outcome.link.label}
          </Link>
        </div>
      ) : null}
      {support ? <p className="mc-result-code">{support}</p> : null}
      {onDismiss ? (
        <button type="button" className="mc-result-dismiss" onClick={onDismiss} aria-label="Dismiss this message">
          ×
        </button>
      ) : null}
    </div>
  );
}
