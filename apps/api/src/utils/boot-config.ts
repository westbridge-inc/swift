import { runtimeMode } from './runtime-mode';

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
  // [TA-S1-007] The mode is parsed, not compared: an unset or misspelled
  // NODE_ENV throws here and the process never starts — it is not "not
  // production", it is a misconfiguration nobody may guess their way past.
  if (runtimeMode(env) !== 'production') return;

  if (env['DEV_OTP_BYPASS'] === '1') {
    throw new Error('FATAL: DEV_OTP_BYPASS=1 in production — this disables OTP verification. Refusing to start.');
  }

  // OTP records are only six digits; an unkeyed hash is recoverable offline in
  // seconds. Require a strong HMAC key (dedicated, or the already load-bearing
  // JWT secret with domain separation) before accepting production traffic.
  const otpHashSecret = env['OTP_HASH_SECRET'] ?? env['JWT_SECRET'];
  if (!otpHashSecret || otpHashSecret.length < 32) {
    throw new Error('FATAL: OTP_HASH_SECRET or JWT_SECRET must be at least 32 characters in production — OTP records require a keyed HMAC. Refusing to start.');
  }

  // Identity must never silently select the deterministic test adapter. Its
  // marker URLs can approve a user, so a missing production variable is a
  // security failure, not a reasonable default.
  const kycProvider = env['KYC_PROVIDER'];
  if (kycProvider !== 'didit' && kycProvider !== 'idanalyzer') {
    throw new Error('FATAL: KYC_PROVIDER must be didit or idanalyzer in production; sandbox/unset can self-approve test identities. Refusing to start.');
  }
  if (kycProvider === 'didit' && !env['DIDIT_API_KEY']) {
    throw new Error('FATAL: DIDIT_API_KEY is required when KYC_PROVIDER=didit. Refusing to start.');
  }
  if (kycProvider === 'idanalyzer' && !env['ID_ANALYZER_API_KEY']) {
    throw new Error('FATAL: ID_ANALYZER_API_KEY is required when KYC_PROVIDER=idanalyzer. Refusing to start.');
  }

  // Subscription charges are real platform revenue. The sandbox succeeds for
  // synthetic tokens, so production must name and configure a live processor.
  const paymentProvider = env['PAYMENT_PROVIDER'];
  if (paymentProvider !== 'stripe' && paymentProvider !== 'powertranz') {
    throw new Error('FATAL: PAYMENT_PROVIDER must be stripe or powertranz in production; sandbox/unset can record fake captured revenue. Refusing to start.');
  }
  if (paymentProvider === 'stripe' && !env['STRIPE_SECRET_KEY']?.startsWith('sk_live_')) {
    throw new Error('FATAL: PAYMENT_PROVIDER=stripe requires a live STRIPE_SECRET_KEY in production. Refusing to start.');
  }
  if (paymentProvider === 'powertranz') {
    if (!env['PAYMENT_GATEWAY_KEY'] || !env['PAYMENT_GATEWAY_SECRET']) {
      throw new Error('FATAL: PAYMENT_PROVIDER=powertranz requires PAYMENT_GATEWAY_KEY and PAYMENT_GATEWAY_SECRET. Refusing to start.');
    }
    const url = env['POWERTRANZ_API_URL'];
    if (!url || !/^https:\/\//i.test(url) || /staging|sandbox|test/i.test(url)) {
      throw new Error('FATAL: production PowerTranz requires an explicit non-staging HTTPS POWERTRANZ_API_URL. Refusing to start.');
    }
  }

  // MMG subscription collection has a deterministic sandbox lookup that can
  // report approval. Require the live driver, every credential, and a URL that
  // is not the published UAT host before workers are allowed to run.
  if (env['MMG_DRIVER'] !== 'live') {
    throw new Error('FATAL: MMG_DRIVER must be live in production; sandbox/unset can settle synthetic subscription payments. Refusing to start.');
  }
  for (const name of ['MMG_API_KEY', 'MMG_MERCHANT_ID', 'MMG_PASSWORD', 'MMG_MKEY', 'MMG_MSECRET'] as const) {
    if (!env[name]) throw new Error(`FATAL: ${name} is required when MMG_DRIVER=live. Refusing to start.`);
  }
  const mmgUrl = env['MMG_API_URL'];
  if (!mmgUrl || !/^https:\/\//i.test(mmgUrl) || /mmgtest|\buat\b|sandbox/i.test(mmgUrl)) {
    throw new Error('FATAL: production MMG requires an explicit non-UAT HTTPS MMG_API_URL. Refusing to start.');
  }

  // SWIFT-012: the 'dev' notification provider logs OTP SMS to the console
  // instead of delivering them. In production that silently means signup and
  // login receive no code — a dead front door that looks perfectly healthy at
  // boot. A real provider is required; there is no safe default here.
  const notifier = env['NOTIFICATION_PROVIDER'] ?? 'dev';
  if (notifier === 'dev') {
    throw new Error('FATAL: NOTIFICATION_PROVIDER is dev (console) in production — OTP SMS would never be delivered, so no one can sign up or log in. Set NOTIFICATION_PROVIDER=twilio with the TWILIO_* credentials. Refusing to start.');
  }

  // [NOC-A F1/F2] The SAME trap, one door over, and it was unguarded: push
  // selection is orthogonal to SMS and also defaults to 'dev', whose provider
  // appends to an in-memory array and reports success. A production deploy
  // with SMS configured and PUSH_PROVIDER unset delivers ZERO pushes — no
  // order alerts, no dispatch offers, no safety pings — while every metric
  // and every log line reads healthy. The shipped deploy template even set
  // it to dev. Fail closed here too.
  const pusher = env['PUSH_PROVIDER'] ?? 'dev';
  if (pusher === 'dev') {
    throw new Error('FATAL: PUSH_PROVIDER is dev (in-memory) in production — every push would be silently swallowed while reporting success: no new-order alerts, no dispatch offers, no safety pings. Set PUSH_PROVIDER=expo. Refusing to start.');
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

  // [V8] CONSENT_IP_PEPPER degrades SILENTLY: when missing or under 32 chars,
  // hashIp() returns null and the consent ledger simply stops recording IP
  // attribution — a privacy-safe failure, but an invisible one. Not fatal
  // (the ledger's core evidence still writes); it must at least be loud.
  const pepper = env['CONSENT_IP_PEPPER'];
  if (!pepper || pepper.length < 32) {
    // eslint-disable-next-line no-console
    console.warn('WARN: CONSENT_IP_PEPPER is unset or under 32 characters — consent-ledger IP attribution is OFF (hashIp() returns null). Set a 32+ char pepper to record peppered IP evidence.');
  }
}

/**
 * SWIFT-010: data-shape boot guard. The env guard above can't see the DB, but a
 * production database with ZERO CountryConfig rows is just as fatal and just as
 * invisible: `countryFromPhone` maps every signup to a country, and with no
 * active market row it rejects them all — a front door that boots perfectly
 * healthy yet lets nobody in. Seed the spine first (`prisma/seed-production.ts`).
 * Async (needs a query) and thus separate from the sync env guard; skipped
 * outside production so dev/test/CI boot on an empty DB as before.
 */
export async function assertProductionData(
  prisma: { countryConfig: { count: () => Promise<number> } },
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (runtimeMode(env) !== 'production') return;

  const countries = await prisma.countryConfig.count();
  if (countries === 0) {
    throw new Error(
      'FATAL: no CountryConfig rows in production — no market is active, so every signup is rejected (countryFromPhone has nothing to match). Run `prisma/seed-production.ts` to seed the platform spine before starting. Refusing to start.',
    );
  }
}
