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
