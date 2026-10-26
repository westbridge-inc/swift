import { assertPlacesConfig } from '../providers/places/places-config';
import { runtimeMode } from './runtime-mode';
import { malformedAllowlistPositions } from '../providers/notifications/sms-recipient-allowlist';
import { firstInvalidTwilioConfig } from './twilio-identity';
import { PUBLIC_API_HOST, assertDisabledCardRailConfig } from './card-rail';
import { powerTranzConfigFromEnv } from '../providers/card/powertranz-provider';
import { testControlEnabled } from '../modules/ops/test-control';
import { assertMmgCheckoutConfig } from '../providers/mmg/mmg-checkout';
import { assertCallRelayConfig } from '../modules/calls/call-relay-switch';
import { assertSettlementPublicationLeaseConfig } from '../modules/billing/settlement-publication-lease';
import { assertQrConfig, scanRawRetentionDays } from '../modules/qr/qr-config';
import { identitySalt } from '../modules/integrity/normalize';
import { smtpConfigFromEnv } from '../providers/notifications/smtp-email';
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
  // [Review S2-1] …and the same for a real provider's TEST system (its sandbox).
  const testSystem = env['CARD_RAIL_PROVIDER'] === 'simulator'
    || (env['CARD_RAIL_PROVIDER'] === 'powertranz' && env['CARD_RAIL_ENVIRONMENT'] !== 'live');
  if (testSystem || (env['CARD_RAIL_SIMULATOR_LIVE'] ?? '0') !== '0') {
    let host = '';
    // [#1511 review S4] A trailing dot names the same host.
    try { host = new URL(env['API_PUBLIC_URL'] ?? '').hostname.toLowerCase().replace(/\.+$/, ''); } catch { host = ''; }
    if (host === PUBLIC_API_HOST) {
      throw new Error(`FATAL: a TEST card system (the simulator, CARD_RAIL_SIMULATOR_LIVE, or the provider's sandbox) on the public API host ${PUBLIC_API_HOST} — it books weeks without real money. Refusing to start.`);
    }
    if ((env['CARD_RAIL_SIMULATOR_LIVE'] ?? '0') !== '0' && !host) {
      throw new Error('FATAL: CARD_RAIL_SIMULATOR_LIVE needs API_PUBLIC_URL set to this TEST server\'s own address (never the public host). Refusing to start.');
    }
  }
}

/**
 * [PT-4 · review S3] Called for every mode but production: real (live) cards
 * run only on the production server. A test server told "live" would charge
 * real cards and book them into a database that is not the record. Refused at
 * boot, loudly.
 */
export function assertNoLiveCardsOffProduction(env: Record<string, string | undefined>): void {
  if (env['CARD_RAIL_PROVIDER'] === 'powertranz' && env['CARD_RAIL_ENVIRONMENT'] === 'live') {
    throw new Error('FATAL: CARD_RAIL_ENVIRONMENT=live (real cards) outside production — a test server never charges real cards. Use sandbox here. Refusing to start.');
  }
}

/**
 * [LAUNCH-LOCK · owner ruling 13 Oct, #34] Until an attorney signs off,
 * production takes no card payment and runs no ads (GUARDRAILS §8). Both are
 * already off by default; this makes "off" a refusal to boot rather than a
 * setting someone can flip: turning either on in production is a reviewed
 * change to this function (and to pilot-up.sh's matching refusal), never a
 * deploy/.env edit.
 *   Cards: no card instruction (PAYMENT_PROVIDER exactly disabled; the
 *   card-rail contract, checked earlier, then also requires CARD_RAIL_KILL=1),
 *   and none of card rail v2's switches (CARD_RAIL_V2, its drain, saving
 *   cards) set to anything but 0. With v2 off the weekly fee never offers a
 *   CARD pay action.
 *   Ads: ADS_ENABLED unset or 0 (only exactly 1 opens the ads routes).
 * Called only in production. Each refusal names its setting, never a value.
 */
function assertProductionLaunchLocks(env: Record<string, string | undefined>): void {
  if (env['PAYMENT_PROVIDER'] !== 'disabled') {
    throw new Error('FATAL: PAYMENT_PROVIDER must be exactly disabled in production — no card payment until an attorney signs off (owner ruling, 13 Oct); turning cards on is a reviewed code change, not a setting. Refusing to start.');
  }
  for (const name of ['CARD_RAIL_V2', 'CARD_RAIL_V2_DRAIN', 'CARD_RAIL_ENROLL', 'ADS_ENABLED'] as const) {
    const value = env[name];
    if (value !== undefined && value !== '' && value !== '0') {
      const what = name === 'ADS_ENABLED' ? 'ads stay off' : 'no card payment';
      throw new Error(`FATAL: ${name} must be unset or 0 in production — ${what} until an attorney signs off (owner ruling, 13 Oct); turning it on is a reviewed code change, not a setting. Refusing to start.`);
    }
  }
}

/** [TA-S0-003 · R3] The two runtime logins deploy/rls-logins.sh creates. */
export const WALL_REQUEST_LOGIN = 'swift_app_login';
export const WALL_SYSTEM_LOGIN = 'swift_system_login';

const isSet = (value: string | undefined): boolean => value !== undefined && value !== '';

/** The login name and the database a postgres URL names; null when it is not one. Never echoed. */
function loginOf(raw: string | undefined): { user: string; target: string } | null {
  if (!isSet(raw)) return null;
  try {
    const url = new URL(raw as string);
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') return null;
    return { user: decodeURIComponent(url.username), target: `${url.hostname}:${url.port || '5432'}${url.pathname}` };
  } catch {
    return null;
  }
}

/**
 * [TA-S0-003 · R3] TENANT_RLS_BIND=1 in production is the business wall's
 * contract posture: the API and the worker run on the two least-privilege
 * logins (deploy/rls-logins.sh), handed over as DATABASE_URL_FILE and
 * SYSTEM_DATABASE_URL_FILE by deploy/docker-compose.wall.yml, and never on the
 * database owner. Refused before anything connects: unscoped access that is
 * not denied, the wall-less EXPAND declaration riding along, the owner's
 * password anywhere in the process, a missing URL, a request URL that is not
 * swift_app_login or a system URL that is not swift_system_login (so never
 * the owner, postgres, or one login for both), or two URLs naming different
 * databases. The database-side proof (that those logins really are walled and
 * least-privilege) is the boot attestation (boot/tenant-wall.ts,
 * boot/system-login.ts). Messages name settings and roles, never a value.
 */
export function assertWallLoginConfig(env: Record<string, string | undefined>): void {
  if (runtimeMode(env) !== 'production' || env['TENANT_RLS_BIND'] !== '1') return;
  const refuse = (why: string): never => {
    throw new Error(`FATAL: TENANT_RLS_BIND=1 in production (the business wall's contract posture), but ${why}. Refusing to start.`);
  };
  if (env['TENANT_UNSCOPED_ACCESS'] !== 'deny') {
    refuse('TENANT_UNSCOPED_ACCESS is not deny — a request that never bound its tenant must be refused, not counted');
  }
  if (isSet(env['TENANT_WALL_EXPAND_ATTESTED'])) {
    refuse('TENANT_WALL_EXPAND_ATTESTED is set — the wall-less EXPAND declaration never rides along with the contract posture; remove it');
  }
  // (Read after the secret-file loader, which turns POSTGRES_PASSWORD_FILE into POSTGRES_PASSWORD.)
  if (isSet(env['POSTGRES_PASSWORD'])) {
    refuse('the database owner\'s password reached this process (POSTGRES_PASSWORD) — the API and the worker run on the least-privilege logins only (deploy/docker-compose.wall.yml)');
  }
  const request = loginOf(env['DATABASE_URL']);
  const system = loginOf(env['SYSTEM_DATABASE_URL']);
  if (!request) refuse('DATABASE_URL is missing or not a postgresql:// URL — the request login comes from DATABASE_URL_FILE');
  if (!system) refuse('SYSTEM_DATABASE_URL is missing or not a postgresql:// URL — the system login comes from SYSTEM_DATABASE_URL_FILE');
  if (request!.user !== WALL_REQUEST_LOGIN) {
    refuse(`DATABASE_URL does not sign in as ${WALL_REQUEST_LOGIN} — the request pool never runs on the owner, postgres or the system login`);
  }
  if (system!.user !== WALL_SYSTEM_LOGIN) {
    refuse(`SYSTEM_DATABASE_URL does not sign in as ${WALL_SYSTEM_LOGIN} — system work never runs on the owner, postgres or the request login`);
  }
  if (request!.target !== system!.target) {
    refuse('DATABASE_URL and SYSTEM_DATABASE_URL name different databases — system work would read the wrong rows');
  }
}

/** [DS214 D1 · B1/S4 · CANCEL-WINDOW 22 Oct 2026] The shortest LIFECYCLE_V2 order hold production boots with:
 *  the settled five-minute hold (Total Audit build order; ORDER_HOLD_MINUTES default 5). Its own number since the
 *  owner cut the free-cancel window AFTER acceptance to one minute (FREE_CANCEL_WINDOW_MIN): the hold BEFORE
 *  acceptance did not change, so neither does this boot floor. */
export const ORDER_HOLD_FLOOR_MIN = 5;

export function assertSafeBootConfig(env: Record<string, string | undefined> = process.env): void {
  // [R2 C2] Applies to loadtest builds, so it runs before the production gate.
  assertTestControlConfig(env);
  // MMG hosted checkout, in EVERY mode (staging runs development mode against
  // MMG UAT): MMG_CHECKOUT_ENABLED is exactly 0 or 1, and once on, the live
  // driver needs its whole configuration — keys parsed, the request proven to
  // fit the key. Production also refuses the sandbox and a UAT page.
  assertMmgCheckoutConfig(env);
  // [O-1] The Swift call bridge, in EVERY mode: CALL_RELAY=1 needs Swift's caller ID, the
  // public webhook address and the Twilio account, key and webhook token, or nothing starts.
  assertCallRelayConfig(env);
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
    assertNoLiveCardsOffProduction(env);
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
  // settled five-minute hold (ORDER_HOLD_FLOOR_MIN): a shorter hold puts an
  // order on the vendor board early, which is exactly the REPORT-036 defect
  // (order.service.ts holdWindowMs).
  // [CANCEL-WINDOW · owner 22 Oct 2026] This floor used to read
  // FREE_CANCEL_WINDOW_MIN, which was also five. The free-cancel window after
  // acceptance is now ONE minute; the hold before acceptance is a different
  // timer the owner did not change, so the floor keeps its own number and
  // this guard refuses exactly what it refused before (never relaxed silently).
  if (lifecycleV2 === '1' && env['ORDER_HOLD_MINUTES'] !== undefined) {
    const holdMinutes = Number(env['ORDER_HOLD_MINUTES']);
    if (!Number.isFinite(holdMinutes) || holdMinutes < ORDER_HOLD_FLOOR_MIN) {
      throw new Error(`FATAL: ORDER_HOLD_MINUTES must be a number of minutes no shorter than the settled ${ORDER_HOLD_FLOOR_MIN}-minute order hold when LIFECYCLE_V2=1 — an invalid value silently disables the order hold, and a shorter one shows orders to the vendor before the hold the app counts down has ended. Set ORDER_HOLD_MINUTES=${ORDER_HOLD_FLOOR_MIN} or unset it. Refusing to start.`);
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
  // Face matching stays OFF (owner ruling; GUARDRAILS §8): the biometric switch
  // cannot be turned on in production, whatever engine is configured.
  if (env['FEATURE_BIOMETRIC_FACE_MATCH'] === '1') {
    throw new Error('FATAL: FEATURE_BIOMETRIC_FACE_MATCH=1 is refused in production; identity checks are done by a person, with no automated face matching. Refusing to start.');
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
  // flag says. The flag is 1 or 0 (or unset = 0), never a guess.
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
  // [AX297 F5] Draining v2 after it was switched off is its own switch, held
  // to the same rules.
  const cardRailV2Drain = env['CARD_RAIL_V2_DRAIN'];
  if (cardRailV2Drain !== undefined && cardRailV2Drain !== '' && cardRailV2Drain !== '0' && cardRailV2Drain !== '1') {
    throw new Error('FATAL: CARD_RAIL_V2_DRAIN must be 1 or 0 in production. Refusing to start.');
  }
  // [PT-4] Production runs card rail v2 (or drains it) only on the real
  // provider, fully set up for LIVE cards: a non-test HTTPS API root (the
  // guide gives production its own address), its credentials from the
  // secrets store, the hosted payment page, and Swift's HTTPS public origin.
  // Anything less refuses to start rather than fail at a partner's first tap.
  if (cardRailV2 === '1' || cardRailV2Drain === '1') {
    const which = cardRailV2 === '1' ? 'CARD_RAIL_V2=1' : 'CARD_RAIL_V2_DRAIN=1';
    if (env['CARD_RAIL_PROVIDER'] !== 'powertranz') {
      throw new Error(`FATAL: ${which} in production needs CARD_RAIL_PROVIDER=powertranz (the only real card provider). Refusing to start.`);
    }
    try {
      powerTranzConfigFromEnv(env);
    } catch (err) {
      throw new Error(`FATAL: ${which} in production, but the card provider is not fully set up for live cards: ${(err as Error).message}. Refusing to start.`);
    }
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
  // [PROD-PATH] Owner ruling, 4 Oct 2026: production may instead run with MMG
  // fully OFF until the live merchant keys arrive — but only by the exact,
  // explicit MMG_DRIVER=disabled. Then nothing reaches MMG: the billing rail
  // defers instead of charging, the poller leaves every row as it is, and
  // every provider call refuses with MMG_DISABLED (providers/mmg). The hosted
  // checkout must be off with it (assertMmgCheckoutConfig, above, refuses it
  // on). Unset, sandbox or a near miss ('off', 'Disabled') is still refused.
  const mmgDriver = env['MMG_DRIVER'];
  if (mmgDriver !== 'live' && mmgDriver !== 'disabled') {
    throw new Error('FATAL: MMG_DRIVER must be live (or exactly disabled, MMG fully off) in production; sandbox/unset can settle synthetic subscription payments. Refusing to start.');
  }
  if (mmgDriver === 'live') {
    for (const name of ['MMG_API_KEY', 'MMG_MERCHANT_ID', 'MMG_PASSWORD', 'MMG_MKEY', 'MMG_MSECRET'] as const) {
      if (!env[name]) throw new Error(`FATAL: ${name} is required when MMG_DRIVER=live. Refusing to start.`);
    }
    // [S1 · SWITCHES 21 Oct, Option A] Live MMG here means the checkout page, its lookup and
    // reversals: none of them depends on the merchant reference round trip
    // (MMG_REFERENCE_ROUNDTRIP_VERIFIED). That flag only proves the PUSH rail, which production
    // refuses outright below, so it is no longer a condition of booting live.
    const mmgUrl = env['MMG_API_URL'];
    if (!mmgUrl || !/^https:\/\//i.test(mmgUrl) || /mmgtest|\buat\b|sandbox/i.test(mmgUrl)) {
      throw new Error('FATAL: production MMG requires an explicit non-UAT HTTPS MMG_API_URL. Refusing to start.');
    }
    // [22 Oct, COORD ruling] Production never pushes (refused below), so with MMG live the checkout
    // page is the only MMG way to pay: live MMG with the checkout off would leave no partner a way to
    // pay with MMG. The fee pause also holds then (fee-pause.ts); this refusal is the belt to that brace.
    if (env['MMG_CHECKOUT_ENABLED'] !== '1') {
      throw new Error('FATAL: MMG_DRIVER=live in production needs MMG_CHECKOUT_ENABLED=1: production never sends MMG charge requests, so the MMG checkout page is the only MMG way to pay. Switch both on together, or set MMG_DRIVER=disabled (every weekly fee is then paused). Refusing to start.');
    }
  }

  // [S1 · SWITCHES 21 Oct, Option A] The MMG push rail (Swift sending a charge request to a
  // partner's phone) is refused in production for now: the weekly fee is paid on the MMG checkout
  // page only (GUARDRAILS §1), and the push rail's reference round trip is unproven. Only unset,
  // empty or 0 boots; any other value of the switch is refused, whatever the driver.
  const pushSwitch = env['MMG_PUSH_RAIL_ON'];
  if (pushSwitch !== undefined && pushSwitch !== '' && pushSwitch !== '0') {
    throw new Error('FATAL: MMG_PUSH_RAIL_ON must be unset or 0 in production: the MMG push rail (automatic charge requests to a partner\'s phone) is not allowed; the weekly fee is paid on the MMG checkout page. Refusing to start.');
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

  // [PROD-PATH] An unacknowledged SOS escalates to the on-call tree by SMS
  // (modules/safety/ops-alert.ts). onCallPhones() keeps only E.164 entries
  // and drops the rest without a word, so an empty or mistyped list means an
  // escalation that pages nobody while every metric reads healthy. Refuse it.
  // The refusal names the setting, never a number in it.
  const onCall = (env['OPS_ONCALL_PHONES'] ?? '').split(',').map((p) => p.trim());
  const onCallListed = onCall.filter((p) => p !== '');
  if (onCallListed.length === 0) {
    throw new Error('FATAL: OPS_ONCALL_PHONES is empty in production — an unacknowledged SOS escalates to the on-call phones by SMS, and with none it pages nobody. Set one or more E.164 numbers, comma-separated (+592…). Refusing to start.');
  }
  if (onCallListed.length !== onCall.length || onCallListed.some((p) => !/^\+[1-9]\d{6,14}$/.test(p))) {
    throw new Error('FATAL: OPS_ONCALL_PHONES has an entry that is not an E.164 number (+ then 7–15 digits, comma-separated) — it would be dropped silently and never paged. Refusing to start.');
  }

  // [PROD-PATH · owner ruling 8 Oct] Production launches with admin top-ups ON
  // HOLD: admin.routes.ts refuses every manual credit of fee paid ahead exactly
  // when BILLING_TOPUP_HOLD is '1'. pilot-up.sh refuses a production deploy
  // without it; this holds it however the API is started.
  if (env['BILLING_TOPUP_HOLD'] !== '1') {
    throw new Error('FATAL: BILLING_TOPUP_HOLD must be exactly 1 in production — admin top-ups stay on hold (owner ruling, 8 Oct). Set BILLING_TOPUP_HOLD=1 in deploy/.env. Refusing to start.');
  }
  // Partners pay the weekly fee only on the MMG checkout page, never through an
  // agent or a Swift Number. The agent-cash webhook answers 503 while its
  // secret is unset; production never sets it. Named, never echoed.
  if ((env['AGENT_CASH_WEBHOOK_SECRET'] ?? '') !== '') {
    throw new Error('FATAL: AGENT_CASH_WEBHOOK_SECRET is set in production — partners pay the weekly fee only on the MMG checkout page, never through an agent or a Swift Number. Remove it (and its _FILE line). Refusing to start.');
  }
  assertProductionLaunchLocks(env);
  // [TA-S0-003 · R3] The contract posture runs on the two least-privilege logins only.
  assertWallLoginConfig(env);

  // [PROD-PATH] Email: receipts, expiry warnings, data-export links. The dev
  // sender refuses only at the FIRST send in production (channels.ts), so a
  // missing sender stayed invisible until a customer was owed an email. The
  // launch sender is SMTP; its whole configuration is checked here, by the
  // same reader the sender uses (it names missing settings, never values).
  const emailProvider = env['EMAIL_PROVIDER'];
  if (emailProvider !== 'smtp') {
    throw new Error('FATAL: EMAIL_PROVIDER must be smtp in production — unset or dev sends no receipt, notice or export link. Set EMAIL_PROVIDER=smtp with SMTP_HOST, SMTP_PORT, SMTP_USER, EMAIL_FROM and the SMTP_PASS secret. Refusing to start.');
  }
  try {
    smtpConfigFromEnv(env);
  } catch (error) {
    throw new Error(`FATAL: ${error instanceof Error ? error.message : String(error)}. Refusing to start.`);
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
  // [row 331 · CONFIG-GUARDS] The identity-signal HMAC key (phone, document
  // number, plate, device hashes): refused at boot, not at the first identity
  // capture. The same contract as the hasher; the value is never echoed.
  identitySalt(env);
  assertPlacesConfig(env);
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
