import { createHash } from 'node:crypto';

/**
 * [D-4] The two things a database backup does NOT save, made checkable.
 *
 * Verification documents are envelope-encrypted objects in the bucket, not
 * rows. A restored database without the bucket is rows describing documents
 * that no longer exist; a restored bucket without MASTER_KEK is ciphertext
 * forever. backup.sh and the preflight used to say this as a reminder. A
 * reminder is not a control — these are.
 *
 *   Bucket: versioning must be ON, so a deleted or overwritten object can be
 *   recovered. The preflight asks the bucket (`aws s3api get-bucket-versioning`)
 *   and this parses the answer.
 *
 *   KEK: nothing on this machine can prove a copy exists elsewhere. What CAN
 *   be proven is that the copy someone escrowed is THIS key: when the KEK is
 *   put in escrow, its SHA-256 fingerprint is recorded as
 *   MASTER_KEK_ESCROW_FINGERPRINT. The preflight recomputes it. A rotated key
 *   whose escrow was never updated — the quiet way this fails — mismatches.
 */

export type Verdict = { ok: boolean; line: string; detail?: string[] };

export function kekFingerprint(masterKekBase64: string): string {
  return createHash('sha256').update(Buffer.from(masterKekBase64, 'base64')).digest('hex');
}

export function kekEscrowStatus(env: Record<string, string | undefined>): Verdict {
  const kek = env['MASTER_KEK'];
  const escrow = env['MASTER_KEK_ESCROW_FINGERPRINT']?.trim().toLowerCase();
  if (!kek) {
    return { ok: false, line: 'MASTER_KEK is not set — the boot guard refuses production without it.' };
  }
  if (!escrow) {
    return {
      ok: false,
      line: 'MASTER_KEK has no escrow on record.',
      detail: [
        'Put a copy of MASTER_KEK somewhere this server\'s loss cannot take with it',
        '(a password manager vault, a sealed envelope — not this disk, not the backup bucket),',
        `then record its fingerprint here:  MASTER_KEK_ESCROW_FINGERPRINT=${kekFingerprint(kek)}`,
      ],
    };
  }
  const actual = kekFingerprint(kek);
  if (escrow !== actual) {
    return {
      ok: false,
      line: 'MASTER_KEK does not match the escrowed copy — the key was rotated and the escrow was not.',
      detail: [`escrow fingerprint ${escrow.slice(0, 12)}…, live key ${actual.slice(0, 12)}…`, 'Re-escrow the live key and update MASTER_KEK_ESCROW_FINGERPRINT.'],
    };
  }
  return { ok: true, line: `MASTER_KEK matches its escrowed copy (sha256 ${actual.slice(0, 12)}…).` };
}

/** `aws s3api get-bucket-versioning` prints `{}` for never-configured, or
 *  `{ "Status": "Enabled" | "Suspended" }`. Anything else is not an answer. */
export function parseBucketVersioning(stdout: string): 'Enabled' | 'Suspended' | 'Never' | 'Unknown' {
  try {
    const parsed = JSON.parse(stdout || '{}') as { Status?: unknown };
    if (parsed.Status === 'Enabled') return 'Enabled';
    if (parsed.Status === 'Suspended') return 'Suspended';
    if (parsed.Status === undefined) return 'Never';
    return 'Unknown';
  } catch {
    return 'Unknown';
  }
}

export function bucketVersioningStatus(bucket: string, endpoint: string | undefined, versioning: ReturnType<typeof parseBucketVersioning>): Verdict {
  const enable = `aws s3api put-bucket-versioning --bucket ${bucket}${endpoint ? ` --endpoint-url ${endpoint}` : ''} --versioning-configuration Status=Enabled`;
  switch (versioning) {
    case 'Enabled':
      return { ok: true, line: `object bucket ${bucket} is versioned — a deleted or overwritten document can be recovered.` };
    case 'Suspended':
      return { ok: false, line: `object bucket ${bucket} has versioning SUSPENDED — deletions are final again.`, detail: [enable] };
    case 'Never':
      return { ok: false, line: `object bucket ${bucket} has never had versioning enabled — a deleted KYC document is gone.`, detail: [enable] };
    default:
      return { ok: false, line: `could not read versioning for ${bucket} — the bucket answered with something unexpected.`, detail: ['Check the credentials and endpoint, then re-run.'] };
  }
}
