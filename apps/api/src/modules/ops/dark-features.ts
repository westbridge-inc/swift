/**
 * The capabilities that fail QUIETLY.
 *
 * The boot guards in `boot-config.ts` cover the loud half: a missing KEK, a dev
 * SMS provider, an unset signing secret — the server refuses to start and says
 * why. `deploy/preflight.ts` runs those same guards against a candidate .env,
 * so nothing in that class can reach production unnoticed.
 *
 * This is the other half, and it has cost more real time than the loud one.
 *
 * A capability that is configured OFF does not fail. It renders a fallback,
 * returns an empty list, or 404s a file nobody looks at — and every layer above
 * behaves exactly as designed. Two examples, both found by measurement rather
 * than by anything failing:
 *
 *   • `CATEGORY_DISCOVERY_ENABLED` defaults to false and NOTHING had ever set
 *     it — not the spine, not a migration, not a script. The rail was dark in
 *     every database that has ever existed, returning `{enabled:false,
 *     categories:[]}` while the client rendered the pre-rail Home
 *     pixel-identically, exactly as its kill-switch was designed to behave.
 *     Nothing looked broken because the fallback is deliberately invisible.
 *
 *   • `APPLE_TEAM_ID` / `ANDROID_CERT_SHA256` gate the two association files
 *     that make a printed QR code open the APP instead of a browser tab. Both
 *     routes 404 without them — correctly, since a fake association is worse
 *     than none — and the whole QR growth engine silently degrades to opening
 *     Safari. Neither variable appeared in any .env.example or deploy note, so
 *     there was no document that would have told anyone to set them.
 *
 * The rule this file encodes: a capability may ship switched off, but it may
 * not ship switched off SILENTLY. Every entry names the env or config that
 * turns it on, and states what a real person sees while it is off.
 */

export type DarkFeatureImpact = 'growth' | 'product' | 'ops' | 'safety' | 'money';

export interface DarkFeature {
  key: string;
  /** The env var or PlatformConfig key that turns it on. */
  setting: string;
  source: 'env' | 'config';
  title: string;
  /** What a real person experiences while this is off. Never "feature disabled". */
  whileOff: string;
  impact: DarkFeatureImpact;
  /**
   * The code already carries a working default, so this is ON without any env.
   *
   * A register that reports a capability OFF when the code defaults it ON is
   * the same lie it exists to prevent, pointed the other way — it sends an
   * operator to fix something that is not broken, and the next warning gets
   * ignored. The env var still overrides; this only records that its absence
   * is not an absence of the feature.
   */
  defaultedInCode?: string;
  /**
   * For switches whose ON state is ONE exact env VALUE rather than mere
   * presence: the entry is on only when the env var equals this string.
   * Absence-based reading is right for fingerprints and sender lists, wrong
   * for a flag like LIFECYCLE_V2 where '0' is a real, deliberate OFF.
   */
  enabledWhen?: string;
  /**
   * [row 331 · CONFIG-GUARDS] A KILL SWITCH: the capability is on by default and
   * OFF while the env var equals this exact value (every *_KILL reads '1'). A
   * rollback switch left on after the incident it was flipped for starts
   * cleanly and says nothing, so it belongs here like any other silent OFF.
   */
  offWhen?: string;
  /**
   * [SWITCHES fact-check] For switches the code reads TRIMMED, or as a number: the entry is on only
   * when the trimmed env value matches this pattern (TAXI_MAX_STOPS above 0, TAXI_WAITING_CHARGE and
   * WEB_TAXI_BOOKING at '1' with blanks ignored). Each is pinned against the code's own reader.
   */
  enabledWhenPattern?: RegExp;
}

export const DARK_FEATURES: DarkFeature[] = [
  {
    key: 'ios_universal_links',
    setting: 'APPLE_TEAM_ID',
    source: 'env',
    title: 'iOS universal links',
    whileOff:
      'A printed QR code or a shared storefront link opens Safari instead of the app, even on a phone that has Swift installed, and /.well-known/apple-app-site-association returns 404.',
    // Swift's own Team ID is now the default in the AASA route, so this is on
    // everywhere without configuration. It is kept in the register because the
    // env var still overrides it — a fork or a second Apple account needs to
    // know this switch exists — and because the outage it describes is exactly
    // what happened while the route had no default.
    defaultedInCode: 'N3JV22LC84 in apps/web … apple-app-site-association/route.ts',
    impact: 'growth',
  },
  {
    key: 'android_app_links',
    setting: 'ANDROID_CERT_SHA256',
    source: 'env',
    title: 'Android app links',
    whileOff:
      'The same link opens Chrome instead of the app. /.well-known/assetlinks.json returns 404. Needs the Play app-signing certificate SHA-256 (Play Console, App integrity), then the upload certificate SHA-256, colon-separated and comma-joined, in deploy/.env; the website container receives it from deploy/docker-compose.yml.',
    impact: 'growth',
  },
  {
    key: 'category_discovery',
    setting: 'CATEGORY_DISCOVERY_ENABLED',
    source: 'config',
    title: 'The category rail',
    whileOff:
      'Home and Market render with no category chips at all — the pre-rail layout, pixel-identical, so it reads as a design choice rather than a switch that is off.',
    impact: 'product',
  },
  {
    key: 'guardian_contact_sms',
    setting: 'GUARDIAN_AUTONOTIFY_CONTACTS',
    source: 'env',
    title: 'Guardian check-in contact SMS',
    whileOff:
      'An alert raised by an UNANSWERED check-in pages ops but does not text the emergency contacts. This is the deliberate default (§5.3 L4 — the server guessing, not a person asking) and is recorded as a receipt, not a silence.',
    impact: 'ops',
  },
  {
    key: 'order_hold',
    setting: 'LIFECYCLE_V2',
    source: 'env',
    enabledWhen: '1',
    title: 'The order hold (free-cancel window)',
    whileOff:
      'An order shows up on the vendor board the instant it is placed, so the store can accept it within seconds of checkout while the app still promises the customer a five-minute free-cancel window: the hidden grace period never exists.',
    impact: 'product',
  },
  {
    // [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] Deliberately OFF: a store's MMG NUMBER replaced its pay
    // link. Listed so the switch is never a silent mystery.
    key: 'store_mmg_pay_link',
    setting: 'STORE_MMG_PAY_LINK',
    source: 'env',
    enabledWhen: '1',
    title: "The store's MMG pay link (replaced by the store's MMG number)",
    whileOff:
      "A customer who chooses MMG pays the store's MMG NUMBER directly, shown on the order once the store accepts; no surface offers or opens a store pay link, a store cannot set a new one, and phones on builds 9-11 (which know only the link) see cash only at checkout. Stored links stay in the database unused. This is the owner's launch decision (17 Oct 2026), not a fault.",
    impact: 'money',
  },
  {
    // [STORE-VAT · owner O-5, 24 Oct 2026] Built for launch, OFF until switched on deliberately. Even ON, nothing a
    // customer sees changes for a store until a PERSON approves its GRA VAT certificate.
    key: 'store_vat',
    setting: 'STORE_VAT',
    source: 'env',
    enabledWhen: '1',
    title: "A VAT-registered store's VAT (14%, inside its prices, shown on its receipts)",
    whileOff:
      "No store can say it is VAT-registered, send its GRA VAT certificate, or be approved for VAT; every store's prices, carts, checkouts and receipts show no VAT, exactly as before. Orders already placed with VAT keep the VAT they froze on their receipts. Swift's own fees stay \"Not a VAT invoice\" either way.",
    impact: 'money',
  },
  {
    key: 'mover_push_required',
    setting: 'MOVER_PUSH_REQUIRED',
    source: 'env',
    enabledWhen: 'true',
    title: 'Push before going online',
    whileOff:
      'A rider or driver whose phone has no push registration (notifications never granted, a new or reinstalled phone, an account ops created) still goes online, and learns of an offer or a cancellation only while the app is open. This is the deliberate launch posture: build 9 cannot ask for notifications or open Settings, so requiring push is an owner decision once a build that can is live in both stores.',
    impact: 'ops',
  },
  {
    // [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] Deliberately OFF: the owner removed the
    // driver's in-app MMG pay link. Listed so the switch is never a silent mystery.
    key: 'driver_mmg_pay_link',
    setting: 'DRIVER_MMG_PAY_LINK',
    source: 'env',
    enabledWhen: '1',
    title: "The taxi driver's MMG pay link",
    whileOff:
      "A passenger pays the driver directly at drop-off, in cash or by MMG, with no in-app pay link: the trip-end screen shows no 'Pay with MMG' button, the driver's Account screen shows no MMG pay link card, and a new link is refused. Stored links stay in the database unused. This is the owner's launch decision (17 Oct 2026), not a fault.",
    impact: 'money',
  },
  {
    // [O-1 · owner 24 Oct 2026] The Swift call bridge. Ships OFF; on only after a real test call
    // rings and Press 1 connects on Digicel AND GTT.
    key: 'call_relay',
    setting: 'CALL_RELAY',
    source: 'env',
    // On only at '1' with blanks ignored (modules/calls/call-relay-switch.ts reads it so).
    enabledWhenPattern: /^1$/,
    title: 'Calls through Swift (the call bridge)',
    whileOff:
      "Calls are not routed through Swift. Every app, old store builds and new, keeps the other party's number on a live order and dials it directly, exactly as before, and in-app chat works as always. Kept OFF until a real Swift test call rings and Press 1 connects on a Digicel phone and a GTT phone (owner, 24 Oct 2026).",
    impact: 'product',
  },
  {
    // [O-1 · owner 22 Oct 2026] ON until store builds 9-12 / vc7-vc8 are retired (launch checklist).
    key: 'counterpart_phones_to_old_apps',
    setting: 'COUNTERPART_PHONES_TO_OLD_APPS',
    source: 'env',
    // On unless the trimmed value is exactly '0' (modules/calls/counterpart-phone.ts reads it so).
    enabledWhenPattern: /^(?!0$)/,
    title: "Old app builds still get the other party's number",
    whileOff:
      "Takes effect only while CALL_RELAY is on; while the call bridge is off every app keeps the other party's number whatever this says. With the bridge on: no app is sent another person's personal phone number, so phones on store builds 9-12 (iPhone) and vc7-vc8 (Android) show no Call button for the rider, driver, customer or store on a live order and use chat or support instead. Builds that know the Swift call bridge are not affected (with the bridge on they are never sent a number). Set to 0 only when those builds are retired.",
    impact: 'product',
  },
  {
    key: 'web_taxi_booking',
    setting: 'WEB_TAXI_BOOKING',
    source: 'env',
    // The code ignores surrounding blanks (web-taxi-booking.ts): ' 1' is ON there, so it is ON here.
    enabledWhenPattern: /^1$/,
    title: 'Taxi booking on the website',
    whileOff:
      "The website's Taxi page shows real fare estimates and says 'Book a taxi in the Swift app'; a ride request from a browser session is refused (TAXI_MOBILE_APP_REQUIRED) and the ride page points to the app for the safety PIN and SOS. Phone booking is unchanged. Kept OFF until web booking passes the app's safety bar and a staging run, then the owner decides (16 Oct 2026).",
    impact: 'safety',
  },
  {
    key: 'instant_booking',
    setting: 'INSTANT_BOOKING',
    source: 'env',
    // The code ignores surrounding blanks (booking/instant-booking.ts): ' 1' is ON there, so it is ON here.
    enabledWhenPattern: /^1$/,
    title: 'Instant appointment booking',
    whileOff:
      "Booking an appointment is a request, as before: the customer's time is taken only when the business accepts, so two customers can wait on the same free time and the business's accept decides (the other is told the time was taken). No listing can be set to confirm bookings automatically, and a booking keeps the one-minute free-cancel window. On: the time is taken when the customer books; a cash booking of a listing set to confirm automatically is confirmed in the same moment (MMG bookings still wait for the business); a confirmed booking cancels free until two hours before it starts. Kept OFF until ALL of these have landed: (1) the hair and beauty shop-certificate gate (owner A2: a person-checked yearly certificate before hair/beauty services can be booked; no such document type exists yet); (2) the phone app's success popup branches on the server's order status (every build today shows 'Booking requested' / confirmed when the business accepts, which is wrong for an instant booking), or the owner rules on it; (3) the Terms and refunds wording for instant confirmation and the two-hour cancel window (LEGAL_VERSION bump); then CI, a real-Postgres race run and a staging run, then the owner decides (28 Oct 2026, B4, A2, A3, A4, B1, C2).",
    impact: 'product',
  },
  // ── [row 331 · CONFIG-GUARDS] the kill switches. Each is unset (or 0) in
  // normal running; set to 1 it switches its capability off. The census in
  // dark-features.test.ts fails on any *_KILL the API reads that is not here.
  {
    key: 'sos_escalation_worker',
    setting: 'SOS_ESCALATION_WORKER_KILL',
    source: 'env',
    offWhen: '1',
    title: 'SOS escalation retries',
    whileOff:
      'A new SOS still texts its emergency contacts and pages ops once, inline, as it is raised. Anything that first try missed (a contact text, the ops page, the war-room emit, the evidence bundle) is never retried or backfilled by the 10-second tick; only the failed-delivery pager and the watchdog keep paging ops about it.',
    impact: 'safety',
  },
  {
    key: 'ops_alert_escalation',
    setting: 'OPS_ALERT_ESCALATION_KILL',
    source: 'env',
    offWhen: '1',
    title: 'Ops alert escalation',
    whileOff:
      'An ops alert nobody acknowledges by its deadline is not pushed again, the on-call phones are not texted and the platform is not paged. It stays unacknowledged in the alert list until someone happens to open it.',
    impact: 'safety',
  },
  {
    key: 'guardian_checkin_delivery',
    setting: 'GUARDIAN_CHECKIN_DELIVERY_KILL',
    source: 'env',
    offWhen: '1',
    title: 'Trip Guardian check-in retries',
    whileOff:
      'A Trip Guardian check-in that did not reach the rider on its first, inline try is never retried. Its deadline holds and ops are paged instead, so an unanswered check-in on a lost connection waits for a person.',
    impact: 'safety',
  },
  {
    key: 'guardian_driver_deescalation',
    setting: 'GUARDIAN_DRIVER_DEESCALATION_KILL',
    source: 'env',
    offWhen: '1',
    title: 'Driver confirmation of an unanswered hard check-in',
    whileOff:
      'When a passenger does not answer a hard check-in, the driver saying all is well no longer stands it down: the automatic SOS goes ahead every time.',
    impact: 'safety',
  },
  {
    key: 'not_my_driver_authority',
    setting: 'NOT_MY_DRIVER_AUTHORITY_KILL',
    source: 'env',
    offWhen: '1',
    title: 'Not-my-driver automatic response',
    whileOff:
      'A passenger who reports that the car is not their driver gets a case and an ops page, but the ride is not released, the driver is not locked and no other car is sent until a person handles it by hand.',
    impact: 'safety',
  },
  {
    key: 'trip_share_public_lookup',
    setting: 'TRIP_SHARE_PUBLIC_LOOKUP_KILL',
    source: 'env',
    offWhen: '1',
    title: 'Shared trip links',
    whileOff:
      'Every trip link a rider shares with family or friends opens to nothing, as if it had expired, even while the ride is under way.',
    impact: 'safety',
  },
  {
    key: 'card_charges',
    setting: 'CARD_RAIL_KILL',
    source: 'env',
    offWhen: '1',
    title: 'New card charges',
    whileOff:
      'No new card charge is made, so a customer cannot pay by card and pays by MMG or cash; charges the processor already made are still reconciled. This is the launch posture production requires (owner ruling, 13 Oct) until an attorney signs off, so in production it is listed on purpose.',
    impact: 'money',
  },
  {
    key: 'fx_rate_activation',
    setting: 'FX_RATE_ACTIVATION_KILL',
    source: 'env',
    offWhen: '1',
    title: 'New exchange rates',
    whileOff:
      'An admin who sets a new exchange rate is refused (503), and the rate already in force keeps pricing every bill however old it gets.',
    impact: 'money',
  },
  {
    key: 'settlement_publication',
    setting: 'SETTLEMENT_PUBLISH_KILL',
    source: 'env',
    offWhen: '1',
    title: 'Settlement file publication',
    whileOff:
      'An imported settlement file is staged and checked, but none of its rows moves money until the hold is released.',
    impact: 'money',
  },
  {
    key: 'fare_zone_table',
    setting: 'FARE_ZONE_TABLE_KILL',
    source: 'env',
    offWhen: '1',
    title: 'The zone-to-zone fare table',
    whileOff:
      'Every taxi quote ignores the zone-to-zone fare table and prices by the country distance formula, so a fixed zone fare an operator set never reaches a rider.',
    impact: 'money',
  },
  {
    key: 'ad_checkout',
    setting: 'AD_CHECKOUT_KILL',
    source: 'env',
    offWhen: '1',
    title: 'Ad checkout',
    whileOff:
      'An advertiser who tries to pay for a campaign is told checkout is unavailable (503). Ads are off at launch, so this matters once ads are switched on.',
    impact: 'money',
  },
  {
    key: 'ad_refund_execution',
    setting: 'AD_REFUND_EXECUTION_KILL',
    source: 'env',
    offWhen: '1',
    title: 'Ad refunds',
    whileOff:
      'An advertiser owed a refund gets nothing back: the refund is recorded as owed, but bookings, inventory, the credit balance and the invoice stay as they were until it is released.',
    impact: 'money',
  },
  // ── [SWITCHES fact-check, 21 Oct] launch switches the code reads that no register named.
  {
    key: 'car_deliveries',
    setting: 'CAR_DELIVERIES',
    source: 'env',
    enabledWhen: '1',
    title: 'Deliveries by taxi cars (H-plate cars, wagons, buses)',
    whileOff:
      "Taxi cars carry passengers only (owner ruling, 15 Oct 2026, until counsel confirms the hire-car licence covers goods): a driver sees no store delivery or parcel offers, cannot grab or claim one, and every store delivery and parcel goes to riders. Passenger rides are unchanged.",
    impact: 'product',
  },
  {
    key: 'taxi_multi_stop',
    setting: 'TAXI_MAX_STOPS',
    source: 'env',
    enabledWhenPattern: /^\d*[1-9]\d*$/,
    title: 'Stops on a taxi ride (TAXI_MAX_STOPS, 1 to 3)',
    whileOff:
      "A passenger cannot add a stop to a taxi ride: the app offers none, and a ride sent with stops is refused (MULTI_STOP_UNAVAILABLE, 'Stops are not available yet'). A ride without stops is exactly as before.",
    impact: 'product',
  },
  {
    key: 'taxi_waiting_charge',
    setting: 'TAXI_WAITING_CHARGE',
    source: 'env',
    enabledWhenPattern: /^1$/,
    title: 'Taxi waiting charge',
    whileOff:
      'A taxi driver who waits for a late passenger is paid nothing for the wait, and a passenger is never shown or charged waiting terms: no estimate shows them and no ride booked while it is off is ever charged for waiting.',
    impact: 'money',
  },
  {
    key: 'ads',
    setting: 'ADS_ENABLED',
    source: 'env',
    enabledWhen: '1',
    title: 'Advertising (advertiser accounts, campaigns, sponsored placements)',
    whileOff:
      'Advertising is closed: no sponsored placement is shown to anyone, and the advertiser routes refuse every request. This is the launch lock (owner ruling, 13 Oct 2026): production refuses to start with it on until an attorney signs off.',
    impact: 'growth',
  },
  {
    key: 'owner_rls_bind',
    setting: 'OWNER_RLS_BIND',
    source: 'env',
    enabledWhen: '1',
    title: 'The person wall in the database (saved addresses)',
    whileOff:
      "A person notices nothing: their saved addresses are guarded by the application's own checks only, and the database's per-person row security is not bound to requests. Switching it on needs TENANT_RLS_BIND=1 and the walled login (lib/owner-rls.ts says which part is missing).",
    impact: 'safety',
  },
  {
    key: 'mmg_checkout',
    setting: 'MMG_CHECKOUT_ENABLED',
    source: 'env',
    enabledWhen: '1',
    title: 'Weekly fee on the MMG checkout page',
    whileOff:
      "A partner cannot pay the weekly fee on MMG's hosted checkout page: no 'Pay with MMG' fee button is offered, and the checkout routes stay inert. The fee is still owed; how it is collected meanwhile follows MMG_DRIVER.",
    impact: 'money',
  },
  {
    key: 'upload_malware_scan',
    setting: 'MALWARE_SCAN',
    source: 'env',
    enabledWhen: 'clamd',
    title: 'Malware scan of uploaded photos and documents (row 312)',
    whileOff:
      'Uploaded photos and documents are stored after the type, size and decode checks only: no virus scanner sees them, and a person notices nothing. Turn on (with CLAMD_HOST, and CLAMD_PORT if not 3310) once the ClamAV scanner runs on this host or the private network.',
    impact: 'safety',
  },
];

export interface DarkFeatureStatus extends DarkFeature {
  on: boolean;
}

/** Read the env half. Config-sourced entries need a database and are resolved
 *  by the caller that has one — `unknown` is never reported as `on`. */
export function darkFeatureStatus(
  env: Record<string, string | undefined> = process.env,
  configOn: Record<string, boolean> = {},
): DarkFeatureStatus[] {
  return DARK_FEATURES.map((f) => ({
    ...f,
    on: f.defaultedInCode
      ? true
      : f.source === 'env'
        ? f.offWhen !== undefined
          ? env[f.setting] !== f.offWhen
          : f.enabledWhenPattern !== undefined
            ? f.enabledWhenPattern.test((env[f.setting] ?? '').trim())
          : f.enabledWhen !== undefined
            ? env[f.setting] === f.enabledWhen
            : Boolean(env[f.setting]?.trim())
        : configOn[f.setting] === true,
  }));
}

export const darkFeaturesOff = (rows: DarkFeatureStatus[]): DarkFeatureStatus[] => rows.filter((r) => !r.on);

/**
 * [SWITCHES fact-check] A switch set ON without what it needs is worse than OFF and just as quiet until
 * a person meets it. The preflight prints these before a deploy.
 */
export function darkFeatureMisconfigurations(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  if (env['MALWARE_SCAN'] === 'clamd' && !env['CLAMD_HOST']?.trim()) {
    out.push('MALWARE_SCAN=clamd with no CLAMD_HOST: every upload is refused (UPLOAD_SCAN_UNAVAILABLE) until the scanner is named.');
  }
  return out;
}
