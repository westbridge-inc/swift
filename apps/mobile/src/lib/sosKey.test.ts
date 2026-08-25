import { describe, it, expect } from 'vitest';
import { createSosKeyStore } from '../lib/sosKey';

// ---------------------------------------------------------------------------
// THE EMERGENCY BUTTON [safety].
//
// `POST /safety/sos` was built complete — rate limit lifted so a panicking
// person is never answered with a 429, participant-authorised for the customer,
// the driver AND the rider, idempotent on clientIdempotencyKey — and then no
// client on any surface ever called it. Taxi had its own ride-scoped route, so
// taxi had a button; a delivery rider carrying cash to a stranger's address had
// nothing.
//
// The idempotency key is the half of that contract the CLIENT owns. The server
// can only collapse repeat presses if the key holds still. These tests exist
// because the failure is silent and only shows up on the worst night someone
// using this app ever has.
// ---------------------------------------------------------------------------

describe('SOS idempotency key', () => {
  it('a frightened person hitting the button four times raises ONE alert', () => {
    let t = 1_000;
    const keys = createSosKeyStore(() => (t += 1));

    const presses = [
      keys.keyFor('job_1'),
      keys.keyFor('job_1'),
      keys.keyFor('job_1'),
      keys.keyFor('job_1'),
    ];

    // Every press carries the same key, so the server folds them into one
    // alert instead of four. Repeated pressing is the NORMAL case here.
    expect(new Set(presses).size).toBe(1);
    // ...and the clock moving on between presses must not change that.
    expect(presses[0]).toBe(presses[3]);
  });

  it('a different job is a different emergency', () => {
    const keys = createSosKeyStore(() => 1_000);
    // Same mint time on purpose: the jobs must separate on identity, not on
    // the clock happening to tick between them.
    expect(keys.keyFor('job_1')).not.toBe(keys.keyFor('job_2'));
  });

  it('clears the server floor of 8 characters', () => {
    // createSchema: clientIdempotencyKey is z.string().min(8).max(128). A key
    // the server rejects means the alert never files at all.
    const key = createSosKeyStore(() => 1).keyFor('a');
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it('stays within the 128-character ceiling for a realistic job id', () => {
    const key = createSosKeyStore().keyFor('c'.repeat(40));
    expect(key.length).toBeLessThanOrEqual(128);
  });
});
