import { describe, it, expect } from 'vitest';
import { capLine, registrationLine, tierLabel } from './tier-view';

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
