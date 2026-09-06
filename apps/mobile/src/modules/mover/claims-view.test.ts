import { describe, it, expect } from 'vitest';
import { claimStatus, evidenceLine, flagHint, reasonLabel } from './claims-view';

describe('claims view helpers — the rider\'s words for the policy', () => {
  it('status labels: approved says Swift pays, review says a person, rejected says not covered', () => {
    expect(claimStatus('AUTO_APPROVED')).toEqual({ label: 'Approved — Swift pays you', tone: 'success' });
    expect(claimStatus('PENDING_REVIEW')).toEqual({ label: 'Under review', tone: 'brand' });
    expect(claimStatus('PAID').label).toBe('Paid');
    expect(claimStatus('REJECTED')).toEqual({ label: 'Not covered', tone: 'error' });
  });
  it('evidence lines: present is ok, required-and-absent is missing, optional-and-absent is optional', () => {
    expect(evidenceLine({ key: 'door_photo', present: true, required: true })).toEqual({ label: 'Photo at the door', state: 'ok' });
    expect(evidenceLine({ key: 'rider_at_door', present: false, required: true })).toEqual({ label: 'You were at the door', state: 'missing' });
    expect(evidenceLine({ key: 'customer_contacted', present: false, required: false }).state).toBe('optional');
  });
  it('flags become plain hints; internal names never reach the rider; unknown flags say nothing', () => {
    expect(flagHint('over_monthly_cap')).toContain('30 days');
    expect(flagHint('protection_suspended')).toContain('suspended');
    expect(flagHint('collusion_pair_cluster')).toBe('Reviewed by a person.');
    expect(flagHint('some_new_flag')).toBeNull();
    expect(reasonLabel('no_show')).toBe('Customer did not show');
  });
});
