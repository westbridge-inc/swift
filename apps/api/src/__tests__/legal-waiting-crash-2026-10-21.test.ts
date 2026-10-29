import { describe, expect, it } from 'vitest';
import { LEGAL_VERSION, TERMS, PRIVACY } from '../modules/legal/legal.routes';
import { MATERIAL_CHANGES, NON_MATERIAL_CHANGES, materialVersion } from '../modules/legal/reaccept';
import { PROCESSOR_REGISTER } from '../modules/legal/processor-register';
import { TAXI_WAITING_DEFAULTS, waitingTermsText } from '../modules/rides/taxi-waiting';

// ---------------------------------------------------------------------------
// [Owner rulings 21 Oct 2026 · legal research E4 + B8 · R26] One version, one fresh tick.
//
// (1) The taxi waiting charge goes ON at launch. Research E4: lawful once shown before booking, with a live
//     timer, itemised on the receipt, and named in Terms section 4 (CAA ss.18, 33, 35). The Terms must say only
//     what taxi-waiting.ts does: the amount and block are the code's defaults, waiting is counted at the pickup
//     (from the driver's arrival, which the server gates on the driver's GPS fix or the passenger's own
//     confirmation) and at stops on the way, never at the final destination, only full blocks are charged, and
//     a ride that does not finish is never charged.
// (2) Phone crash reports go on (self-hosted GlitchTip, kept 90 days). Research B8: "Crash and error reports,
//     kept 90 days" is enough. The Privacy Policy says what a phone report carries (crashReporting.ts /
//     crash-scrub.ts) and that it goes to Swift's own server; the retention section says 90 days.
// Both are material: the version is in MATERIAL_CHANGES with a summary naming both, so everyone re-accepts once.
// ---------------------------------------------------------------------------

const section = (html: string, heading: RegExp): string => {
  const start = html.search(heading);
  expect(start, `heading ${heading} not found`).toBeGreaterThan(-1);
  const next = html.indexOf('<h2>', start + 4);
  return html.slice(start, next === -1 ? undefined : next);
};

describe('[2026-10-21] Terms section 4: the taxi waiting charge', () => {
  const s4 = () => section(TERMS, /<h2>4\. /);

  it('names the charge at the code\'s own amount and block, and only when the app showed it before booking', () => {
    const { chargePerBlock, blockMinutes } = TAXI_WAITING_DEFAULTS;
    expect(s4()).toContain(`GY$${chargePerBlock} for each full ${blockMinutes} minutes the car waits for you`);
    expect(s4()).toContain('When the app shows a waiting charge beside the taxi fare before you book, that charge applies to the ride');
    // The disclosure the app shows is built from the same terms (no second author of the numbers).
    expect(waitingTermsText({ chargePerBlock, blockMinutes, currencyCode: 'GYD' })).toBe(`Waiting: ${chargePerBlock} per ${blockMinutes} minutes after your driver arrives`);
  });

  it('says where waiting counts, and where it never does — what tallyTaxiWaiting computes', () => {
    expect(s4()).toContain('at the pickup, from when your driver arrives until your trip starts');
    expect(s4()).toContain('the app checks the driver\'s location before the count starts, or you confirm the arrival yourself');
    expect(s4()).toContain('at any stop on the way, from when the car arrives until it leaves');
    expect(s4()).toContain('Waiting at your final destination is never counted, and part of a 10-minute block is never charged.');
    expect(s4()).toContain('A ride that is cancelled, or that ends without the trip being completed, carries no waiting charge.');
  });

  it('promises the live count and the itemised receipt in the phone app, and keeps Swift out of the money', () => {
    expect(s4()).toContain('The Swift app shows the waiting time and the charge as they run, and the ride\'s receipt lists the waiting charge separately from the route fare.');
    expect(s4()).toContain('You pay it with your fare, directly to the driver.');
    expect(s4()).toContain('Swift never holds, collects or transmits Order money');
    expect(s4(), 'never a fee Swift keeps').not.toMatch(/Swift (charges|collects) (a|the) waiting/i);
  });
});

describe('[2026-10-21] Privacy Policy: phone crash reports, kept 90 days', () => {
  it('section 1 lists crash and error reports from the app and from Swift\'s servers', () => {
    expect(section(PRIVACY, /<h2>1\. /)).toContain('<li><b>Device and diagnostics:</b> a push-notification token, app version, and crash and error reports from the app and from Swift\'s servers (section 5 says what they contain).</li>');
  });

  it('section 5 says what a phone crash report carries, what it never carries, and where it goes', () => {
    const s5 = section(PRIVACY, /<h2>5\. /);
    expect(s5).toContain('If the Swift phone app crashes or hits an error, it sends a crash report to the same error-tracking service (GlitchTip) on Swift\'s own servers');
    expect(s5).toContain('the phone model and operating system, the app version, the error and where in the app it happened, the phone\'s language and time zone, and a random identifier for that app install that is not linked to your account or phone number');
    expect(s5).toContain('A crash report never includes your name, phone number, messages, location or a screenshot.');
    expect(s5).toContain('No outside company receives crash or error reports.');
  });

  it('section 6 keeps crash and error reports 90 days', () => {
    expect(section(PRIVACY, /<h2>6\. /)).toContain('Crash and error reports are kept for 90 days, then deleted.');
  });

  it('the processor register\'s error-tracking row says the same: self-hosted, phone reports, 90 days', () => {
    const row = PROCESSOR_REGISTER.find((p) => p.ref === 'ERROR_TRACKING')!;
    expect(row.transferBasis).toBe('SELF_HOSTED');
    expect(row.leavesCountry).toBe(false);
    expect(row.note).toMatch(/phone app/);
    expect(row.note).toMatch(/kept 90 days/);
  });
});

describe('[2026-10-21] one material version: everyone re-accepts once, with the summary', () => {
  // [owner 22 Oct 2026] 2026-10-22 (Terms s.7 one-minute cancel window, NON-material) is served on top of it: the
  // newest MATERIAL version is still 2026-10-21, so this summary is still the one a re-accept shows. [ROLE-DOCS]
  // 2026-10-22.1 (non-material: police clearance for taxi drivers only) is served on top of both. [owner 24 Oct
  // 2026] 2026-10-25 (non-material: no customer ID for taxi rides or larger orders) is served on top of those.
  // [O-1 · COORD 25 Oct] 2026-10-25.1 (material: Swift-bridged calling, Twilio for calls) is served on top of all of
  // these and is now the newest material version; 2026-10-21 stays material, and stays the newest one below it.
  // [POLICE-CLEARANCE CONSENT] 2026-10-25.2 (non-material) is served on top: the newest material version stays 2026-10-25.1.
  // [EMAIL-HTTPS] 2026-10-27 (material: Resend delivers the emails) is served on top and is now the newest material version.
  // [BOOK-S7] 2026-10-28 (non-material pending the owner: appointment rules) is served on top: the newest material version stays 2026-10-27.
  // [BOOK-FU2] 2026-10-28.1 (material: "Customer didn't come") is served on top and is now the newest material version.
  // [TERMS] 2026-10-29 (non-material: Terms s.7 pro appointments) is served on top: the newest material version stays 2026-10-28.1.
  // [BOOK-P3] 2026-10-29.1 (non-material: the free cancel after a move) is served on top: the same.
  it('2026-10-21 is a material version, the newest one below 2026-10-25.1 (material: calls), served under 2026-10-29.1 (newest material: 2026-10-28.1, no-show record)', () => {
    expect(LEGAL_VERSION).toBe('2026-10-29.1');
    expect(materialVersion('2026-10-25')).toBe('2026-10-21');
    expect(materialVersion('2026-10-25.2')).toBe('2026-10-25.1');
    expect(materialVersion(LEGAL_VERSION)).toBe('2026-10-28.1');
    expect(materialVersion('2026-10-28')).toBe('2026-10-27');
    expect(MATERIAL_CHANGES.map((c) => c.version)).toContain('2026-10-21');
    expect(NON_MATERIAL_CHANGES.map((c) => c.version)).not.toContain('2026-10-21');
    expect(MATERIAL_CHANGES.map((c) => c.version).slice(-4), 'newest last').toEqual(['2026-10-21', '2026-10-25.1', '2026-10-27', '2026-10-28.1']);
  });

  it('the summary names both changes', () => {
    const v21 = MATERIAL_CHANGES.find((c) => c.version === '2026-10-21')!.summary.join(' ');
    expect(v21).toContain(`GY$${TAXI_WAITING_DEFAULTS.chargePerBlock} for each full ${TAXI_WAITING_DEFAULTS.blockMinutes} minutes`);
    expect(v21).toMatch(/shown before you book/);
    expect(v21).toMatch(/crash report/);
    expect(v21).toMatch(/kept for 90 days/);
  });
});
