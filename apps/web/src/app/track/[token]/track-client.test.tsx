import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackClient } from './track-client';

// ---------------------------------------------------------------------------
// [E17 · DS231 F5 / DS236 F5-R1] The recipient's public tracking page on a
// parcel that could not be delivered. It names the return, and the
// door-to-door estimate — the forward leg's — is not shown for a parcel that
// is no longer coming to this door. A returned parcel is over.
// ---------------------------------------------------------------------------

function serve(status: string) {
  const view = {
    status, orderNumber: 'SW-3001', estimatedDeliveryTime: 35,
    pickupAddress: 'A', deliveryAddress: 'B', packageSize: 'SMALL', createdAt: new Date().toISOString(),
    // No position, so no map frame is embedded (a test never reaches the network).
    rider: { currentLat: null, currentLng: null, lastLocationUpdate: null, user: { firstName: 'Ravi' } },
  };
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ success: true, data: view }) })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the public tracking page on the return leg', () => {
  it('a forward parcel shows its door-to-door estimate (control)', async () => {
    serve('EN_ROUTE_DELIVERY');
    render(<TrackClient token="t-1" />);
    expect(await screen.findByText('On the way to you')).toBeTruthy();
    expect(screen.getByText('About 35 min door to door')).toBeTruthy();
  });

  it('RETURNING names the return and promises no arrival at this door', async () => {
    serve('RETURNING');
    render(<TrackClient token="t-2" />);
    expect(await screen.findByText('Going back to the sender')).toBeTruthy();
    expect(screen.queryByText(/door to door/)).toBeNull();
  });

  it('RETURNED names the outcome and is over', async () => {
    serve('RETURNED');
    render(<TrackClient token="t-3" />);
    expect(await screen.findByText('Returned to the sender')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/door to door/)).toBeNull());
  });
});
