import { describe, expect, it } from 'vitest';
import { groupApplicants, loadReviewQueue, waitingSince, type ReviewDocument } from './review-center';
import { mockApi } from '@/test/test-utils';

describe('complete, oldest-first applicant queue', () => {
  it('does not publish a partial applicant list when a later page fails', async () => {
    const seen: string[] = [];
    mockApi((request) => {
      seen.push(request.url.searchParams.get('page')!);
      expect(request.url.searchParams.get('role')).toBe('operator');
      expect(request.url.searchParams.get('limit')).toBe('50');
      return seen.length === 1 ? { body: { data: [{ id: 'a' }], meta: { hasNext: true } } } : { status: 503, body: { error: { message: 'Queue unavailable' } } };
    });
    await expect(loadReviewQueue('PENDING', 'operator')).rejects.toThrow('Queue unavailable');
    expect(seen).toEqual(['1', '2']);
  });
  it('uses account identity, never a shared name or phone, and orders by the oldest document', () => {
    const document = (id: string, userId: string, date: string): ReviewDocument => ({ id, userId, createdAt: date, docType: 'national_id', role: 'CUSTOMER', status: 'PENDING', user: { id: userId, firstName: 'Same', phone: 'same' } });
    const groups = groupApplicants([document('a', 'one', '2026-09-03'), document('b', 'two', '2026-09-02'), document('c', 'one', '2026-09-01')]);
    expect(groups.map((g) => g.id)).toEqual(['one', 'two']);
    expect(groups[0]?.documents.map((d) => d.id)).toEqual(['a', 'c']);
    expect(waitingSince(Date.parse('2026-09-01'), Date.parse('2026-09-04T02:00Z'))).toBe('Waiting 3d 2h');
  });
});
