import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { digestOf, declaredFields, diffOf, snapshot } from '../modules/admin/audit-change';

// [ADM-002] The canonicaliser must survive every column type the audited
// models carry. BigInt did not: `JSON.stringify` threw, `snapshot()` caught it
// and returned ABSENT, and the diff for any BigInt-bearing model was empty.
describe('[ADM-004] canonical form covers BigInt', () => {
  const row = { id: 'i1', status: 'MANUAL_REQUIRED', amountMinor: BigInt(500000), paidAt: new Date('2026-09-05T00:00:00Z') };
  it('digests a row with a BigInt column instead of throwing', () => {
    expect(() => digestOf(row)).not.toThrow();
    expect(digestOf(row)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('declared BigInt fields appear in the diff as strings', () => {
    const before = { digest: digestOf(row), fields: declaredFields(row, ['status', 'amountMinor']), exists: true };
    const afterRow = { ...row, status: 'SUCCEEDED', amountMinor: BigInt(500000) };
    const after = { digest: digestOf(afterRow), fields: declaredFields(afterRow, ['status', 'amountMinor']), exists: true };
    expect(before.fields['amountMinor']).toBe('500000');
    expect(diffOf(before, after)).toEqual({ status: { from: 'MANUAL_REQUIRED', to: 'SUCCEEDED' } });
  });
  it('snapshot() no longer reports a BigInt row as absent', async () => {
    const fake = { adRefundIntent: { findUnique: async () => row } } as unknown as PrismaClient;
    const snap = await snapshot(fake, { model: 'adRefundIntent', fields: ['status', 'amountMinor'] }, 'i1');
    expect(snap.exists).toBe(true);
    expect(snap.fields['amountMinor']).toBe('500000');
  });
});
