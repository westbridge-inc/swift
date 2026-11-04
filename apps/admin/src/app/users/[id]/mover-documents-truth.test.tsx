import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import UserDetailPage from './page';
import { fulfilledParams, mockApi, renderWithQuery } from '@/test/test-utils';

// [BUG-HUNT F06] The person page's Profiles card answers from the verdict GO uses, not the old flag.
const person = (rider: unknown, driver: unknown = null) => ({
  id: 'user-1', firstName: 'Test', lastName: 'Person', phone: 'person-phone', status: 'ACTIVE', roles: ['MOVER', 'CUSTOMER'],
  createdAt: '2026-08-01T00:00:00.000Z', lastActiveAt: null, isPhoneVerified: true, orders: [], strikes: [], addresses: [],
  _count: { orders: 0, strikes: 0 }, rider, driver,
});

function draw(data: unknown) {
  mockApi((request) => {
    if (request.url.pathname === '/api/v1/admin/users/user-1') return { body: { success: true, data } };
    return { body: { success: true, data: [] } };
  });
  renderWithQuery(<UserDetailPage params={fulfilledParams({ id: 'user-1' })} />);
}

describe('[BUG-HUNT F06] the Profiles card', () => {
  it('flag false, the gate lets them online: complete, never "Not verified"', async () => {
    draw(person({ id: 'r1', documentsVerified: false, documentsLive: { allowed: true, reason: 'ok', validUntil: null } }));
    const link = await screen.findByRole('link', { name: /Rider profile/ });
    expect(within(link).getByText('Documents complete')).toBeTruthy();
    expect(screen.queryByText('Not verified')).toBeNull();
  });

  it('flag true, a document gone: missing', async () => {
    draw(person(null, { id: 'd1', documentsVerified: true, documentsLive: { allowed: false, reason: 'docs', validUntil: null } }));
    const link = await screen.findByRole('link', { name: /Driver profile/ });
    expect(within(link).getByText('Documents missing')).toBeTruthy();
  });

  it('a taxi driver missing hire insurance is told apart', async () => {
    draw(person(null, { id: 'd1', documentsVerified: false, documentsLive: { allowed: false, reason: 'insurance', validUntil: null } }));
    expect(within(await screen.findByRole('link', { name: /Driver profile/ })).getByText('Needs hire insurance')).toBeTruthy();
  });
});
