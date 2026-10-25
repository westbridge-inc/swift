import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { idCheckOf, profileIdRowSub, submittedCopy } from './customerIdCopy';

// [Owner ruling 8 Oct 2026 ~23:25 GYT — CUSTOMER ID] A customer's ID goes on file at once unless
// the server's automatic checks hold it for a person. The app repeats the server's answer and
// never calls an ID "verified" that no person reviewed. No selfie is asked for the ID.

const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('idCheckOf reads the server, never guesses', () => {
  it('takes the server idCheck when it sends a known one', () => {
    expect(idCheckOf({ idCheck: 'ON_FILE', status: 'APPROVED' })).toBe('ON_FILE');
    expect(idCheckOf({ idCheck: 'WAITING', status: 'PENDING' })).toBe('WAITING');
  });
  it('an older server without idCheck is read from the submission status', () => {
    expect(idCheckOf({ status: 'APPROVED' })).toBe('ON_FILE');
    expect(idCheckOf({ status: 'PENDING' })).toBe('WAITING');
    expect(idCheckOf({ status: 'REJECTED' })).toBe('NOT_ACCEPTED');
  });
  it('an unknown answer claims nothing', () => {
    expect(idCheckOf({ idCheck: 'VERIFIED', status: 'SOMETHING' })).toBeNull();
    expect(idCheckOf(null)).toBeNull();
  });
});

describe('the words stay truthful', () => {
  const all = [
    ...(['ON_FILE', 'CHECKED', 'WAITING', 'NOT_ACCEPTED', null] as const).map((c) => submittedCopy(c)),
  ].flatMap((c) => [c.title, c.body]);
  const rows = ['ON_FILE', 'CHECKED', 'WAITING', 'NOT_ACCEPTED', 'NONE', undefined].map(profileIdRowSub);

  it('nothing says "verified"', () => {
    for (const line of [...all, ...rows]) expect(line).not.toMatch(/verif/i);
  });
  // [Owner ruling 24 Oct 2026 ~05:55Z — NO CUSTOMER ID GATE] Taxi rides and bigger orders no longer need
  // the ID, so on file says where it is kept and nothing claims an unlock. [16 Oct] No line asks a
  // customer for a photo.
  it('on file says the ID is kept, with no unlock and no photo; waiting says a person looks first and promises no time', () => {
    expect(submittedCopy('ON_FILE')).toEqual({ title: 'Your ID is on file', body: 'Thanks — it is kept with your account, as the Privacy Policy explains.' });
    expect(submittedCopy('CHECKED')).toEqual({ title: 'Your ID is on file', body: 'Thanks — it is kept with your account, as the Privacy Policy explains.' });
    expect(profileIdRowSub('ON_FILE')).toBe('On file');
    for (const line of [...all, ...rows]) expect(line).not.toMatch(/profile photo|selfie/i);
    for (const line of [...all, ...rows]) expect(line).not.toMatch(/unlock|taxi|bigger orders/i);
    expect(submittedCopy('WAITING').title).toMatch(/person/);
    expect(submittedCopy('WAITING').body).not.toMatch(/\d+\s*hours?/);
  });
  it('only a person-reviewed ID is "checked" on the Profile row', () => {
    expect(profileIdRowSub('CHECKED')).toBe('Checked by our team');
    expect(profileIdRowSub('ON_FILE')).toMatch(/^On file/);
    // NONE also reaches an account already above L1 with no customer ID on record. [24 Oct 2026] The ID
    // is optional, and the row says so — never that this account needs one.
    expect(profileIdRowSub(undefined)).toBe('Optional');
    expect(profileIdRowSub('NONE')).toBe('Optional');
    for (const line of rows) expect(line).not.toMatch(/needed|you need/i);
  });
  // [Owner ruling 24 Oct 2026] No row claims an unlock any more: the ID unlocks no taxi ride and no order size.
  it('no row claims an unlock', () => {
    for (const c of ['ON_FILE', 'CHECKED', 'WAITING', 'NOT_ACCEPTED', 'NONE', undefined]) expect(profileIdRowSub(c)).not.toMatch(/unlock/i);
  });
});

describe('the screens ask for the ID alone and repeat the server', () => {
  it('the ID screen has no selfie step and no "we verify" promise', () => {
    const screen = src('modules/account/screens/IdentityVerificationScreen.tsx');
    expect(screen).not.toMatch(/title="Selfie"/);
    expect(screen).not.toMatch(/selfieUrl/);
    expect(screen).not.toMatch(/We verify within/);
    expect(screen).not.toMatch(/Submit for verification/);
    expect(screen).toMatch(/submittedCopy\(outcome\)/);
    expect(screen).toMatch(/setOutcome\(idCheckOf\(/);
    // No retention promise in a store binary beyond the Privacy Policy (bans keep the ID for the retention period).
    expect(screen).not.toMatch(/kept only while your account is open/);
    expect(screen).toMatch(/Privacy Policy says how long we keep it/);
  });
  it('the Profile row line comes from the server idCheck', () => {
    expect(src('modules/profile/screens/ProfileScreen.tsx')).toMatch(/sub=\{profileIdRowSub\(p\?\.idCheck\)\}/);
  });
  // [Owner ruling 24 Oct 2026] The taxi screen has no ID door any more (taxiDoors.test.ts); the FAQ and the ID
  // screen say the ID is optional and never that a ride or a bigger order needs it.
  it('the taxi screen has no ID door; the FAQ and the ID screen call the ID optional, never "verify"', () => {
    const taxi = src('modules/movement/screens/TaxiScreen.tsx');
    expect(taxi).not.toMatch(/Add your ID|Verify your ID/);
    const faq = src('modules/profile/screens/FaqScreen.tsx');
    expect(faq).not.toMatch(/verified ID|plus a selfie/);
    // [Owner 16 Oct] The FAQ asks a customer for no photo, taxi included.
    expect(faq).not.toMatch(/profile photo/);
    expect(faq).not.toMatch(/Bigger orders and taxi rides need your ID/);
    expect(faq).toMatch(/You don’t need an ID to order or to take a taxi/);
    const screen = src('modules/account/screens/IdentityVerificationScreen.tsx');
    expect(screen).not.toMatch(/Needed once for taxi rides and bigger orders/);
    expect(screen).toMatch(/Optional — you don’t need an ID to order or to take a taxi/);
  });
});
