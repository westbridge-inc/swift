'use client';

/** [WR-047] One honest line for admin mutations whose rejection used to
 *  vanish (success-only/onSettled handling). apiFetch already surfaces the
 *  server's real message — this renders the first one present. */
export function MutationNotice({ errors, className = '' }: { errors: Array<unknown>; className?: string }) {
  const first = errors.find(Boolean) as Error | undefined;
  if (!first) return null;
  return (
    <p role="alert" className={`text-xs mb-3 ${className}`} style={{ color: 'var(--bad)' }}>
      Action did not confirm: {first.message}
    </p>
  );
}

/** [WR-048] For operational queries whose outage used to render as a clear/
 *  empty queue — a failed read is stated, never dressed as "nothing to do". */
export function QueryFailed({ error, what, onRetry }: { error: unknown; what: string; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-8 text-center">
      <p className="text-sm" style={{ color: 'var(--bad)' }}>
        Couldn&apos;t load {what}: {(error as Error).message}
      </p>
      {onRetry ? (
        <button onClick={onRetry} className="mt-3 px-3 py-1 rounded-lg text-xs border border-[var(--border)] hover:bg-white/10">
          Retry
        </button>
      ) : null}
    </div>
  );
}
