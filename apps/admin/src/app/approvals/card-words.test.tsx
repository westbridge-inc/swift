import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ApprovalsPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { timeLeftWords } from '@/lib/approvals';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S3-7] The approval card reads in words.
//
// The audit's card: "C4 · PENDING · 1433 min left", with the capability code
// as the first fact. It now says Money / Platform, "Waiting for a second
// admin", "23 h 53 min left"; the codes stay as muted secondary detail.
// ---------------------------------------------------------------------------

const PENDING = {
  id: 'ap-p', action: 'PUT /subscriptions/:id/waive-fee', cls: 'C4', capability: 'subscription.waive', entityId: 'sub_9',
  fingerprint: 'a'.repeat(64), status: 'PENDING', requestedBy: 'admin-1', reason: 'Partner was closed for the flood week; waive it.',
  bodySnapshot: { params: { id: 'sub_9' }, body: {} }, approvedBy: null, decisionNote: null, decidedAt: null, appliedAt: null,
  expiresAt: new Date(Date.now() + 1433 * 60_000 + 30_000).toISOString(), createdAt: new Date(Date.now() - 7 * 60_000).toISOString(), isOwnRequest: false,
};

describe('[ADMIN-AUDIT S3-7] the approval card in words', () => {
  it('says Money, "Waiting for a second admin" and "23 h 53 min left" — never "C4 · PENDING · 1433 min left"', async () => {
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/approvals') return { body: { success: true, data: (r.url.searchParams.get('status') ?? 'PENDING') === 'PENDING' ? [PENDING] : [] } };
      return { body: { success: true, data: [] } };
    });
    renderWithQuery(<ApprovalsPage />);
    expect(await screen.findByText('Waiting for a second admin')).toBeTruthy();
    expect(screen.getByText('Money')).toBeTruthy();
    expect(screen.getByText('23 h 53 min left')).toBeTruthy();
    expect(screen.queryByText('PENDING')).toBeNull();
    expect(screen.queryByText('C4')).toBeNull();
    expect(screen.queryByText(/1433 min/)).toBeNull();
    // the code is still there for whoever needs it, after "Code:"
    expect(document.body.textContent).toContain('Code: subscription.waive');
  });

  it('time left in hours and minutes', () => {
    expect(timeLeftWords(1433)).toBe('23 h 53 min left');
    expect(timeLeftWords(60)).toBe('1 h 0 min left');
    expect(timeLeftWords(45)).toBe('45 min left');
    expect(timeLeftWords(0)).toBe('expired');
  });
});
