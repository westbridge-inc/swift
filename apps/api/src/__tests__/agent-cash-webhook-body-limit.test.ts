import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { captureRawBody, AGENT_CASH_MAX_RAW_BODY_BYTES } from '../modules/billing/agent-cash.routes';

// Audit High #3 (S0): the MMG agent-notification webhook buffered the ENTIRE
// request body before any size or signature check — an anonymous multi-GB
// POST could OOM the shared API process. The capture now enforces a 128 KB cap
// from the declared content-length AND while accumulating, throwing 413 before
// the partial body can grow past the cap or reach the signature code.

const req = (headers: Record<string, string> = {}) =>
  ({ headers, rawBody: undefined }) as never;

const oversize = () => Buffer.alloc(AGENT_CASH_MAX_RAW_BODY_BYTES + 1, 0x61);

describe('MMG webhook raw-body capture (body-size guard)', () => {
  it('the configured cap is the advertised 128 KB', () => {
    expect(AGENT_CASH_MAX_RAW_BODY_BYTES).toBe(128 * 1024);
  });

  it('refuses a declared content-length over the cap before reading any bytes', async () => {
    // A hostile stream that throws if it is ever read: the header fast-path
    // must reject without touching a single chunk.
    const hostiles = new Readable({
      read() {
        throw new Error('payload must not be read once content-length is over the cap');
      },
    });
    const request = req({ 'content-length': String(AGENT_CASH_MAX_RAW_BODY_BYTES + 1) });

    await expect(captureRawBody(request, hostiles)).rejects.toMatchObject({
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });
    expect((request as { rawBody?: Buffer }).rawBody).toBeUndefined();
  });

  it('caps a stream that lies about its length while accumulating, and never sets rawBody', async () => {
    const request = req({ 'content-length': '1' });
    const stream = Readable.from([oversize()]);

    await expect(captureRawBody(request, stream)).rejects.toMatchObject({
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });
    expect((request as { rawBody?: Buffer }).rawBody).toBeUndefined();
  });

  it('caps an undeclared-length stream while accumulating', async () => {
    const request = req({});
    const stream = Readable.from([oversize()]);

    await expect(captureRawBody(request, stream)).rejects.toMatchObject({
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });
    expect((request as { rawBody?: Buffer }).rawBody).toBeUndefined();
  });

  it('passes a small body through intact with rawBody set', async () => {
    const raw = Buffer.from(JSON.stringify({ transactionId: 'T-1', accountNumber: '472-905-8836' }));
    const request = req({ 'content-length': String(raw.length) });
    const out = await captureRawBody(request, Readable.from([raw]));

    const collected: Buffer[] = [];
    for await (const chunk of out) collected.push(chunk as Buffer);
    expect(Buffer.concat(collected).toString('utf8')).toBe(raw.toString('utf8'));
    expect((request as { rawBody?: Buffer }).rawBody).toEqual(raw);
  });
});
