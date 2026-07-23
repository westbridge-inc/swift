import crypto from 'node:crypto';

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
 * MASTER_KEK is unset the feature is off and uploads store as before
 * (private + SSE) — encryption is config, not a fork in the code.
 */

export interface KeyProvider {
  wrapDek(dek: Buffer): Promise<Buffer>;
  unwrapDek(wrapped: Buffer): Promise<Buffer>;
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
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.kek, iv);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    // One blob: iv (12) | authTag (16) | ciphertext
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  async unwrapDek(wrapped: Buffer): Promise<Buffer> {
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const ct = wrapped.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.kek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

export function generateDek(): Buffer {
  return crypto.randomBytes(32);
}

export function encryptBuffer(plaintext: Buffer, dek: Buffer): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptBuffer(ciphertext: Buffer, dek: Buffer, iv: Buffer, authTag: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
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

const renderSecret = () => process.env['STORAGE_SIGNING_SECRET'] ?? 'dev-signing-secret';

export function signRenderToken(docId: string, expires: number): string {
  return crypto
    .createHmac('sha256', renderSecret())
    .update(`render:${docId}:${expires}`)
    .digest('hex')
    .slice(0, 32);
}

/** Constant-time verification of a render-token signature [SWIFT-106]. A plain
 *  `sig === expected` compares byte-by-byte and short-circuits on the first
 *  mismatch, leaking — through response timing — how much of the HMAC an
 *  attacker has already guessed. timingSafeEqual removes that oracle. */
export function verifyRenderToken(docId: string, expires: number, sig: string): boolean {
  const expected = Buffer.from(signRenderToken(docId, expires));
  const provided = Buffer.from(sig);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

/** Path (relative to the API origin) for a time-limited decrypted render. */
export function mintRenderPath(docId: string, ttlSeconds = 300): { path: string; expiresInSeconds: number } {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  return {
    path: `/api/v1/verification/render/${docId}?expires=${expires}&sig=${signRenderToken(docId, expires)}`,
    expiresInSeconds: ttlSeconds,
  };
}
