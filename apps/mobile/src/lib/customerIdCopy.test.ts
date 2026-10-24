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
  // [Owner ruling 16 Oct 2026 — customers take no photos] The ID on file unlocks bigger orders AND taxi
  // rides (the server's ride gate is the ID alone); no line asks a customer for a photo.
  it('on file says bigger orders and taxi rides are unlocked, with no photo; waiting says a person looks first and promises no time', () => {
    expect(submittedCopy('ON_FILE')).toEqual({ title: 'Your ID is on file', body: 'Bigger orders and taxi rides are unlocked now.' });
    expect(submittedCopy('CHECKED')).toEqual({ title: 'Your ID is on file', body: 'Bigger orders and taxi rides are unlocked now.' });
    expect(profileIdRowSub('ON_FILE')).toBe('On file — bigger orders and taxi rides unlocked');
    for (const line of [...all, ...rows]) expect(line).not.toMatch(/profile photo|selfie/i);
    expect(submittedCopy('WAITING').title).toMatch(/person/);
    expect(submittedCopy('WAITING').body).not.toMatch(/\d+\s*hours?/);
  });
  it('only a person-reviewed ID is "checked" on the Profile row', () => {
    expect(profileIdRowSub('CHECKED')).toBe('Checked by our team');
    expect(profileIdRowSub('ON_FILE')).toMatch(/^On file/);
    // NONE also reaches an account already above L1 with no customer ID on record: say what the ID
    // is for, never that this account needs one.
    expect(profileIdRowSub(undefined)).toBe('For bigger orders and taxi rides');
    expect(profileIdRowSub('NONE')).toBe('For bigger orders and taxi rides');
    for (const line of rows) expect(line).not.toMatch(/needed|you need/i);
  });
  // [Owner ruling 16 Oct 2026] The ID on file is now the whole ride gate (no photo), so the short line
  // says it unlocks taxi rides too — and only the ON_FILE line claims an unlock.
  it('the short line says the ID on file unlocks bigger orders and taxi rides; no other row claims an unlock', () => {
    expect(profileIdRowSub('ON_FILE')).toBe('On file — bigger orders and taxi rides unlocked');
    for (const c of ['CHECKED', 'WAITING', 'NOT_ACCEPTED', 'NONE', undefined]) expect(profileIdRowSub(c)).not.toMatch(/unlocked/i);
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
  it('the taxi doors and the FAQ say "add your ID", not "verify"', () => {
    const taxi = src('modules/movement/screens/TaxiScreen.tsx');
    expect(taxi.match(/label="Add your ID — takes a minute"/g)?.length).toBe(2);
    expect(taxi).not.toMatch(/Verify your ID/);
    expect(src('modules/profile/screens/FaqScreen.tsx')).not.toMatch(/verified ID|plus a selfie/);
    // [Owner 16 Oct] The FAQ asks a customer for no photo, taxi included.
    expect(src('modules/profile/screens/FaqScreen.tsx')).not.toMatch(/profile photo/);
  });
});
