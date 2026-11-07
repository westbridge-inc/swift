import { screen, waitFor, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import UserDetailPage from '@/app/users/[id]/page';
import VendorDetailPage from '@/app/vendors/[id]/page';
import CustodyCasesPage from '@/app/custody/page';
import { MoverDetail } from '@/components/MoverDetail';
import { fulfilledParams, mockApi, renderWithQuery, type ApiReply, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [FOLLOWUPS · COORD ruling 28 Oct 2026, owner delegated; follows O-1] The
// person pages show a phone number the order desk's way: masked by default
// (••• ••• NNNN, whatever the server sends), and "Show number" asks why, sends
// the reason in x-swift-reason to that page's own audited door, and only then
// shows the full number with the note that the read is recorded. A closed
// panel sends nothing. Four pages: a person, a store (owner + store line), a
// rider or driver, and a custody case (holder + relay rider).
// The server already masks; these pages are fed FULL fictional numbers to
// prove the console masks again on its own (as #2158 does on Compliance).
// ---------------------------------------------------------------------------

type User = ReturnType<typeof userEvent.setup>;
const REASON = 'Rider rang support: cannot reach the store about the order';
const FULL = { person: '+5920600101', owner: '+5920600102', store: '+5920600103', rider: '+5920600104', relay: '+5920600105', driver: '+5920600106' };
const masked = (phone: string) => `••• ••• ${phone.slice(-4)}`;

const person = {
  id: 'user-1', firstName: 'Test', lastName: 'Person', phone: FULL.person, email: 'person@example.test', status: 'ACTIVE', roles: ['CUSTOMER'],
  createdAt: '2026-08-01T00:00:00.000Z', lastActiveAt: null, isPhoneVerified: true, orders: [], strikes: [], addresses: [], _count: { orders: 0, strikes: 0 },
};
const vendor = {
  id: 'vendor-1', name: 'Target Store', status: 'ACTIVE', vendorType: 'RESTAURANT', isFeatured: false, acceptingOrders: true, city: 'Georgetown',
  addressLine1: 'Test address', phone: FULL.store, averageRating: null, totalRatings: 0, mmgPayUrl: null, createdAt: '2026-08-01T00:00:00.000Z',
  recentOrders: [], subscription: null, _count: { items: 0, orders: 0 },
  owner: { user: { id: 'owner-1', firstName: 'Store', lastName: 'Owner', phone: FULL.owner, email: null, status: 'ACTIVE' }, vendors: [] },
};
const vendorChecklist = {
  vendorId: 'vendor-1', applicantId: 'owner-1', storeStatus: 'ACTIVE', suspensionSource: null, ownerAccountStatus: 'ACTIVE', isVerified: true,
  activationValidUntil: null, role: 'RESTAURANT', checklist: { complete: true, items: [] }, disclosure: { engaged: false, complete: true, missing: [] }, ready: true, next: 'LIVE',
};
const mover = (kind: 'rider' | 'driver') => ({
  id: `${kind}-1`, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: false, vehicleMake: 'Honda', vehicleModel: 'CG125',
  vehicleColor: 'Red', licensePlate: 'CJ 1234', subscription: null, earnings: [], _count: { orders: 0, earnings: 0 },
  user: { id: `user-${kind}`, firstName: 'Test', lastName: kind === 'rider' ? 'Rider' : 'Driver', phone: kind === 'rider' ? FULL.rider : FULL.driver, status: 'ACTIVE', createdAt: '2026-09-01T00:00:00.000Z' },
});
const moverChecklist = (kind: 'rider' | 'driver') => ({
  moverId: `${kind}-1`, kind: kind.toUpperCase(), applicantId: `user-${kind}`, vehicleType: 'MOTORCYCLE', documentsVerified: true,
  checklist: { items: [], complete: true }, live: { allowed: true, reason: 'ok' }, next: 'VERIFIED',
});
const kase = {
  id: 'case-1', orderId: 'order-1', state: 'TRANSFER_IN_PROGRESS', reason: 'VEHICLE_BREAKDOWN', reasonNote: null, ownerUserId: null,
  holderRiderId: 'rider-a', relayRiderId: 'rider-b', deadlineAt: '2026-10-05T12:00:00.000Z', escalationCount: 0, resolvedAt: null,
  createdAt: '2026-10-05T11:50:00.000Z', overdue: false,
  order: { orderNumber: 'SW-77', status: 'EN_ROUTE_DELIVERY', paymentMethod: 'CASH', vendor: { name: 'Roti Hut' } },
};
const caseDetail = {
  ...kase,
  order: { ...kase.order, id: 'order-1', subtotalBase: 3000, floatAttached: 0 },
  holder: { id: 'rider-a', isOnline: true, user: { firstName: 'Ana', lastName: 'Holder', phone: FULL.rider } },
  relay: { id: 'rider-b', isOnline: true, user: { firstName: 'Bo', lastName: 'Relay', phone: FULL.relay } },
  trail: [],
};

/** The pages' reads, plus each audited door answering with its number. */
const DOORS: Record<string, string> = {
  '/api/v1/admin/users/user-1/phone': FULL.person,
  '/api/v1/admin/vendors/vendor-1/party-phone?party=owner': FULL.owner,
  '/api/v1/admin/vendors/vendor-1/party-phone?party=store': FULL.store,
  '/api/v1/admin/riders/rider-1/phone': FULL.rider,
  '/api/v1/admin/drivers/driver-1/phone': FULL.driver,
  '/api/v1/admin/custody-cases/case-1/party-phone?party=holder': FULL.rider,
  '/api/v1/admin/custody-cases/case-1/party-phone?party=relay': FULL.relay,
};
const READS: Record<string, unknown> = {
  '/api/v1/admin/users/user-1': person,
  '/api/v1/admin/vendors/vendor-1': vendor,
  '/api/v1/admin/vendors/vendor-1/activation-checklist': vendorChecklist,
  '/api/v1/admin/riders/rider-1': mover('rider'),
  '/api/v1/admin/riders/rider-1/activation-checklist': moverChecklist('rider'),
  '/api/v1/admin/drivers/driver-1': mover('driver'),
  '/api/v1/admin/drivers/driver-1/activation-checklist': moverChecklist('driver'),
  '/api/v1/admin/custody-cases': [kase],
  '/api/v1/admin/custody-cases/case-1': caseDetail,
};
function serve() {
  return mockApi((request: ApiRequest): ApiReply => {
    const door = DOORS[`${request.url.pathname}${request.url.search}`];
    if (request.method === 'GET' && door) return { body: { success: true, data: { party: 'x', phone: door, auditId: 'audit-1' } } };
    if (request.method === 'GET' && request.url.pathname in READS) return { body: { success: true, data: READS[request.url.pathname] } };
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
}
const doorCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.filter(([url]) => /\/(phone|party-phone)(\?|$)/.test(new URL(String(url)).pathname + new URL(String(url)).search));

/** Clicks the n-th "Show number", gives the reason, confirms; returns the panel's heading. */
async function reveal(user: User, n: number) {
  await user.click((await screen.findAllByRole('button', { name: 'Show number' }))[n]!);
  const panel = await screen.findByRole('dialog');
  const heading = within(panel).getByRole('heading').textContent;
  await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
  await user.click(within(panel).getByRole('button', { name: 'Show number' }));
  return heading;
}
function expectDoor(fetchMock: ReturnType<typeof mockApi>, door: string) {
  const call = doorCalls(fetchMock).find(([url]) => { const u = new URL(String(url)); return `${u.pathname}${u.search}` === door; });
  expect(call, door).toBeTruthy();
  expect(new Headers(call![1]?.headers).get('x-swift-reason')).toBe(REASON);
}

describe('[FOLLOWUPS] a person page: masked, and one audited reveal', () => {
  it('shows ••• ••• NNNN, never the full number, and asks no door on its own', async () => {
    const fetchMock = serve();
    renderWithQuery(<UserDetailPage params={fulfilledParams({ id: 'user-1' })} />);
    expect(await screen.findByText(masked(FULL.person))).toBeTruthy();
    expect(document.body.textContent).not.toContain(FULL.person);
    expect(document.body.textContent).toContain('person@example.test');
    expect(doorCalls(fetchMock)).toHaveLength(0);
  });

  it('"Show number" names the person, sends the reason to GET /users/:id/phone, then shows the number as recorded', async () => {
    const fetchMock = serve();
    const { user } = renderWithQuery(<UserDetailPage params={fulfilledParams({ id: 'user-1' })} />);
    expect(await reveal(user, 0)).toBe("Show Test Person's full number?");
    expect(await screen.findByText(FULL.person)).toBeTruthy();
    expect(screen.getByText('Read recorded in the audit log')).toBeTruthy();
    expectDoor(fetchMock, '/api/v1/admin/users/user-1/phone');
  });

  it('a closed panel sends nothing and the number stays masked', async () => {
    const fetchMock = serve();
    const { user } = renderWithQuery(<UserDetailPage params={fulfilledParams({ id: 'user-1' })} />);
    await user.click(await screen.findByRole('button', { name: 'Show number' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(doorCalls(fetchMock)).toHaveLength(0);
    expect(document.body.textContent).not.toContain(FULL.person);
  });
});

describe('[FOLLOWUPS] a store page: the owner and the store line, each its own reveal', () => {
  it('both masked; each "Show number" reads only its own party', async () => {
    const fetchMock = serve();
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-1' })} />);
    expect(await screen.findByText(masked(FULL.owner))).toBeTruthy();
    expect(screen.getByText(masked(FULL.store))).toBeTruthy();
    for (const phone of [FULL.owner, FULL.store]) expect(document.body.textContent).not.toContain(phone);
    expect(await reveal(user, 0)).toBe("Show the owner's full number for Target Store?");
    expect(await screen.findByText(FULL.owner)).toBeTruthy();
    expect(document.body.textContent).not.toContain(FULL.store);
    expectDoor(fetchMock, '/api/v1/admin/vendors/vendor-1/party-phone?party=owner');
    expect(await reveal(user, 0)).toBe("Show the store's full number for Target Store?");
    expect(await screen.findByText(FULL.store)).toBeTruthy();
    expectDoor(fetchMock, '/api/v1/admin/vendors/vendor-1/party-phone?party=store');
    expect(doorCalls(fetchMock)).toHaveLength(2);
  });
});

describe('[FOLLOWUPS] a rider or driver page header', () => {
  for (const kind of ['rider', 'driver'] as const) {
    it(`${kind}: masked in the header; "Show number" reads GET /${kind}s/:id/phone`, async () => {
      const fetchMock = serve();
      const phone = kind === 'rider' ? FULL.rider : FULL.driver;
      const { user } = renderWithQuery(<MoverDetail id={`${kind}-1`} kind={kind} />);
      expect(await screen.findByText(masked(phone))).toBeTruthy();
      expect(document.body.textContent).not.toContain(phone);
      expect(document.body.textContent).toContain('Joined');
      expect(await reveal(user, 0)).toBe(`Show Test ${kind === 'rider' ? 'Rider' : 'Driver'}'s full number?`);
      expect(await screen.findByText(phone)).toBeTruthy();
      expectDoor(fetchMock, `/api/v1/admin/${kind}s/${kind}-1/phone`);
    });
  }
});

describe('[FOLLOWUPS] a custody case: the holder and the relay rider', () => {
  it('both masked; each "Show number" reads only its own party', async () => {
    const fetchMock = serve();
    const { user } = renderWithQuery(<CustodyCasesPage />);
    await user.click(await screen.findByRole('button', { name: /Order SW-77/ }));
    expect(await screen.findByText(masked(FULL.rider))).toBeTruthy();
    expect(screen.getByText(masked(FULL.relay))).toBeTruthy();
    for (const phone of [FULL.rider, FULL.relay]) expect(document.body.textContent).not.toContain(phone);
    expect(await reveal(user, 1)).toBe("Show the relay rider's full number for order SW-77?");
    await waitFor(() => expect(document.body.textContent).toContain(FULL.relay));
    expect(document.body.textContent).not.toContain(FULL.rider);
    expectDoor(fetchMock, '/api/v1/admin/custody-cases/case-1/party-phone?party=relay');
    expect(await reveal(user, 0)).toBe("Show the holding rider's full number for order SW-77?");
  });
});

// [REVIEW-F #2162 S3-1, probe P1 lifted] A revealed number belongs to a PERSON, not to a slot on the page. The custody
// page re-reads the case after every action (the reveal itself included); when the relay rider is someone else in
// that read, the old relay's full number must not sit next to the new relay's name with "Read recorded".
describe('[FOLLOWUPS] a revealed number never moves to another person', () => {
  it('custody: the relay is replaced in the next read; the new relay shows masked, never the old relay\'s full number', async () => {
    const NEW_RELAY = '+5920600107';
    let current: unknown = caseDetail;
    mockApi((request: ApiRequest): ApiReply => {
      const key = `${request.url.pathname}${request.url.search}`;
      if (request.method === 'GET' && key === '/api/v1/admin/custody-cases/case-1/party-phone?party=relay') {
        // Meanwhile ops named another relay rider: the next read of the case says so.
        current = { ...caseDetail, relayRiderId: 'rider-c', relay: { id: 'rider-c', isOnline: true, user: { firstName: 'Cy', lastName: 'Newrelay', phone: NEW_RELAY } } };
        return { body: { success: true, data: { party: 'relay', phone: FULL.relay, auditId: 'audit-1' } } };
      }
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/custody-cases') return { body: { success: true, data: [kase] } };
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/custody-cases/case-1') return { body: { success: true, data: current } };
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { user } = renderWithQuery(<CustodyCasesPage />);
    await user.click(await screen.findByRole('button', { name: /Order SW-77/ }));
    expect(await reveal(user, 1)).toBe("Show the relay rider's full number for order SW-77?");
    await waitFor(() => expect(document.body.textContent).toContain('Cy Newrelay'));
    expect(document.body.textContent).not.toContain(FULL.relay);
    expect(document.body.textContent).toContain(masked(NEW_RELAY));
    expect(screen.queryByText('Read recorded in the audit log')).toBeNull();
  });
});
