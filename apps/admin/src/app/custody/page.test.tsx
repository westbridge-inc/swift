import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CustodyCasesPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// [AF-MOB-006] The operations half of a custody case: the console lists open
// cases, shows who holds the goods and the honest money line, and every
// decision it sends carries the operator's own stated reason.

const kase = {
  id: 'case-1', orderId: 'order-1', state: 'SUPPORT_HOLD', reason: 'VEHICLE_BREAKDOWN', reasonNote: 'chain snapped',
  ownerUserId: null, holderRiderId: 'rider-a', relayRiderId: null, deadlineAt: '2026-10-05T12:00:00.000Z',
  escalationCount: 1, resolvedAt: null, createdAt: '2026-10-05T11:50:00.000Z', overdue: true,
  order: { orderNumber: 'SW-77', status: 'EN_ROUTE_DELIVERY', paymentMethod: 'MOBILE_MONEY', vendor: { name: 'Roti Hut' } },
};
const detail = {
  ...kase,
  order: { ...kase.order, id: 'order-1', subtotalBase: 3000, floatAttached: 0 },
  holder: { id: 'rider-a', isOnline: true, user: { firstName: 'Ana', lastName: 'Rider', phone: '+5926000000' } },
  relay: null,
  trail: [{ action: 'CUSTODY_CASE_OPENED', userId: 'u1', changes: { actorRole: 'RIDER' }, createdAt: '2026-10-05T11:50:00.000Z' }],
};

function handler(request: ApiRequest) {
  if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/custody-cases') return { body: { success: true, data: [kase] } };
  if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/custody-cases/case-1') return { body: { success: true, data: detail } };
  if (request.method === 'POST' && request.url.pathname === '/api/v1/admin/custody-cases/case-1/direct') {
    return { body: { success: true, data: { caseId: 'case-1', state: 'RELAY_REQUIRED', version: 1 } } };
  }
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
}

describe('custody cases console', () => {
  it('lists the open case as overdue and shows the holder and the MMG truth', async () => {
    mockApi(handler);
    const { user } = renderWithQuery(<CustodyCasesPage />);
    expect(await screen.findByText('OVERDUE')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Order SW-77/ }));
    expect(await screen.findByText(/Ana Rider/)).toBeTruthy();
    expect(screen.getByText(/Swift never holds order money/)).toBeTruthy();
    expect(screen.getByText(/opened/)).toBeTruthy();
  });

  it('a decision carries the operator’s reason, and a cancelled panel sends nothing', async () => {
    const fetchMock = mockApi(handler);
    const { user } = renderWithQuery(<CustodyCasesPage />);
    await user.click(await screen.findByRole('button', { name: /Order SW-77/ }));
    const relayButton = await screen.findByRole('button', { name: 'Relay to another rider' });
    await user.click(relayButton);
    let panel = await screen.findByRole('dialog');
    await user.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
    await user.click(relayButton);
    panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('Relay to another rider for order SW-77?');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), '  Rider cannot move, nearest rider is two minutes away  ');
    await user.click(within(panel).getByRole('button', { name: 'Relay to another rider' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(String(url)).toContain('/api/v1/admin/custody-cases/case-1/direct');
    expect(JSON.parse(String(init?.body))).toEqual({ outcome: 'RELAY_REQUIRED' });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe('Rider cannot move, nearest rider is two minutes away');
  });
});
