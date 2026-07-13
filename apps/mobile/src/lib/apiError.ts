/** Pull a human message out of an axios/API error, falling back sanely.
 *  Kept dependency-free (no RN imports) so it's unit-testable in isolation. */
export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const e = err as { response?: { data?: { error?: { message?: string } } }; message?: string; code?: string };
  return (
    e?.response?.data?.error?.message ||
    (e?.code === 'ECONNABORTED' ? 'The request timed out. Check your connection and try again.' : '') ||
    (e?.message === 'Network Error' ? 'You appear to be offline — check your connection and try again.' : '') ||
    fallback
  );
}
