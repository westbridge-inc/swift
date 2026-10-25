export function MutationError({ error, label }: { error: unknown; label: string }) {
  if (!error) return null;

  const detail = error instanceof Error ? error.message : 'Unexpected error';

  return (
    <p role="alert" className="mc-alert">
      {label}: {detail}
    </p>
  );
}
