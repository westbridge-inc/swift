import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// [ADMIN-AUDIT S3-4 · REVIEW-F #2155 S3-1, lifted from F's probe] The solo-approval wait line on the approval card
// (the moment an admin may approve their own money/platform change) was written in the browser's locale and zone
// (soloWaitCopy: at.toLocaleString(undefined, ...)). It is written like every other console date: Guyana time, day
// first, the month in words. The suite runs in a zone far from Guyana; the helper is imported after the switch.
describe('[ADMIN-AUDIT S3-4] the solo wait in Guyana words', () => {
  const zone = process.env['TZ'];
  let soloWaitCopy: typeof import('./approvals').soloWaitCopy;
  beforeAll(async () => {
    process.env['TZ'] = 'Pacific/Honolulu';
    ({ soloWaitCopy } = await import('./approvals'));
  });
  afterAll(() => { if (zone === undefined) delete process.env['TZ']; else process.env['TZ'] = zone; });
  it('P1 the wait end prints in Guyana time, day first, month in words', () => {
    expect(soloWaitCopy('2026-10-28T11:30:00Z', new Date('2026-10-27T12:00:00Z'))).toBe('Solo approval: available after 28 Oct 2026, 07:30');
  });
  it('a wait that has ended says since when, in the same words', () => {
    // 02:30Z on 28 Oct is still 27 Oct in Georgetown (UTC-4).
    expect(soloWaitCopy('2026-10-28T02:30:00Z', new Date('2026-10-28T12:00:00Z'))).toBe('Solo approval: available now (since 27 Oct 2026, 22:30)');
  });
});
