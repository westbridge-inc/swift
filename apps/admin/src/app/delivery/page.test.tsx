import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DeliveryPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [RIDER-SAFE 5/6] The Delivery screen: free riders vs waiting orders, Swift's
// delivery pause (a reason, sent with the version the screen showed; the
// switch is only shown changed once the server says so), and the late orders,
// each opening its order. Synthetic zones and orders only.
// ---------------------------------------------------------------------------

const REASON = 'Two riders left in the south this evening';
const ZONES = [{ id: 'zone-a', name: 'Zone A' }, { id: 'zone-b', name: 'Zone B' }];
type Write = { body: Record<string, unknown>; reason: string | null };

function server(opts: { pause?: Record<string, unknown>; reply?: (_w: Write) => { status: number; body: unknown }; breaches?: unknown; failBreaches?: boolean } = {}) {
  let pause = { platform: false, zoneIds: [] as string[], version: 3, updatedBy: 'u1', updatedAt: '2026-10-29T15:00:00Z', zones: ZONES, ...opts.pause };
  const writes: Write[] = [];
  mockApi((r: ApiRequest) => {
    if (r.url.pathname === '/api/v1/admin/dashboard/overview') return { body: { success: true, data: { riderSupply: { freeRiders: 2, waitingForRider: 7 } } } };
    if (r.url.pathname === '/api/v1/admin/orders/sla-breaches') {
      if (opts.failBreaches) return { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'down' } } };
      return { body: { success: true, scanned: 3, truncated: false, data: opts.breaches ?? [] } };
    }
    if (r.url.pathname === '/api/v1/admin/delivery-pause' && r.method === 'GET') return { body: { success: true, data: pause } };
    if (r.url.pathname === '/api/v1/admin/delivery-pause' && r.method === 'PUT') {
      const w = { body: JSON.parse(String(r.init?.body)), reason: new Headers(r.init?.headers).get('x-swift-reason') };
      writes.push(w);
      const answer = opts.reply?.(w);
      if (answer) return answer;
      pause = { ...pause, platform: w.body['platform'] as boolean, zoneIds: w.body['zoneIds'] as string[], version: pause.version + 1 };
      return { body: { success: true, data: pause } };
    }
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
  return { writes };
}

async function answerPanel(user: ReturnType<typeof renderWithQuery>['user'], confirm: string) {
  const panel = await screen.findByRole('dialog');
  await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
  await user.click(within(panel).getByRole('button', { name: confirm }));
  return panel;
}

describe('[RIDER-SAFE 5/6] the Delivery screen', () => {
  it('shows free riders beside the orders waiting for one', async () => {
    server();
    renderWithQuery(<DeliveryPage />);
    expect(await screen.findByText(/orders waiting for a rider/)).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('pausing everywhere asks why, sends the reason and the version it showed, and shows the pause only from the server', async () => {
    const { writes } = server();
    const { user } = renderWithQuery(<DeliveryPage />);
    expect(await screen.findByText('Delivery is open.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Pause delivery everywhere' }));
    await answerPanel(user, 'Pause delivery everywhere');
    expect(writes).toEqual([{ body: { platform: true, zoneIds: [], expectedVersion: 3, reason: REASON }, reason: REASON }]);
    expect(await screen.findByText('Delivery is paused everywhere.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open delivery everywhere' })).toBeTruthy();
  });

  it('a zone is paused on its own; a stale screen is refused in the server words and nothing is shown changed', async () => {
    const { writes } = server({ reply: (w) => (w.body['zoneIds'] as string[]).includes('zone-b')
      ? { status: 409, body: { success: false, error: { code: 'PAUSE_CHANGED', message: 'Someone else changed the delivery pause. Refresh and try again.' } } }
      : undefined as never });
    const { user } = renderWithQuery(<DeliveryPage />);
    await user.click(await screen.findByRole('button', { name: 'Pause delivery in Zone A' }));
    await answerPanel(user, 'Pause delivery in Zone A');
    expect(writes[0]!.body).toMatchObject({ platform: false, zoneIds: ['zone-a'], expectedVersion: 3 });
    expect(await screen.findByText('Delivery is paused in Zone A.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Pause delivery in Zone B' }));
    const panel = await answerPanel(user, 'Pause delivery in Zone B');
    expect(await within(panel).findByText('Someone else changed the delivery pause. Refresh and try again.')).toBeTruthy();
    expect(screen.getByText('Delivery is paused in Zone A.')).toBeTruthy();
  });

  it('late orders open their order and speak in words; a failed read is never "nothing late"', async () => {
    server({ breaches: [{ orderId: 'o1', orderNumber: 'SW-1001', vendorId: 'v1', status: 'READY_FOR_PICKUP', openStage: 'PICKUP_WAIT', breached: true, stages: [], worstOverMs: 14 * 60_000 }] });
    const { unmount } = renderWithQuery(<DeliveryPage />);
    const link = await screen.findByRole('link', { name: '#SW-1001' });
    expect(link.getAttribute('href')).toBe('/orders/o1');
    const row = link.closest('tr')!;
    expect(within(row).getByText('Ready, waiting for a rider')).toBeTruthy();
    expect(within(row).getByText('14 min over')).toBeTruthy();
    expect(within(row).queryByText('READY_FOR_PICKUP')).toBeNull();
    unmount();
    server({ failBreaches: true });
    renderWithQuery(<DeliveryPage />);
    expect(await screen.findByText(/the late orders/)).toBeTruthy();
    expect(screen.queryByText('No delivery order is past its time.')).toBeNull();
  });
});
