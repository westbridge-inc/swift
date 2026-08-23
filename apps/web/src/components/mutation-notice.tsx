'use client';

/** [WR-043] One honest line for operational mutations that used to fail in
 *  silence: the onSettled refetch snaps the UI back to server truth, but the
 *  operator was never told WHY their action reverted. Pass every relevant
 *  mutation's `.error`; the first real one renders. */
export function MutationNotice({ errors, className = '' }: { errors: Array<unknown>; className?: string }) {
  const first = errors.find(Boolean) as Error | undefined;
  if (!first) return null;
  return (
    <p role="alert" className={`text-sm font-semibold text-[var(--swift-red)] ${className}`}>
      That didn&apos;t go through: {first.message}
    </p>
  );
}
