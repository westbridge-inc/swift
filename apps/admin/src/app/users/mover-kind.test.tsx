import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import UsersPage from './page';
import UserDetailPage from './[id]/page';
import { fulfilledParams, mockApi, renderWithQuery } from '@/test/test-utils';

// A MOVER who signed up and stopped before the vehicle step has no Rider row and no Driver row. The list said "Rider
// or driver" for every MOVER and the person's page said "Customer only."; neither told an operator what had happened.

const row = (id: string, firstName: string, activeRole: string, mover: { rider?: { id: string } | null; driver?: { id: string } | null }) => ({
  id, firstName, lastName: 'Person', phone: '•••••4567', email: null, roles: [activeRole, 'CUSTOMER'], activeRole, status: 'ACTIVE',
  isPhoneVerified: true, createdAt: '2026-09-01T00:00:00Z', lastActiveAt: null, avatar: null, ...mover,
});

async function roleCell(person: ReturnType<typeof row>) {
  mockApi(() => ({ body: { success: true, data: [person], meta: { page: 1, limit: 25, total: 1, totalPages: 1, hasNext: false, hasPrev: false } } }));
  renderWithQuery(<UsersPage />);
  const table = await screen.findByRole('table', { name: 'People' });
  const cells = within(within(table).getAllByRole('row')[1]!).getAllByRole('cell');
  return cells[2]!.textContent;
}

describe('the People list names what a mover is', () => {
  it.each([
    ['a rider row', { rider: { id: 'r1' }, driver: null }, 'Rider'],
    ['a driver row', { rider: null, driver: { id: 'd1' } }, 'Driver'],
    ['both', { rider: { id: 'r1' }, driver: { id: 'd1' } }, 'Rider and driver'],
    ['neither', { rider: null, driver: null }, 'Vehicle not added'],
  ])('MOVER with %s', async (_what, mover, words) => {
    expect(await roleCell(row('u1', 'Mina', 'MOVER', mover))).toBe(words);
  });

  it('an API from before the row said keeps the old words, never a false "not added"', async () => {
    expect(await roleCell(row('u1', 'Mina', 'MOVER', {}))).toBe('Rider or driver');
  });

  it('other roles are unchanged, and the role filter still offers movers as one choice', async () => {
    expect(await roleCell(row('u1', 'Mina', 'CUSTOMER', { rider: null, driver: null }))).toBe('Customer');
    expect(within(screen.getByRole('combobox', { name: 'Role' })).getByRole('option', { name: 'Rider or driver' })).toBeTruthy();
  });
});

const person = (over: Record<string, unknown>) => ({
  id: 'user-1', firstName: 'Mina', lastName: 'Person', phone: '•••••4567', email: null, status: 'ACTIVE', roles: ['CUSTOMER'],
  createdAt: '2026-08-01T00:00:00.000Z', lastActiveAt: null, isPhoneVerified: true, orders: [], strikes: [], addresses: [],
  _count: { orders: 0, strikes: 0 }, rider: null, driver: null, vendorOwner: null, ...over,
});

async function profilesCard(over: Record<string, unknown>) {
  mockApi(({ url }) => ({ body: { success: true, data: url.pathname.endsWith('/user-1') ? person(over) : null } }));
  renderWithQuery(<UserDetailPage params={fulfilledParams({ id: 'user-1' })} />);
  const heading = await screen.findByRole('heading', { name: 'Profiles' });
  return heading.closest('section')!;
}

const NOT_ADDED = 'Signed up as a rider or driver and has not added a vehicle yet, so which one is not known.';

describe('the Profiles card on a person', () => {
  it('a MOVER with no profile is told as that, not as a customer', async () => {
    const card = await profilesCard({ roles: ['MOVER', 'CUSTOMER'] });
    expect(within(card).getByText(NOT_ADDED)).toBeTruthy();
    expect(within(card).queryByText('Customer only.')).toBeNull();
  });

  it('a MOVER with no profile who also owns a store: the store and the note, both', async () => {
    const card = await profilesCard({ roles: ['MOVER', 'VENDOR_OWNER'], vendorOwner: { vendors: [{ id: 'v1', name: 'Mina Kitchen', status: 'ACTIVE' }] } });
    expect(within(card).getByText(NOT_ADDED)).toBeTruthy();
    expect(within(card).getByText('Mina Kitchen')).toBeTruthy();
  });

  it('an account that does not hold MOVER is still "Customer only."', async () => {
    const card = await profilesCard({ roles: ['CUSTOMER'] });
    expect(within(card).getByText('Customer only.')).toBeTruthy();
    expect(within(card).queryByText(NOT_ADDED)).toBeNull();
  });

  it('a MOVER with a profile shows the profile and neither sentence', async () => {
    const card = await profilesCard({ roles: ['MOVER', 'CUSTOMER'], rider: { id: 'r1', documentsVerified: false } });
    expect(within(card).getByRole('link', { name: /Rider profile/ })).toBeTruthy();
    expect(within(card).queryByText(NOT_ADDED)).toBeNull();
    expect(within(card).queryByText('Customer only.')).toBeNull();
  });
});
