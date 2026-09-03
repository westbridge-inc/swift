'use client';

// ---------------------------------------------------------------------------
// [W-10 / ADM-008] THE SHAPE OF "WE DO NOT KNOW".
//
// The recurring defect across this codebase's client surfaces is that an
// OUTAGE renders as a FACT: no debt, no earnings, no orders, no alerts, all
// clear. The reader cannot tell the difference between "there is nothing" and
// "we could not ask", and the two lead to opposite decisions.
//
// This is the surface for the second one. It is deliberately loud, it never
// shows a number, and it says explicitly that it is not an all-clear — a quiet
// grey "—" was read as "nothing owed" in exactly the cases that mattered.
// ---------------------------------------------------------------------------

export function DataUnavailable({
  what,
  error,
  onRetry,
  className = '',
}: {
  /** What could not be loaded, in the reader's words: "what stores owe you". */
  what: string;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const detail = error instanceof Error ? error.message : null;
  return (
    <div
      role="status"
      className={`rounded-2xl border border-[var(--swift-red)]/30 bg-[var(--swift-red)]/5 p-5 ${className}`}
    >
      <p className="text-sm font-bold text-[var(--swift-red)]">Couldn&apos;t load {what}.</p>
      <p className="mt-1 text-sm text-[var(--swift-ink)]">
        This is <b>not</b> an all-clear — it means we could not check, not that there is nothing.
      </p>
      {detail && <p className="mt-1 text-xs text-[var(--swift-muted)]">{detail}</p>}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 rounded-lg border border-[var(--swift-red)]/40 px-3 py-1.5 text-sm font-semibold text-[var(--swift-red)]"
        >
          Try again
        </button>
      )}
    </div>
  );
}
