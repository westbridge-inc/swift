export interface ChatMessagesPage<T = unknown> {
  messages: T[];
  contactBlocked: boolean | null;
}

/** Keep the legacy message-array hook surface while retaining additive contact
 * metadata from the response envelope. Missing/malformed metadata stays
 * unknown so the composer can fail closed instead of guessing. */
export function parseChatMessagesResponse<T = unknown>(response: unknown): ChatMessagesPage<T> {
  const envelope = (response as { data?: unknown } | null)?.data;
  const body = envelope && typeof envelope === 'object'
    ? envelope as { data?: unknown; contactBlocked?: unknown }
    : {};

  return {
    messages: Array.isArray(body.data) ? body.data as T[] : [],
    contactBlocked: typeof body.contactBlocked === 'boolean' ? body.contactBlocked : null,
  };
}
