import crypto from 'node:crypto';
import { storageSigningKeys } from '../../utils/signing-keys';

/**
 * Envelope encryption for verification documents (onboarding spec §5).
 *
 * Each file gets a fresh random 256-bit DEK; the file is AES-256-GCM
 * encrypted with it, and the DEK itself is wrapped by the master KEK and
 * stored beside the object's metadata (never the raw DEK). Deleting the
 * wrapped DEK makes the ciphertext permanently unrecoverable — that is the
 * crypto-shred the retention purge and right-to-erasure rely on: even a
 * bucket backup of the ciphertext is dead without the DEK.
 *
 * The KEK comes from a swappable KeyProvider (hard rule 4): env-based for
 * pilot, Vault/KMS later without touching this file's callers. When
 * MASTER_KEK is unset the provider reports unavailable. Verification uploads
 * fail closed rather than minting a pointer without envelope metadata.
 */

export interface KeyProvider {
  wrapDek(dek: Buffer): Promise<Buffer>;
  unwrapDek(wrapped: Buffer): Promise<Buffer>;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_KEY_BYTES = IV_BYTES + TAG_BYTES + KEY_BYTES;

function requireLength(value: Buffer, length: number, name: string): void {
  if (!Buffer.isBuffer(value) || value.length !== length) throw new Error(`Invalid ${name} length`);
}

/** KEK from MASTER_KEK (base64, 32 bytes); wrap = AES-256-GCM over the DEK. */
export class EnvKeyProvider implements KeyProvider {
  private kek: Buffer;

  constructor(masterKekB64: string) {
    const kek = Buffer.from(masterKekB64, 'base64');
    if (kek.length !== 32) {
      throw new Error('MASTER_KEK must be 32 bytes, base64-encoded');
    }
    this.kek = kek;
  }

  async wrapDek(dek: Buffer): Promise<Buffer> {
    requireLength(dek, KEY_BYTES, 'DEK');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.kek, iv, { authTagLength: TAG_BYTES });
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    // One blob: iv (12) | authTag (16) | ciphertext
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  async unwrapDek(wrapped: Buffer): Promise<Buffer> {
    requireLength(wrapped, WRAPPED_KEY_BYTES, 'wrapped DEK');
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const ct = wrapped.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.kek, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

export function generateDek(): Buffer {
  return crypto.randomBytes(32);
}

export function encryptBuffer(plaintext: Buffer, dek: Buffer): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
  requireLength(dek, KEY_BYTES, 'DEK');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptBuffer(ciphertext: Buffer, dek: Buffer, iv: Buffer, authTag: Buffer): Buffer {
  requireLength(dek, KEY_BYTES, 'DEK');
  requireLength(iv, IV_BYTES, 'IV');
  requireLength(authTag, TAG_BYTES, 'authentication tag');
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

let provider: KeyProvider | null | undefined;

/** The configured key provider, or null when envelope encryption is off. */
export function getKeyProvider(): KeyProvider | null {
  if (provider !== undefined) return provider;
  const kek = process.env['MASTER_KEK'];
  provider = kek ? new EnvKeyProvider(kek) : null;
  return provider;
}

/** Test hook: re-read MASTER_KEK on next access. */
export function resetKeyProviderForTests() {
  provider = undefined;
}

// ── Render tokens ────────────────────────────────────────────────────────────
// The decrypting render route is <img>-loadable, so it can't demand a JWT.
// Instead the AUDITED admin document-url route mints a short-lived HMAC token;
// the render route verifies it. Same signing model as the dev signed URLs.

// [M-37] The keyring never falls open in production; see utils/signing-keys.
const renderSecret = () => storageSigningKeys().current.secret;

/**
 * [VERIFY-DOCS V3] The token names the REVIEWER it was minted for. The render
 * route re-reads that reviewer's document-reviewer grant on every load, so a
 * link stops working the moment the grant is revoked (or the reviewer is
 * suspended or demoted) — it is no longer a five-minute bearer token that
 * nobody can take back. A link cannot be re-aimed at another reviewer: the id
 * is inside the signature.
 */
export function signRenderToken(docId: string, expires: number, reviewerUserId: string): string {
  return crypto
    .createHmac('sha256', renderSecret())
    .update(`render:${docId}:${expires}:${reviewerUserId}`)
    .digest('hex')
    .slice(0, 32);
}

/** Constant-time verification of a render-token signature [SWIFT-106]. A plain
 *  `sig === expected` compares byte-by-byte and short-circuits on the first
 *  mismatch, leaking — through response timing — how much of the HMAC an
 *  attacker has already guessed. timingSafeEqual removes that oracle. */
export function verifyRenderToken(docId: string, expires: number, reviewerUserId: string, sig: string): boolean {
  const expected = Buffer.from(signRenderToken(docId, expires, reviewerUserId));
  const provided = Buffer.from(sig);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

/** Path (relative to the API origin) for a time-limited decrypted render,
 *  bound to the reviewer who asked for it. */
export function mintRenderPath(docId: string, reviewerUserId: string, ttlSeconds = 300): { path: string; expiresInSeconds: number } {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const reviewer = encodeURIComponent(reviewerUserId);
  return {
    path: `/api/v1/verification/render/${docId}?expires=${expires}&reviewer=${reviewer}&sig=${signRenderToken(docId, expires, reviewerUserId)}`,
    expiresInSeconds: ttlSeconds,
  };
}
