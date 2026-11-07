/**
 * [MASTER-051] Read a request body under a hard byte cap and a deadline,
 * before any parser sees it. A declared length over the cap is refused without
 * reading; a body that streams past the cap (with no length, or a misleading
 * one) is cancelled at the cap; a body that stops arriving is cancelled at the
 * deadline. The caller parses only the bytes returned here.
 */
export class BodyTooLargeError extends Error {
  readonly status = 413;
  constructor() { super('Request body too large'); }
}

export class BodyUnreadableError extends Error {
  constructor(reason: string) { super(`Unreadable request body (${reason})`); }
}

export async function readBoundedBody(request: Request, maxBytes: number, deadlineMs: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared.trim())) {
      await request.body?.cancel().catch(() => {});
      throw new BodyUnreadableError('declared length');
    }
    if (Number(declared.trim()) > maxBytes) {
      await request.body?.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyUnreadableError('deadline')), deadlineMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new BodyUnreadableError('chunk');
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    // Stop the producer: nothing past the cap or the deadline is pulled.
    reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}
