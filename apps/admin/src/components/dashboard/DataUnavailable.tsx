'use client';

import { AlertOctagon } from 'lucide-react';
import { gyTime } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [A-06] ABSENCE OF DATA IS NOT EVIDENCE OF ABSENCE.
//
// Every panel on this dashboard rendered a reassuring sentence when its query
// FAILED: "All clear — no active alerts", "No recent orders", "No data", and a
// revenue total of $0 with a monthly projection computed from it. A timeout, a
// 403 or a schema change therefore looked exactly like a quiet, healthy
// platform — which is the one moment an operator most needs to know they are
// blind.
//
// A failed read renders THIS instead. It is red, it says the read failed, and
// it says in plain words that this is not an all-clear. Where the panel knows
// when it last succeeded, it says that too, because "unavailable since 14:02"
// is actionable and "unavailable" alone is not.
// ---------------------------------------------------------------------------

export function DataUnavailable({
  what,
  notAnAllClear,
  lastSuccessAt,
  onRetry,
}: {
  /** the thing that could not be loaded, as an operator would name it */
  what: string;
  /** the false reading this replaces, e.g. "This is not an all-clear." */
  notAnAllClear: string;
  /** epoch millis of the last successful read, when the panel knows it */
  lastSuccessAt?: number;
  onRetry?: () => void;
}) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-[var(--mc-radius-sm)] border border-[rgb(185_28_28/30%)] bg-[var(--mc-bad-soft)] p-3 text-sm"
    >
      <AlertOctagon size={16} className="mc-text-bad mt-0.5 shrink-0" />
      <div className="flex-1">
        <p className="mc-text-bad font-semibold">{what} could not be loaded.</p>
        <p className="text-[var(--mc-muted-strong)]">{notAnAllClear}</p>
        {lastSuccessAt ? (
          <p className="mt-1 text-xs text-[var(--mc-muted-strong)]">
            Last successful read {gyTime(lastSuccessAt)}.
          </p>
        ) : null}
      </div>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="mc-btn shrink-0">
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** The value a metric shows when its read failed: never a zero, never a dash that reads as "none". */
export const METRIC_UNAVAILABLE = 'unavailable';
