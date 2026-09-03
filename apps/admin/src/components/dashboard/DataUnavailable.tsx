'use client';

import { AlertOctagon } from 'lucide-react';

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
      className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm"
    >
      <AlertOctagon size={16} className="mt-0.5 shrink-0 text-red-400" />
      <div className="flex-1">
        <p className="font-semibold text-red-400">{what} could not be loaded.</p>
        <p className="text-[var(--muted)]">{notAnAllClear}</p>
        {lastSuccessAt ? (
          <p className="mt-1 text-xs text-[var(--muted)]">
            Last successful read {new Date(lastSuccessAt).toLocaleTimeString()}.
          </p>
        ) : null}
      </div>
      {onRetry ? (
        <button
          onClick={onRetry}
          className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1 text-xs hover:bg-white/10"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** The value a metric shows when its read failed: never a zero, never a dash that reads as "none". */
export const METRIC_UNAVAILABLE = 'unavailable';
