import { runtimeMode } from './runtime-mode';
import { malformedAllowlistPositions } from '../providers/notifications/sms-recipient-allowlist';
import { firstInvalidTwilioConfig } from './twilio-identity';
import { PUBLIC_API_HOST, assertDisabledCardRailConfig } from './card-rail';
import { testControlEnabled } from '../modules/ops/test-control';
import { FREE_CANCEL_WINDOW_MIN } from '../modules/order/cancel-policy';
import { assertMmgCheckoutConfig } from '../providers/mmg/mmg-checkout';
import { assertSettlementPublicationLeaseConfig } from '../modules/billing/settlement-publication-lease';
import { assertQrConfig, scanRawRetentionDays } from '../modules/qr/qr-config';
import { assertDurableStorageConfig } from '../providers/storage/storage-config';

/**
 * [R2 C2] `/test-control/identity` exists only in loadtest and test builds
 * (TEST_CONTROL_ENABLED=1) and signs an expiring load lease with
 * TEST_CONTROL_SECRET. The fallback in modules/ops/test-control.ts is a
 * literal printed in this PUBLIC repository: fine for an isolated `test`
 * process, fatal for a loadtest deployment anyone can reach, where every
 * lease would be forgeable. Refuse to start instead.
 */
export function assertTestControlConfig(env: Record<string, string | undefined> = process.env): void {
  if (!testControlEnabled(env) || runtimeMode(env) === 'test') return;
  const secret = env['TEST_CONTROL_SECRET'];
  if (!secret || secret.length < 32) {
    throw new Error('FATAL: TEST_CONTROL_SECRET must be at least 32 characters when TEST_CONTROL_ENABLED=1 in loadtest — otherwise load leases are signed with a value printed in the public repository and anyone can forge one. Refusing to start.');
  }
}

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
function assertSmsRecipientAllowlistConfig(env: Record<string, string | undefined>): void {
  const present = env['SMS_RECIPIENT_ALLOWLIST'] !== undefined || env['SMS_RECIPIENT_ALLOWLIST_FILE'] !== undefined;
  if (!present) return;
  if (runtimeMode(env) === 'production') {
    throw new Error('FATAL: SMS_RECIPIENT_ALLOWLIST is set in production — it exists only to stop non-production deployments texting strangers, and in production it would silently stop real users receiving codes. Remove it. Refusing to start.');
  }
  const bad = malformedAllowlistPositions(env['SMS_RECIPIENT_ALLOWLIST']);
  if (bad.length > 0) {
    throw new Error(`FATAL: SMS_RECIPIENT_ALLOWLIST entry ${bad.join(', ')} is not an E.164 number (+ and digits). Refusing to start rather than texting no one by mistake.`);
  }
}

/**
 * [PT-2 · review S2] In EVERY mode (staging runs as development): the card
 * simulator moves no money but its "Approve" books a paid week, so it never
 * runs where the public — or, until the DNS cutover, Apple's reviewers — can
 * reach it: not on the public API host. Its test switch also needs this test
 * server's own address set, so the check can be made at all.
 */
export function assertCardSimulatorNotPublic(env: Record<string, string | undefined>): void {
  if (env['CARD_RAIL_PROVIDER'] === 'simulator' || (env['CARD_RAIL_SIMULATOR_LIVE'] ?? '0') !== '0') {
    let host = '';
    try { host = new URL(env['API_PUBLIC_URL'] ?? '').hostname.toLowerCase(); } catch { host = ''; }
    if (host === PUBLIC_API_HOST) {
      throw new Error(`FATAL: the card simulator (CARD_RAIL_PROVIDER=simulator or CARD_RAIL_SIMULATOR_LIVE) on the public API host ${PUBLIC_API_HOST} — a test page that books weeks without money. Refusing to start.`);
    }
    if ((env['CARD_RAIL_SIMULATOR_LIVE'] ?? '0') !== '0' && !host) {
      throw new Error('FATAL: CARD_RAIL_SIMULATOR_LIVE needs API_PUBLIC_URL set to this TEST server\'s own address (never the public host). Refusing to start.');
    }
  }
}

export function assertSafeBootConfig(env: Record<string, string | undefined> = process.env): void {
  // [R2 C2] Applies to loadtest builds, so it runs before the production gate.
  assertTestControlConfig(env);
  // MMG hosted checkout, in EVERY mode (staging runs development mode against
  // MMG UAT): MMG_CHECKOUT_ENABLED is exactly 0 or 1, and once on, the live
  // driver needs its whole configuration — keys parsed, the request proven to
  // fit the key. Production also refuses the sandbox and a UAT page.
  assertMmgCheckoutConfig(env);
  // Validate the documented retention setting in every mode. Production
  // salts are checked below after the existing configuration guards.
  scanRawRetentionDays(env);
  // [TA-S1-007] The mode is parsed, not compared: an unset or misspelled
  // NODE_ENV throws here and the process never starts — it is not "not
  // production", it is a misconfiguration nobody may guess their way past.
  // [L04 · SMS allowlist] The non-production recipient allowlist is checked
  // before the production gate: production refuses it outright (it must never
  // quietly restrict real users), and elsewhere a malformed entry is refused
  // loudly instead of silently texting no one. Values are never echoed.
  assertSmsRecipientAllowlistConfig(env);
  assertCardSimulatorNotPublic(env);
  if (runtimeMode(env) !== 'production') {
    assertDurableStorageConfig(env);
    return;
  }

  // Launch safeguards are enforced by the server and worker, regardless of
  // what an older client displays. These bypasses exist only for local/test
  // fixtures; production must never admit them.
  if (env['CONSENT_REQUIRED'] === '0') {
    throw new Error('FATAL: CONSENT_REQUIRED=0 bypasses signup consent in production. Refusing to start.');
  }
  if (env['ADMIN_CAPABILITY_MODE'] === 'shadow') {
    throw new Error('FATAL: ADMIN_CAPABILITY_MODE=shadow bypasses administrator enforcement in production. Refusing to start.');
  }
  if (env['PREVIEW_MODE'] === '1') {
    throw new Error('FATAL: PREVIEW_MODE=1 bypasses launch listing safeguards in production. Refusing to start.');
  }

  if (env['DEV_OTP_BYPASS'] === '1') {
    throw new Error('FATAL: DEV_OTP_BYPASS=1 in production — this disables OTP verification. Refusing to start.');
  }

  // [ledger E08] The settled posture is hold ON: every order is born held for
  // ORDER_HOLD_MINUTES (default 5) — the customer's free-cancel window, hidden
  // from the vendor. But holdWindowMs() and checkoutQueueTiming() read an
  // UNSET LIFECYCLE_V2 as hold OFF, so a deploy that merely omits the variable
  // pushes new orders to the vendor instantly while the app still promises a
  // free-cancel window. Production must choose explicitly: off may be chosen,
  // never defaulted into.
  const lifecycleV2 = env['LIFECYCLE_V2'];
  if (lifecycleV2 !== '1' && lifecycleV2 !== '0') {
    throw new Error('FATAL: LIFECYCLE_V2 must be exactly 1 or 0 in production — an unset variable silently disables the order hold, so new orders hit the vendor instantly while the app still promises the free-cancel window. Set LIFECYCLE_V2=1 (hold on, the settled posture) or LIFECYCLE_V2=0 (deliberately off). Refusing to start.');
  }
  // When the hold is on, a set-but-unparseable window makes holdWindowMs()
  // return null — the same silent hold-off — so that too refuses, never
  // silently defaults. [DS214 D1] And the hold may never be SHORTER than the
  // free-cancel window it protects (FREE_CANCEL_WINDOW_MIN): a shorter hold
  // puts an order on the vendor board while the customer may still cancel it
  // free, which is exactly the REPORT-036 defect (order.service.ts holdWindowMs).
  if (lifecycleV2 === '1' && env['ORDER_HOLD_MINUTES'] !== undefined) {
    const holdMinutes = Number(env['ORDER_HOLD_MINUTES']);
    if (!Number.isFinite(holdMinutes) || holdMinutes < FREE_CANCEL_WINDOW_MIN) {
      throw new Error(`FATAL: ORDER_HOLD_MINUTES must be a number of minutes no shorter than the ${FREE_CANCEL_WINDOW_MIN}-minute free-cancel window when LIFECYCLE_V2=1 — an invalid value silently disables the order hold, and a shorter one shows orders to the vendor while the customer may still cancel free. Set ORDER_HOLD_MINUTES=${FREE_CANCEL_WINDOW_MIN} or unset it. Refusing to start.`);
    }
  }

  // [AX352] SETTLEMENT_PUBLICATION_LEASE_MS is a test and drill setting: a
  // shorter settlement publication lease can lapse while a slow row replays,
  // before any progress is written, and strand the unpaid tail of a file.
  assertSettlementPublicationLeaseConfig(env);

  // OTP records are only six digits; an unkeyed hash is recoverable offline in
  // seconds. Require a strong HMAC key (dedicated, or the already load-bearing
  // JWT secret with domain separation) before accepting production traffic.
  const otpHashSecret = env['OTP_HASH_SECRET'] ?? env['JWT_SECRET'];
  if (!otpHashSecret || otpHashSecret.length < 32) {
    throw new Error('FATAL: OTP_HASH_SECRET or JWT_SECRET must be at least 32 characters in production — OTP records require a keyed HMAC. Refusing to start.');
  }

  // Launch verification is human review only. Require an explicit production
  // setting; neither external processors nor synthetic approvals are allowed.
  const kycProvider = env['KYC_PROVIDER'];
  if (kycProvider !== 'manual') {
    throw new Error('FATAL: KYC_PROVIDER must be manual in production; launch verification requires human review. Refusing to start.');
  }

  // Subscription charges are real platform revenue. The sandbox succeeds for
  // synthetic tokens, so production must configure a live processor or
  // explicitly disable cards. The disabled adapter refuses all instructions;
  // enrollment/rail-selection boundaries never offer CARD.
  const paymentProvider = env['PAYMENT_PROVIDER'];
  if (paymentProvider !== 'stripe' && paymentProvider !== 'powertranz' && paymentProvider !== 'disabled') {
    throw new Error('FATAL: PAYMENT_PROVIDER must be stripe, powertranz or disabled in production; sandbox/unset can record fake captured revenue. Refusing to start.');
  }
  assertDisabledCardRailConfig(env);
  // [PT-1 · C10] Card rail v2. The card simulator is a test page with no real
  // money: production refuses to start while it is even named — whatever the
  // flag says. And this build has no production-capable v2 provider (the
  // first real one is written from its provider's own documentation), so
  // production refuses to switch the rail on rather than fail at a partner's
  // first tap. The flag is 1 or 0 (or unset = 0), never a guess.
  if (env['CARD_RAIL_PROVIDER'] === 'simulator') {
    throw new Error('FATAL: CARD_RAIL_PROVIDER=simulator in production — the card simulator is a test page with no real money. Refusing to start.');
  }
  // [PT-2] The staging-only switch that lets the simulator show the card
  // choice: production refuses it whatever its value, as it refuses the simulator.
  if (env['CARD_RAIL_SIMULATOR_LIVE'] !== undefined && env['CARD_RAIL_SIMULATOR_LIVE'] !== '' && env['CARD_RAIL_SIMULATOR_LIVE'] !== '0') {
    throw new Error('FATAL: CARD_RAIL_SIMULATOR_LIVE is a test-server switch (the card simulator shows a test card choice); production refuses it. Refusing to start.');
  }
  const cardRailV2 = env['CARD_RAIL_V2'];
  if (cardRailV2 !== undefined && cardRailV2 !== '' && cardRailV2 !== '0' && cardRailV2 !== '1') {
    throw new Error('FATAL: CARD_RAIL_V2 must be 1 or 0 in production. Refusing to start.');
  }
  if (cardRailV2 === '1') {
    throw new Error('FATAL: CARD_RAIL_V2=1 in production, but this build has no production card rail v2 provider (only the simulator, which production refuses). Refusing to start.');
  }
  // [AX297 F5] Draining v2 after it was switched off is its own switch, held
  // to the same rules: 1 or 0, and never 1 while production has no v2 provider
  // (v2 has never run there, so there is nothing to drain).
  const cardRailV2Drain = env['CARD_RAIL_V2_DRAIN'];
  if (cardRailV2Drain !== undefined && cardRailV2Drain !== '' && cardRailV2Drain !== '0' && cardRailV2Drain !== '1') {
    throw new Error('FATAL: CARD_RAIL_V2_DRAIN must be 1 or 0 in production. Refusing to start.');
  }
  if (cardRailV2Drain === '1') {
    throw new Error('FATAL: CARD_RAIL_V2_DRAIN=1 in production, but this build has no production card rail v2 provider, so there is nothing to drain. Refusing to start.');
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
  if (env['MMG_REFERENCE_ROUNDTRIP_VERIFIED'] !== '1') {
    throw new Error('FATAL: MMG_REFERENCE_ROUNDTRIP_VERIFIED must be exactly 1 after sandbox UAT proves the merchant reference in lookup and history. Refusing to start.');
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
  if (notifier !== 'twilio') {
    throw new Error('FATAL: NOTIFICATION_PROVIDER must be twilio in production. Refusing to start.');
  }
  const invalidTwilioConfig = firstInvalidTwilioConfig(env);
  if (invalidTwilioConfig) {
    throw new Error(`FATAL: ${invalidTwilioConfig} when NOTIFICATION_PROVIDER=twilio. Refusing to start.`);
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
  // [M-37] Non-default is not enough: a short secret is a guessable one.
  if (signing.length < 32) {
    throw new Error('FATAL: STORAGE_SIGNING_SECRET must be at least 32 characters in production — the document and statement links are signed with it. Refusing to start.');
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
  assertDurableStorageConfig(env);

  // [V8] CONSENT_IP_PEPPER degrades SILENTLY: when missing or under 32 chars,
  // hashIp() returns null and the consent ledger simply stops recording IP
  // attribution — a privacy-safe failure, but an invisible one. Not fatal
  // (the ledger's core evidence still writes); it must at least be loud.
  const pepper = env['CONSENT_IP_PEPPER'];
  if (!pepper || pepper.length < 32) {
    // eslint-disable-next-line no-console
    console.warn('WARN: CONSENT_IP_PEPPER is unset or under 32 characters — consent-ledger IP attribution is OFF (hashIp() returns null). Set a 32+ char pepper to record peppered IP evidence.');
  }
  assertQrConfig(env);
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
