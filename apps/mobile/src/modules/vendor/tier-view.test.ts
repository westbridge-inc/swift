import { describe, it, expect } from 'vitest';
import { capLine, declarationLine, registrationLine, tierLabel } from './tier-view';

describe('tier view helpers', () => {
  it('labels the tiers and shows usage against the cap as a fraction', () => {
    expect(tierLabel({ tier: 'UNREGISTERED' })).toEqual({ label: 'Unregistered seller — limits apply', tone: 'brand' });
    expect(tierLabel({ tier: 'REGISTERED' }).tone).toBe('success');
    expect(capLine(18, 30, 'Orders today')).toEqual({ text: 'Orders today: 18 of 30', fraction: 0.6 });
    expect(capLine(200000, 150000, 'Sales this week').fraction).toBe(1);
  });
  it('says where the registration stands', () => {
    expect(registrationLine({ registration: { onFile: true, recordId: 'r' } })).toBe('Business registration on file.');
    expect(registrationLine({ registration: { onFile: false, submission: null } })).toBe('No business registration on file yet.');
    expect(registrationLine({ registration: { onFile: false, submission: { status: 'PENDING', submittedAt: 'x' } } })).toBe('Business registration submitted — under review.');
  });
});

// [FOLLOWUPS] The self-declaration's "valid to" is its day in Guyana, whatever zone the phone is in (it printed the
// phone-zone day with the phone's own date words). A declaration lasts 365 days from signing: a moment.
describe('[FOLLOWUPS] declarationLine', () => {
  it('a declaration signed at 22:30 in Guyana is valid to that Guyana day, not the next UTC day', () => {
    const ZONE = process.env['TZ'];
    try {
      for (const zone of ['America/Guyana', 'Asia/Tokyo', 'Pacific/Honolulu']) {
        process.env['TZ'] = zone;
        expect(declarationLine({ declaration: { status: 'ACTIVE', signedAt: '2026-10-28T02:30:00.000Z', expiresAt: '2027-10-28T02:30:00.000Z' } }), zone)
          .toBe('Self-declaration active · valid to 27 Oct 2027');
      }
    } finally { process.env['TZ'] = ZONE; }
  });
  it('no declaration, no line; no expiry, no "valid to"', () => {
    expect(declarationLine({ declaration: null })).toBeNull();
    expect(declarationLine({ declaration: { status: 'PENDING_REVIEW', signedAt: '2026-10-28T02:30:00.000Z', expiresAt: null } })).toBe('Self-declaration pending review');
  });
  it('the seller status screen prints the line from here (no date words of its own)', async () => {
    const { readFileSync } = await import('node:fs');
    const screen = readFileSync(new URL('./screens/VendorTierScreen.tsx', import.meta.url), 'utf8');
    expect(screen).toContain('declarationLine(t)');
    expect(screen).not.toMatch(/toLocaleDateString|toLocaleString/);
  });
});
