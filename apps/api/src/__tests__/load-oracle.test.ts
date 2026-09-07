import { describe, it, expect } from 'vitest';
// @ts-expect-error — a plain ESM module shared with the k6 harness (no types)
import { replayVerdict, changedBodyVerdict, cardinalityVerdict, manifestVerdict } from '../../../../tools/load/oracle.js';

// [SCR-004] The load oracle compares the command RESULT, never only the status.
// The register's mutation test: a server that returns a SECOND order with the
// same status must be caught.
const res = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

describe('[SCR-004] the idempotency oracle', () => {
  it('the register’s mutation: a replay that returns a second order with the same status is a violation', () => {
    const first = res(201, { success: true, data: { orders: [{ id: 'o1' }] } });
    const secondOrder = res(201, { success: true, data: { orders: [{ id: 'o2' }] } });
    expect(replayVerdict(first, secondOrder).ok).toBe(false);
    const notFromReceipt = res(201, { success: true, data: { orders: [{ id: 'o1' }] } });
    expect(replayVerdict(first, notFromReceipt).ok).toBe(false); // same ids but not answered from the receipt
    const replayed = res(201, { success: true, replayed: true, data: { orders: [{ id: 'o1' }] } });
    expect(replayVerdict(first, replayed).ok).toBe(true);
    expect(replayVerdict(first, res(409, { success: false })).ok).toBe(false);
    expect(replayVerdict(res(409, { success: false, error: { code: 'DELIVERY_NO_RIDERS' } }), res(409, { success: false, error: { code: 'DELIVERY_NO_RIDERS' } })).ok).toBe(true);
  });
  it('a changed body under the same key must conflict; the verifier must hold exactly the orders named', () => {
    expect(changedBodyVerdict(res(422, { success: false, error: { code: 'IDEMPOTENCY_KEY_REUSED' } })).ok).toBe(true);
    expect(changedBodyVerdict(res(201, { success: true, data: { orders: [{ id: 'o3' }] } })).ok).toBe(false);
    const first = res(201, { success: true, data: { orders: [{ id: 'o1' }, { id: 'o2' }] } });
    expect(cardinalityVerdict(res(200, { success: true, data: { orderIds: ['o2', 'o1'] } }), first).ok).toBe(true);
    expect(cardinalityVerdict(res(200, { success: true, data: { orderIds: ['o1'] } }), first).ok).toBe(false);
    expect(cardinalityVerdict(res(404, { success: false }), first).ok).toBe(false);
  });
  it('[SCR-003] the manifest gate: every field exact, production never, a live lease required', () => {
    const lease = { nonce: 'n', expiresAt: new Date(Date.now() + 60_000).toISOString(), signature: 's' };
    const identity = { deploymentId: 'dep-1', environment: 'loadtest', buildSha: 'abc', testTenant: 'swift-default', dataClassification: 'synthetic', lease };
    const manifest = { deploymentId: 'dep-1', environment: 'loadtest', buildSha: 'abc', testTenant: 'swift-default', dataClassification: 'synthetic' };
    expect(manifestVerdict(identity, manifest).ok).toBe(true);
    expect(manifestVerdict({ ...identity, buildSha: 'def' }, manifest).ok).toBe(false);
    expect(manifestVerdict(identity, { ...manifest, buildSha: undefined }).ok).toBe(false);
    expect(manifestVerdict({ ...identity, environment: 'production' }, { ...manifest, environment: 'production' }).ok).toBe(false);
    expect(manifestVerdict({ ...identity, lease: { ...lease, expiresAt: new Date(Date.now() - 1000).toISOString() } }, manifest).ok).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// [OTA-131] A refusal is a RESULT. The oracle used to accept any two non-successes.
// ---------------------------------------------------------------------------
describe('[OTA-131] the replay verdict compares the refusal, not merely the absence of success', () => {
  const refused = (code: string, status = 409) => ({ status, body: JSON.stringify({ success: false, error: { code, message: 'x' } }) });

  it('test_two_different_refusals_are_not_one_result: a green swarm must not certify disagreement', () => {
    // The exact reproduction from the dossier: one status, two different business
    // outcomes. Before this, `{ ok: true, reason: 'both refused (same honest refusal)' }`.
    const v = replayVerdict(refused('DELIVERY_NO_RIDERS'), refused('DUPLICATE_REQUEST'));
    expect(v.ok, 'two different refusals are two different results').toBe(false);
    expect(v.reason).toMatch(/different refusals under one key/);
  });

  it('the same refusal twice is one result, and says which', () => {
    const v = replayVerdict(refused('DELIVERY_NO_RIDERS'), refused('DELIVERY_NO_RIDERS'));
    expect(v.ok).toBe(true);
    expect(v.reason).toContain('DELIVERY_NO_RIDERS');
  });

  it('a refusal carrying no error code cannot be compared, so it is not a pass', () => {
    const bare = { status: 409, body: JSON.stringify({ success: false }) };
    expect(replayVerdict(bare, bare).ok, 'unknown is never green').toBe(false);
  });
});
