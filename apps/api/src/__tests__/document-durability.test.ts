import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { kekEscrowStatus, kekFingerprint, parseBucketVersioning, bucketVersioningStatus } from '../modules/ops/document-durability';

// ---------------------------------------------------------------------------
// [D-4] The database backup does not save the documents. Two controls replace
// two reminders: the bucket must be versioned, and the escrowed KEK must be
// THIS key. Each is graded on what it can actually prove.
// ---------------------------------------------------------------------------

const KEK = Buffer.alloc(32, 9).toString('base64');
const FP = createHash('sha256').update(Buffer.alloc(32, 9)).digest('hex');

describe('the KEK escrow is a fingerprint, not a promise', () => {
  it('no KEK: the boot guard\'s problem, said plainly', () => {
    expect(kekEscrowStatus({}).ok).toBe(false);
  });

  it('no escrow on record: fails, and prints the exact line to record once escrowed', () => {
    const v = kekEscrowStatus({ MASTER_KEK: KEK });
    expect(v.ok).toBe(false);
    expect(v.detail?.join('\n')).toContain(`MASTER_KEK_ESCROW_FINGERPRINT=${FP}`);
  });

  it('a rotated key whose escrow was never updated MISMATCHES — the quiet failure', () => {
    const rotated = Buffer.alloc(32, 10).toString('base64');
    const v = kekEscrowStatus({ MASTER_KEK: rotated, MASTER_KEK_ESCROW_FINGERPRINT: FP });
    expect(v.ok).toBe(false);
    expect(v.line).toMatch(/rotated/);
  });

  it('the escrowed copy is this key: passes (case-insensitive, whitespace-tolerant)', () => {
    expect(kekEscrowStatus({ MASTER_KEK: KEK, MASTER_KEK_ESCROW_FINGERPRINT: ` ${FP.toUpperCase()} ` }).ok).toBe(true);
    expect(kekFingerprint(KEK)).toBe(FP);
  });

  it('the fingerprint is of the KEY BYTES, not the base64 text — never the key itself', () => {
    // A fingerprint that leaked would not recover the key: 32 bytes of hash,
    // one-way. And it must not vary with base64 padding/encoding quirks.
    expect(kekFingerprint(KEK)).not.toContain(KEK.slice(0, 8));
    expect(kekFingerprint(KEK)).toHaveLength(64);
  });
});

describe('the bucket answers, and the answer is graded', () => {
  it('parses the three real answers and refuses to guess at a fourth', () => {
    expect(parseBucketVersioning('{"Status": "Enabled"}')).toBe('Enabled');
    expect(parseBucketVersioning('{"Status": "Suspended"}')).toBe('Suspended');
    expect(parseBucketVersioning('{}')).toBe('Never');
    expect(parseBucketVersioning('')).toBe('Never');
    expect(parseBucketVersioning('{"Status": "Maybe"}')).toBe('Unknown');
    expect(parseBucketVersioning('not json')).toBe('Unknown');
  });

  it('only Enabled passes; every failure carries the command that fixes it', () => {
    expect(bucketVersioningStatus('swift-kyc', 'https://r2.example', 'Enabled').ok).toBe(true);
    for (const state of ['Suspended', 'Never'] as const) {
      const v = bucketVersioningStatus('swift-kyc', 'https://r2.example', state);
      expect(v.ok).toBe(false);
      expect(v.detail?.[0]).toContain('put-bucket-versioning --bucket swift-kyc --endpoint-url https://r2.example --versioning-configuration Status=Enabled');
    }
    expect(bucketVersioningStatus('swift-kyc', undefined, 'Unknown').ok).toBe(false);
  });
});
