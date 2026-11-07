import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// [ADMIN-UI · REVIEW-F #2056 S4] The Review Center's status tabs say what a
// document's state means in words; the raw enum is what the server is sent.
describe('[ADMIN-UI] Review Center status tabs', () => {
  it('reads Waiting for review / Approved / Rejected / Expired, never PENDING', async () => {
    mockApi((r) => {
      if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: {} } };
      if (r.url.pathname === '/api/v1/admin/verification/queue') return { body: { success: true, data: [] } };
      return { body: { success: true, data: [] } };
    });
    renderWithQuery(<VerificationPage />);
    const tabs = await screen.findByLabelText('Document status');
    const words = Array.from(tabs.querySelectorAll('button')).map((b) => b.textContent);
    expect(words).toEqual(['Waiting for review', 'Approved', 'Rejected', 'Expired']);
  });
});
