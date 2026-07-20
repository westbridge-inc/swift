/**
 * Fail-closed boot configuration guard. Called before the server accepts
 * traffic; a misconfiguration that would silently weaken security must refuse
 * to start rather than run in a compromised state.
 *
 * SWIFT-AUD-D9-02 / D3-01: in production, both the document-encryption KEK and
 * the render/signed-URL HMAC secret are load-bearing for KYC-document privacy.
 * Unset MASTER_KEK = government IDs stored as plaintext; default/unset
 * STORAGE_SIGNING_SECRET = anyone can forge a render token for any applicant's
 * decrypted ID. Neither failure is visible at runtime, so we assert them here.
 */
export function assertSafeBootConfig(env: Record<string, string | undefined> = process.env): void {
  if (env['NODE_ENV'] !== 'production') return;

  if (env['DEV_OTP_BYPASS'] === '1') {
    throw new Error('FATAL: DEV_OTP_BYPASS=1 in production — this disables OTP verification. Refusing to start.');
  }

  // Verification documents are envelope-encrypted at rest ONLY when MASTER_KEK
  // is set; unset silently stores KYC PII in the clear (plaintext on disk with
  // the default local storage provider). Fail closed.
  const kek = env['MASTER_KEK'];
  if (!kek) {
    throw new Error('FATAL: MASTER_KEK is required in production — without it, verification documents (government IDs, selfies) store UNENCRYPTED. Refusing to start.');
  }
  if (Buffer.from(kek, 'base64').length !== 32) {
    throw new Error('FATAL: MASTER_KEK must be 32 bytes, base64-encoded.');
  }

  // The render/signed-URL HMAC is the ONLY gate on the unauthenticated document
  // render route. A default/unset secret is published in the (public) repo, so
  // anyone could forge a valid token for any docId and stream a decrypted ID.
  const signing = env['STORAGE_SIGNING_SECRET'];
  if (!signing || signing === 'dev-signing-secret') {
    throw new Error('FATAL: STORAGE_SIGNING_SECRET must be set to a non-default value in production — the document render/signed-URL HMAC depends on it. Refusing to start.');
  }

  // SWIFT-AUD-D6-06: the default 'local' storage provider writes uploads and
  // KYC documents to this instance's disk. On a multi-instance or
  // ephemeral-disk deploy the files silently fragment or vanish, and they sit
  // outside the database backup story. Require a real object-storage
  // provider; STORAGE_ALLOW_LOCAL=1 is the explicit acknowledgement for a
  // deliberate single-instance pilot on a persistent volume.
  const storage = env['STORAGE_PROVIDER'] ?? 'local';
  if (storage === 'local' && env['STORAGE_ALLOW_LOCAL'] !== '1') {
    throw new Error('FATAL: STORAGE_PROVIDER is local (or unset) in production — uploads and verification documents would live on a single instance\'s disk. Set STORAGE_PROVIDER=s3|r2, or STORAGE_ALLOW_LOCAL=1 only for a deliberate single-instance pilot with a persistent volume.');
  }
}
