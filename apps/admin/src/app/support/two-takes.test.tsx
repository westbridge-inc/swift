import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SupportPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S3-6 · REVIEW-F #2156 S4-1, lifted from F's probe P2] Two takes in flight. TanStack runs the callbacks
// passed to mutate() only for the LATEST call, so the first take's answer was lost: a failed first take left its row
// "Taking…" (disabled) with nothing said, and a first take that worked never said where the ticket went. Each take's
// answer now comes back to its own ticket.
// ---------------------------------------------------------------------------
const ticket = (id: string, subject: string) => ({
  id, category: 'ORDER_ISSUE', subject, message: 'My order arrived cold.', status: 'OPEN', createdAt: '2026-09-01T12:00:00.000Z',
  user: { id: `u-${id}`, firstName: 'Ada', lastName: 'R', phone: '+5926000000' },
});
const A = ticket('t-a', 'Cold food');
const B = ticket('t-b', 'Wrong change');
const card = (subject: string) => screen.getByText(subject).closest('.mc-card') as HTMLElement;

describe('[ADMIN-AUDIT S3-6] two takes in flight each get their own answer', () => {
  it('a first take that fails while a second is in flight frees its button and says why, next to it', async () => {
    const hold: { release?: () => void } = {};
    const fetch = mockApi(async (r: ApiRequest) => {
      if (r.method === 'GET') return { body: { success: true, data: { tickets: [A, B], total: 2 } } };
      if (r.url.pathname.includes('/t-a/')) {
        await new Promise<void>((resolve) => { hold.release = resolve; });
        return { status: 409, body: { success: false, error: { code: 'CONFLICT', message: 'Someone else changed this ticket.' } } };
      }
      return { body: { success: true, data: {} } };
    });
    const { user } = renderWithQuery(<SupportPage />);
    await screen.findByText('Cold food');
    await user.click(within(card('Cold food')).getByRole('button', { name: 'Take it' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    await user.click(within(card('Wrong change')).getByRole('button', { name: 'Take it' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(2));
    await screen.findByRole('status');
    hold.release!();
    await waitFor(() => expect((within(card('Cold food')).getByRole('button', { name: 'Take it' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
    expect(within(card('Cold food')).getByRole('alert').textContent).toContain('Someone else changed this ticket.');
    expect(within(card('Wrong change')).queryByRole('alert')).toBeNull();
  });

  it('a first take that works after a second one finished still says where its ticket went', async () => {
    const hold: { release?: () => void } = {};
    const fetch = mockApi(async (r: ApiRequest) => {
      if (r.method === 'GET') return { body: { success: true, data: { tickets: [A, B], total: 2 } } };
      if (r.url.pathname.includes('/t-a/')) await new Promise<void>((resolve) => { hold.release = resolve; });
      return { body: { success: true, data: {} } };
    });
    const { user } = renderWithQuery(<SupportPage />);
    await screen.findByText('Cold food');
    await user.click(within(card('Cold food')).getByRole('button', { name: 'Take it' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    await user.click(within(card('Wrong change')).getByRole('button', { name: 'Take it' }));
    expect(await screen.findByText(/You took “Wrong change”/)).toBeTruthy();
    hold.release!();
    expect(await screen.findByText(/You took “Cold food”/, undefined, { timeout: 3000 })).toBeTruthy();
  });
});
