import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ReplyDecryptGate, ReplyGateBusyError, plausibleReplyToken } from './mmg-reply-gate';

// [SEC-DOS F8] The reply gate bounds the private-key work behind the public
// MMG doors: one operation at a time, the event loop's turn before each, a
// bounded wait in all and per source, and a retryable refusal past it.

const block = (bytes: number) => randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

describe('plausibleReplyToken: the cheap check before any wait', () => {
  it('accepts one RSA block of a 2048- to 8192-bit key, in either alphabet', () => {
    for (const bytes of [256, 384, 512, 1024]) expect(plausibleReplyToken(block(bytes)), String(bytes)).toBe(true);
    expect(plausibleReplyToken(randomBytes(512).toString('base64'))).toBe(true);
  });
  it('refuses anything else without decoding much', () => {
    for (const value of ['', 'x', 'garbage', block(128), block(255), block(1025), `${block(512)} `, 'a'.repeat(100_000)]) {
      expect(plausibleReplyToken(value), value.slice(0, 20)).toBe(false);
    }
  });
});

describe('ReplyDecryptGate', () => {
  it('runs one operation at a time, and the event loop gets a turn before each', async () => {
    const gate = new ReplyDecryptGate();
    const order: string[] = [];
    let inside = 0;
    let most = 0;
    const work = (name: string) => () => {
      inside += 1;
      most = Math.max(most, inside);
      order.push(name);
      inside -= 1;
      return name;
    };
    const runs = [gate.run('a', work('one')), gate.run('b', work('two')), gate.run('c', work('three'))];
    // Something else that became ready meanwhile runs before the first operation.
    setImmediate(() => order.push('loop'));
    expect(await Promise.all(runs)).toEqual(['one', 'two', 'three']);
    expect(most).toBe(1);
    expect(order[0]).toBe('loop');
  });

  it('a failing operation releases the gate', async () => {
    const gate = new ReplyDecryptGate();
    await expect(gate.run('a', () => { throw new Error('not ours'); })).rejects.toThrow('not ours');
    expect(await gate.run('a', () => 'next')).toBe('next');
  });

  it('bounds the wait from one source, and leaves the rest of the wait to other sources', async () => {
    const gate = new ReplyDecryptGate({ maxWaiting: 8, maxWaitingPerSource: 2 });
    const first = gate.run('junk', () => 1); // runs
    const queued = [gate.run('junk', () => 2), gate.run('junk', () => 3)]; // wait
    await expect(gate.run('junk', () => 4)).rejects.toBeInstanceOf(ReplyGateBusyError);
    const other = gate.run('genuine', () => 'mine');
    expect(await other).toBe('mine');
    expect(await Promise.all([first, ...queued])).toEqual([1, 2, 3]);
  });

  it('bounds the wait in all', async () => {
    const gate = new ReplyDecryptGate({ maxWaiting: 3, maxWaitingPerSource: 10 });
    const admitted = [gate.run('s0', () => 0), gate.run('s1', () => 1), gate.run('s2', () => 2), gate.run('s3', () => 3)];
    await expect(gate.run('s4', () => 4)).rejects.toBeInstanceOf(ReplyGateBusyError);
    expect(await Promise.all(admitted)).toEqual([0, 1, 2, 3]);
  });

  it('a reply that waits too long is refused as busy, and the gate keeps working', async () => {
    const gate = new ReplyDecryptGate({ maxWaitMs: 20 });
    const slow = gate.run('a', () => { const until = Date.now() + 60; while (Date.now() < until) { /* blocked */ } return 'slow'; });
    const late = gate.run('b', () => 'late');
    await expect(late).rejects.toBeInstanceOf(ReplyGateBusyError);
    expect(await slow).toBe('slow');
    // The gate rests as long as the slow operation took (at most 50 ms), then is free again.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await gate.run('c', () => 'after')).toBe('after');
    expect(gate.waitingCount).toBe(0);
  });
});
