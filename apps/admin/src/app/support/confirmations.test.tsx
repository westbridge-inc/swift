import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SupportPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S3-6] "Take it" and "Close ticket" said nothing: the ticket just
// left the tab. One pending "Take it" disabled every row's button. Each act now
// says where the ticket went (with a door to that tab), and only the ticket
// being taken waits.
// ---------------------------------------------------------------------------

const ticket = (id: string, subject: string) => ({
  id, category: 'ORDER_ISSUE', subject, message: 'My order arrived cold.', status: 'OPEN', createdAt: '2026-09-01T12:00:00.000Z',
  user: { id: `u-${id}`, firstName: 'Ada', lastName: 'R', phone: '+5926000000' },
});
const A = ticket('t-a', 'Cold food');
const B = ticket('t-b', 'Wrong change');

function server(hold?: { release?: () => void }) {
  return mockApi(async (r: ApiRequest) => {
    if (r.method === 'GET') return { body: { success: true, data: { tickets: [A, B], total: 2 } } };
    if (hold && r.url.pathname.endsWith('/t-a/resolve')) await new Promise<void>((resolve) => { hold.release = resolve; });
    return { body: { success: true, data: {} } };
  });
}
const card = (subject: string) => screen.getByText(subject).closest('.mc-card') as HTMLElement;

describe('[ADMIN-AUDIT S3-6] support acts say where the ticket went', () => {
  it('Take it: only that ticket waits; then it says the ticket is yours, under Being handled, with a door there', async () => {
    const hold: { release?: () => void } = {};
    const fetch = server(hold);
    const { user } = renderWithQuery(<SupportPage />);
    await screen.findByText('Cold food');
    await user.click(within(card('Cold food')).getByRole('button', { name: 'Take it' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(within(card('Cold food')).getByRole('button', { name: 'Taking…' })).toBeTruthy();
    // the other ticket is not held by this one
    expect((within(card('Wrong change')).getByRole('button', { name: 'Take it' }) as HTMLButtonElement).disabled).toBe(false);
    hold.release!();
    const said = await screen.findByRole('status');
    expect(said.textContent).toContain('You took “Cold food”. It is now under Being handled.');
    await user.click(within(said).getByRole('button', { name: 'Show Being handled' }));
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).includes('status=IN_PROGRESS'))).toBe(true));
  });

  it('Close ticket: says how it was closed, and that the note went to the person', async () => {
    server();
    const { user } = renderWithQuery(<SupportPage />);
    await screen.findByText('Cold food');
    await user.click(within(card('Cold food')).getByRole('button', { name: 'Close this ticket' }));
    await user.click(within(card('Cold food')).getByRole('button', { name: 'Answered / information given' }));
    await user.type(within(card('Cold food')).getByRole('textbox'), 'We have refunded the delivery fee.');
    await user.click(within(card('Cold food')).getByRole('button', { name: 'Close ticket' }));
    const said = await screen.findByRole('status');
    expect(said.textContent).toContain('Closed “Cold food”: Answered / information given. Your note was sent to them.');
  });
});
