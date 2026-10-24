import { describe, expect, it } from 'vitest';
import { liveDocumentsLabel, liveDocumentsTone } from './live-documents';
import { newSinceLoaded } from './review-center';

// [Owner reports 8 Oct 2026] Lists show the live per-document verdict; the Review Center says when new documents arrive.
describe('live document status in the mover lists', () => {
  it('reads the live verdict, not the legacy flag', () => {
    expect(liveDocumentsLabel({ documentsVerified: false, documentsLive: { allowed: true, reason: 'ok', validUntil: null } })).toBe('Documents complete');
    expect(liveDocumentsLabel({ documentsVerified: true, documentsLive: { allowed: false, reason: 'docs', validUntil: null } })).toBe('Documents missing');
    expect(liveDocumentsLabel({ documentsLive: { allowed: false, reason: 'insurance', validUntil: null } })).toBe('Needs hire insurance');
    expect(liveDocumentsTone({ documentsVerified: false, documentsLive: { allowed: true, reason: 'ok', validUntil: null } })).toContain('green');
  });
  it('falls back to the legacy flag for an older reply', () => {
    expect(liveDocumentsLabel({ documentsVerified: true })).toBe('Verified');
    expect(liveDocumentsLabel({ documentsVerified: false })).toBe('Pending');
  });
});

describe('Review Center: new documents since the list loaded', () => {
  const counts = { byStatus: { PENDING: 9 }, byLane: { PENDING: { customer: 2, operator: 7 } } };
  it('counts what the server holds beyond what the page loaded, per lane', () => {
    expect(newSinceLoaded(counts, 'PENDING', 'operator', 5)).toBe(2);
    expect(newSinceLoaded(counts, 'PENDING', 'customer', 2)).toBe(0);
    expect(newSinceLoaded(counts, 'PENDING', 'all', 6)).toBe(3);
    expect(newSinceLoaded(undefined, 'PENDING', 'operator', 5)).toBe(0);
  });
});
