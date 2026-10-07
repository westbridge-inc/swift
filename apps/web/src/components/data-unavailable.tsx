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
      className={`rounded-2xl bg-[var(--swift-red-50)] p-4 ${className}`}
    >
      <p className="text-[15px] font-semibold leading-5 text-[var(--swift-red-600)]">Couldn&apos;t load {what}.</p>
      <p className="mt-1 text-[13px] leading-[18px] text-[var(--swift-ink)]">
        This is <b>not</b> an all-clear — it means we could not check, not that there is nothing.
      </p>
      {detail && <p className="mt-1 text-[13px] leading-[18px] text-[var(--swift-muted)]">{detail}</p>}
      {onRetry && (
        <button
          onClick={onRetry}
          className="sw-btn sw-btn-sm sw-btn-outline mt-3"
        >
          Try again
        </button>
      )}
    </div>
  );
}
