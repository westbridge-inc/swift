import { describe, it, expect } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { captureRawBody, AGENT_CASH_MAX_RAW_BODY_BYTES } from '../modules/billing/agent-cash.routes';

// Audit High #3 (S0): the MMG agent-notification webhook buffered the ENTIRE
// request body before any size or signature check — an anonymous multi-GB
// POST could OOM the shared API process. The capture now enforces a 128 KB cap
// from the declared content-length AND while accumulating, refusing with 413
// before the partial body can grow past the cap or reach the signature code.
// After the refusal the rest of the upload is dropped on arrival (nothing is
// retained, nothing is paused, nothing is destroyed), so the 413 still reaches
// the client on a real socket and the socket closes when the client leaves.

const req = (headers: Record<string, string> = {}) =>
  ({ headers, rawBody: undefined }) as never;
const rawBodyOf = (request: unknown) => (request as { rawBody?: Buffer }).rawBody;

const oversize = () => Buffer.alloc(AGENT_CASH_MAX_RAW_BODY_BYTES + 1, 0x61);
const TOO_LARGE = { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE' };

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

    await expect(captureRawBody(request, hostiles)).rejects.toMatchObject(TOO_LARGE);
    expect(rawBodyOf(request)).toBeUndefined();
  });

  it('caps a stream that lies about its length while accumulating, and never sets rawBody', async () => {
    const request = req({ 'content-length': '1' });
    const stream = Readable.from([oversize()]);

    await expect(captureRawBody(request, stream)).rejects.toMatchObject(TOO_LARGE);
    expect(rawBodyOf(request)).toBeUndefined();
  });

  it('caps an undeclared-length stream while accumulating', async () => {
    const request = req({});
    const stream = Readable.from([oversize()]);

    await expect(captureRawBody(request, stream)).rejects.toMatchObject(TOO_LARGE);
    expect(rawBodyOf(request)).toBeUndefined();
  });

  it('refuses a 1 MB chunked stream within a few chunks past 128 KB, then drops the rest on arrival: nothing retained, nothing paused, nothing destroyed', async () => {
    const CHUNK = 16 * 1024;
    const TOTAL = 1024 * 1024;
    // Delivered asynchronously, one chunk per turn, the way a socket delivers
    // packets — so the moment of refusal can be observed before the drain.
    let emitted = 0;
    let ended = false;
    const source = new Readable({
      read() {
        setImmediate(() => {
          if (emitted >= TOTAL) {
            this.push(null);
            return;
          }
          emitted += CHUNK;
          this.push(Buffer.alloc(CHUNK, 0x61));
        });
      },
    });
    source.on('end', () => { ended = true; });
    const request = req({});

    await expect(captureRawBody(request, source)).rejects.toMatchObject(TOO_LARGE);

    // Refused within a few chunks of the cap — nowhere near the 1 MB on offer
    // (the old code took all of it before anything could refuse).
    const takenAtRefusal = emitted;
    expect(takenAtRefusal).toBeGreaterThan(AGENT_CASH_MAX_RAW_BODY_BYTES);
    expect(takenAtRefusal).toBeLessThanOrEqual(AGENT_CASH_MAX_RAW_BODY_BYTES + 4 * CHUNK);
    expect(rawBodyOf(request)).toBeUndefined();
    // Not destroyed (fastify still has to write the 413 on this socket) and
    // not paused (a paused request socket never sees the client hang up): the
    // remainder keeps arriving and is dropped, so the source reaches its end
    // with nothing ever attached to the request.
    expect(source.destroyed).toBe(false);
    while (!ended) await sleep(5);
    expect(emitted).toBe(TOTAL);
    expect(rawBodyOf(request)).toBeUndefined();
  });

  it('passes a small body through intact with rawBody set', async () => {
    const raw = Buffer.from(JSON.stringify({ transactionId: 'T-1', accountNumber: '472-905-8836' }));
    const request = req({ 'content-length': String(raw.length) });
    const out = await captureRawBody(request, Readable.from([raw]));

    const collected: Buffer[] = [];
    for await (const chunk of out) collected.push(chunk as Buffer);
    expect(Buffer.concat(collected).toString('utf8')).toBe(raw.toString('utf8'));
    expect(rawBodyOf(request)).toEqual(raw);
  });
});
