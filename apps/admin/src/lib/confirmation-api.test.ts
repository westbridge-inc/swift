import { describe, expect, it } from 'vitest';
import { fetchConfirmationApprovals } from './api';
import { mockApi } from '@/test/test-utils';

describe('complete confirmation approval reads', () => {
  it('reads all pending and approved pages so older requests still prevent duplicates', async () => {
    const reads: string[] = [];
    mockApi((r) => {
      const status = r.url.searchParams.get('status')!; const page = Number(r.url.searchParams.get('page'));
      reads.push(`${status}:${page}`);
      return { body: { success: true, data: [{ id: `${status}:${page}` }], pagination: { page, pages: status === 'PENDING' ? 2 : 1 } } };
    });
    expect((await fetchConfirmationApprovals()).map((r) => r.id)).toEqual(['PENDING:1', 'PENDING:2', 'APPROVED:1']);
    expect(reads).toEqual(['PENDING:1', 'PENDING:2', 'APPROVED:1']);
  });
  it('a malformed or incomplete approvals read cannot unlock another request', async () => {
    mockApi(() => ({ body: { success: true, data: [] } }));
    await expect(fetchConfirmationApprovals()).rejects.toThrow('complete approvals queue');
  });
});
