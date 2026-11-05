import { describe, it, expect } from 'vitest';
import { claimHints, claimStatus, evidenceLine, flagHint, reasonLabel } from './claims-view';

describe('claims view helpers — the rider\'s words, case by case', () => {
  it('status labels: a person reviews, a person approves, an old automatic row waits for a person, nothing promises', () => {
    expect(claimStatus('PENDING_REVIEW')).toEqual({ label: 'A person will review this', tone: 'brand' });
    expect(claimStatus('AUTO_APPROVED')).toEqual({ label: 'A person will review this', tone: 'brand' });
    expect(claimStatus('APPROVED')).toEqual({ label: 'Approved by a person', tone: 'success' });
    // Evidence is missing: one more decision is needed, so nothing reads as done.
    expect(claimStatus('APPROVED', false)).toEqual({ label: 'Reviewed', tone: 'brand' });
    expect(claimStatus('PAID').label).toBe('Paid');
    expect(claimStatus('REJECTED')).toEqual({ label: 'Not approved', tone: 'error' });
  });
  it('a closed case never reads as still on its way: the late line shows only while it is open', () => {
    expect(claimHints(['sla_breached'], 'APPROVED')).toEqual(['This is taking longer than it should. Swift has been told.']);
    for (const closed of ['REJECTED', 'PAID']) expect(claimHints(['sla_breached'], closed)).toEqual([]);
    // Everything else on a closed case still explains it.
    expect(claimHints(['sla_breached', 'gps_far'], 'REJECTED')).toEqual([flagHint('gps_far')]);
    expect(claimHints(['some_new_flag'], 'APPROVED')).toEqual([]);
  });
  it('evidence lines: present is ok, required-and-absent is missing, optional-and-absent is optional', () => {
    expect(evidenceLine({ key: 'door_photo', present: true, required: true })).toEqual({ label: 'Photo at the door', state: 'ok' });
    expect(evidenceLine({ key: 'rider_at_door', present: false, required: true })).toEqual({ label: 'You were at the door', state: 'missing' });
    expect(evidenceLine({ key: 'customer_contacted', present: false, required: false }).state).toBe('optional');
  });
  it('flags become plain hints; internal names never reach the rider; unknown flags say nothing', () => {
    expect(flagHint('over_monthly_cap')).toContain('last 30 days');
    expect(flagHint('over_monthly_cap')).not.toMatch(/limit/i); // a limit reads as a right up to it
    expect(flagHint('over_gate')).toContain('closer look');
    expect(flagHint('protection_suspended')).toContain('suspended');
    expect(flagHint('evidence_incomplete')).toContain('reviewer can see');
    expect(flagHint('evidence_incomplete')).not.toMatch(/cannot pay|can still approve/i);
    expect(evidenceLine({ key: 'elapsed_wait', present: false, required: true }).label).toBe('Wait at the door');
    expect(flagHint('sla_breached')).not.toMatch(/payment to you/i);
    expect(flagHint('collusion_pair_cluster')).toBe('Reviewed by a person.');
    expect(flagHint('some_new_flag')).toBeNull();
    expect(reasonLabel('no_show')).toBe('Customer did not show');
  });
});
