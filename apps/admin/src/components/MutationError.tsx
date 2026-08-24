export function MutationError({ error, label }: { error: unknown; label: string }) {
  if (!error) return null;

  const detail = error instanceof Error ? error.message : 'Unexpected error';

  return (
    <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
      {label}: {detail}
    </p>
  );
}
