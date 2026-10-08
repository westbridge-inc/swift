/**
 * [L13 item 4] The server refuses chat text that carries a phone number, an
 * outside link or abusive language (CHAT_CONTENT_NOT_ALLOWED). That refusal
 * must be explained on screen: a silent failure reads as a network glitch.
 * Every other failure keeps the existing retry path (the draft is restored).
 */
export function chatSendRefusal(error: unknown): string | null {
  const code = (error as { response?: { data?: { error?: { code?: unknown } } } } | null | undefined)
    ?.response?.data?.error?.code;
  if (code !== 'CHAT_CONTENT_NOT_ALLOWED') return null;
  return 'Message not sent. Chat cannot carry phone numbers, links or abusive language. Keep the conversation in Swift, and use Help & Support if you need us.';
}
