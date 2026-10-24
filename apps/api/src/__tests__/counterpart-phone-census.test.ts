/**
 * [O-1 · owner 22 Oct 2026] The static half of the counterpart-phone census.
 *
 * counterpart-phone-gate.test.ts proves the live routes on a real database.
 * This file locks the SOURCE: every place the API selects a person's phone is
 * classified below, by file, with a count and a reason. A new `phone: true`
 * (or `withPhone: true`) anywhere in the API fails here until someone decides
 * whether it is the person's own number, a server-internal use, the ops desk,
 * or a counterpart surface that must go through modules/calls/counterpart-phone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CALL_BRIDGE_CLIENT_HEADER,
  COUNTERPART_PHONES_TO_OLD_APPS_ENV,
  counterpartPhone,
  counterpartPhonesAllowed,
  withCounterpartPhones,
} from '../modules/calls/counterpart-phone';
import { DARK_FEATURES } from '../modules/ops/dark-features';
import { testPhone } from './helpers/fixture-ids';

const SRC = join(__dirname, '..');
const BRIDGE_ON = { 'x-swift-call-bridge': '1' };
/** Fictional numbers from the run-wide +59206 block (never stored here). */
const [P1, P2, P3, P4] = [testPhone(), testPhone(), testPhone(), testPhone()];
const PHONE_SELECT = /phone: true|withPhone: true/g;

const GATED = 'counterpart surface: goes through modules/calls/counterpart-phone (old builds keep it until retired)';
const OWN = "the person's own number (own profile, own team, own statement)";
const INTERNAL = 'server-internal (OTP/SMS delivery, erasure, fraud keys, checks); never in a party response';
const OPS = 'ops/admin desk (support must reach both sides)';

/** Every source file that selects a phone, and why. Anything not listed must select none. */
const LEDGER: Record<string, { count: number; why: string }> = {
  'modules/rides/rides.routes.ts': { count: 1, why: GATED },
  'modules/courier/courier.routes.ts': { count: 1, why: GATED },
  'modules/driver/driver.routes.ts': { count: 3, why: `2 ${OWN}; 1 ${GATED}` },
  'modules/rider/rider.routes.ts': { count: 3, why: `2 ${OWN}; 1 ${GATED} (the store's account line is no longer selected)` },
  'modules/user/customer.routes.ts': { count: 4, why: `2 ${OWN}; 1 receipt input (the receipt prints only the seller's PUBLISHED phone); 1 ${GATED}` },
  'modules/vendor/vendor.routes.ts': { count: 6, why: `3 ${GATED}; 2 ${OWN} (store team); 1 ${INTERNAL} (reserved-name check)` },
  'utils/counterparty.ts': { count: 1, why: 'the opt-in itself (riderCounterpartySelect withPhone)' },
  'modules/admin/admin.routes.ts': { count: 24, why: OPS },
  'modules/admin/solo-approval.ts': { count: 1, why: INTERNAL },
  'modules/ads/advertiser.service.ts': { count: 1, why: `${OWN} (advertiser team: accepted members only)` },
  'modules/auth/auth.routes.ts': { count: 2, why: OWN },
  'modules/auth/step-up.ts': { count: 2, why: INTERNAL },
  'modules/billing/billing.service.ts': { count: 1, why: INTERNAL },
  'modules/billing/mmg-checkout-support.ts': { count: 3, why: OPS },
  'modules/cash/cash-rules.service.ts': { count: 2, why: INTERNAL },
  'modules/custody/custody-recovery.ts': { count: 1, why: OPS },
  'modules/integrity/backfill.ts': { count: 2, why: INTERNAL },
  'modules/integrity/money-surface.ts': { count: 1, why: INTERNAL },
  'modules/notification/marketing-message.ts': { count: 1, why: INTERNAL },
  'modules/notification/notification.service.ts': { count: 3, why: INTERNAL },
  'modules/order/statement.ts': { count: 1, why: OWN },
  'modules/partner/partner.routes.ts': { count: 1, why: OWN },
  'modules/rating/vendor-review-visibility.ts': { count: 1, why: INTERNAL },
  'modules/review/content-pack.ts': { count: 1, why: INTERNAL },
  'modules/safety/deletion-hold.ts': { count: 2, why: INTERNAL },
  'modules/safety/emergency-contact.service.ts': { count: 2, why: OWN },
  'modules/safety/guardian-delivery.ts': { count: 1, why: `${INTERNAL} (SMS fallback to the passenger's own verified phone)` },
  'modules/safety/sos-escalation.ts': { count: 1, why: INTERNAL },
  'modules/support/support.service.ts': { count: 1, why: OPS },
  'modules/user/account-erasure-retry.ts': { count: 1, why: INTERNAL },
  'modules/user/account.service.ts': { count: 1, why: INTERNAL },
  'modules/user/inactivity.ts': { count: 1, why: INTERNAL },
  'modules/user/mover-object-erasure.ts': { count: 1, why: INTERNAL },
  'modules/user/profile-update.ts': { count: 1, why: OWN },
  'modules/user/upload-erasure.ts': { count: 2, why: INTERNAL },
  'modules/verification/compliance-audit.service.ts': { count: 2, why: OPS },
  'modules/verification/duplicate-holders.ts': { count: 1, why: INTERNAL },
  'modules/verification/storefront-disclosure.ts': { count: 1, why: INTERNAL },
  'modules/verification/verification.service.ts': { count: 1, why: INTERNAL },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('[O-1] every phone select in the API is classified', () => {
  const counts = new Map<string, number>();
  for (const root of ['modules', 'utils', 'lib', 'jobs', 'plugins']) {
    for (const f of sourceFiles(join(SRC, root))) {
      const n = (readFileSync(f, 'utf8').match(PHONE_SELECT) ?? []).length;
      if (n) counts.set(relative(SRC, f), n);
    }
  }
  it('no unclassified file selects a phone, and every count matches its ledger line', () => {
    const drift: string[] = [];
    for (const [file, n] of counts) {
      const row = LEDGER[file];
      if (!row) drift.push(`${file}: ${n} phone select(s), not classified`);
      else if (row.count !== n) drift.push(`${file}: ${n} phone select(s), ledger says ${row.count} (${row.why})`);
    }
    for (const [file, row] of Object.entries(LEDGER)) {
      if (!counts.has(file)) drift.push(`${file}: ledger says ${row.count}, the file selects none (remove the line)`);
    }
    expect(drift).toEqual([]);
  });

  it('every file with a counterpart surface uses the one gate', () => {
    for (const [file, row] of Object.entries(LEDGER)) {
      if (!row.why.includes(GATED)) continue;
      expect(read(file), `${file} has a counterpart surface but does not use counterpart-phone`).toMatch(/from '\.\.\/calls\/counterpart-phone'/);
    }
  });
});

describe('[O-1] fields no build reads are not sent at all', () => {
  it("the taxi accept event tells the passenger's room nothing about the driver's phone", () => {
    const src = read('modules/driver/driver.routes.ts');
    const start = src.indexOf("status: 'DRIVER_ASSIGNED',\n        driver: {");
    expect(start, 'the DRIVER_ASSIGNED emit moved: re-point this census').toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('});', start));
    expect(block).not.toMatch(/\bphone\b/);
  });

  it('the cash-settlement ledger carries neither party\'s phone', () => {
    const src = read('modules/cash/delivery-cash-settlement.service.ts');
    const include = src.slice(src.indexOf('const SETTLEMENT_INCLUDE'), src.indexOf('} as const;', src.indexOf('const SETTLEMENT_INCLUDE')));
    const wire = src.slice(src.indexOf('function toWire'), src.indexOf('\n}\n', src.indexOf('function toWire')));
    expect(include).not.toMatch(/\bphone\b/);
    expect(wire).not.toMatch(/\bphone\b/);
  });
});

describe('[O-1] the gate itself', () => {
  const req = (headers: Record<string, string | undefined> = {}) => ({ headers });

  it('the wire names are pinned', () => {
    expect(CALL_BRIDGE_CLIENT_HEADER).toBe('x-swift-call-bridge');
    expect(COUNTERPART_PHONES_TO_OLD_APPS_ENV).toBe('COUNTERPART_PHONES_TO_OLD_APPS');
  });

  it('an old build (no header) is sent the number while the switch is on (default)', () => {
    expect(counterpartPhonesAllowed(req(), {})).toBe(true);
    expect(counterpartPhonesAllowed(req(), { COUNTERPART_PHONES_TO_OLD_APPS: '1' })).toBe(true);
  });

  it('any value of the header means bridge-aware: never sent one', () => {
    for (const v of ['1', '0', '', 'yes']) expect(counterpartPhonesAllowed(req({ 'x-swift-call-bridge': v }), {})).toBe(false);
  });

  it("retired ('0'): no client is sent one", () => {
    expect(counterpartPhonesAllowed(req(), { COUNTERPART_PHONES_TO_OLD_APPS: '0' })).toBe(false);
  });

  it('withCounterpartPhones nulls every party phone in place and keeps the keys', () => {
    const o = {
      customer: { firstName: 'A', phone: P1 },
      rider: { phone: P2, user: { firstName: 'B', phone: P3 } },
      driver: { user: { phone: P4 } },
      courierRecipientPhone: P2,
      orderNumber: 'X',
    };
    const out = withCounterpartPhones(req(BRIDGE_ON), o);
    expect(out).toBe(o);
    expect(JSON.stringify(out)).not.toMatch(/\+5920/);
    expect(out.customer.phone).toBeNull();
    expect(out.rider.user.phone).toBeNull();
    expect('phone' in out.driver.user).toBe(true);
    expect(out.courierRecipientPhone).toBeNull();
    const legacy = { customer: { phone: P1 } };
    expect(withCounterpartPhones(req(), legacy).customer.phone).toBe(P1);
  });

  it('counterpartPhone answers null to a bridge-aware client', () => {
    expect(counterpartPhone(req(BRIDGE_ON), P1)).toBeNull();
    expect(counterpartPhone(req(), P1)).toBe(P1);
    expect(counterpartPhone(req(), undefined)).toBeNull();
  });

  it('the retirement switch is in the dark-features register (off at 0, blanks ignored)', () => {
    const entry = DARK_FEATURES.find((f) => f.setting === 'COUNTERPART_PHONES_TO_OLD_APPS');
    expect(entry?.source).toBe('env');
    expect(entry?.enabledWhenPattern?.test('0')).toBe(false);
    expect(entry?.enabledWhenPattern?.test('')).toBe(true);
    expect(entry?.enabledWhenPattern?.test('1')).toBe(true);
    expect(counterpartPhonesAllowed(req(), { [COUNTERPART_PHONES_TO_OLD_APPS_ENV]: ' 0 ' })).toBe(false);
  });
});

