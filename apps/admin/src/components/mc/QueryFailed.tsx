'use client';

import { RefreshCw, XCircle } from 'lucide-react';
import { outcomeOf } from '@/lib/outcome';
import { supportLine } from './ActionResult';

/**
 * [MISSION CONTROL · PR-1] A read that failed says so: "Couldn't load …",
 * why in plain words, a Retry, and the code for support.
 *
 * It replaces the silent empty state — a 403 or a 500 that rendered as "No
 * vendors" or "Open violations (0)" told the operator there was nothing there
 * when the truth was that nobody could look.
 */
export function QueryFailed({ error, what, onRetry, retrying = false, className = '' }: {
  error: unknown;
  /** What was being loaded, as it reads in a sentence: "this store", "the store list". */
  what: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  if (!error) return null;
  const outcome = outcomeOf(error, { kind: 'read' });
  const support = supportLine(outcome);
  return (
    <div role="alert" className={`mc-result mc-result-failed ${className}`} data-tone="failed">
      <XCircle className="mc-result-icon" size={20} aria-hidden="true" />
      <p className="mc-result-title">Couldn&apos;t load {what}</p>
      <p className="mc-result-next">
        {outcome.title}.{outcome.next ? ` ${outcome.next}` : ''}
      </p>
      {outcome.serverMessage ? <p className="mc-result-server">{outcome.serverMessage}</p> : null}
      {onRetry ? (
        <div className="mc-result-actions">
          <button type="button" className="mc-btn" onClick={onRetry} disabled={retrying}>
            <RefreshCw size={16} aria-hidden="true" /> {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : null}
      {support ? <p className="mc-result-code">{support}</p> : null}
    </div>
  );
}
