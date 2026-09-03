import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import AccountPage from './page';
import { renderWithQuery } from '@/test/test-utils';
import * as moverApi from '@/lib/mover-api';

// ---------------------------------------------------------------------------
// [W-31] A DRIVER'S PAY LINK IS WHERE THEIR EARNINGS LAND.
//
// The API stages a new link behind a cool-off with the OLD one still taking
// money (ALG-34), and returns `mmgPayUrl`, `mmgPayUrlPending` and
// `mmgPayUrlApplyAt` so a client can say so. The portal rendered none of them:
// it prefilled one editable box, said "Saved ✓", and left the driver believing
// their earnings had moved when they had not — for hours.
//
// It also never offered the "this wasn't me" cancel the API has always had, so
// a driver who saw a change they did not make had nowhere to go.
// ---------------------------------------------------------------------------

const LIVE = 'https://pay.mmg.gy/d/live-account';
const PENDING = 'https://pay.mmg.gy/d/new-account';

function driverProfile(over: Record<string, unknown> = {}) {
  return {
    id: 'driver-1',
    user: { firstName: 'Ann', lastName: 'Driver', phone: '+5926000001' },
    mmgPayUrl: LIVE,
    mmgPayUrlPending: null,
    mmgPayUrlApplyAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(moverApi, 'getRiderProfile').mockResolvedValue(null as never);
  vi.spyOn(moverApi, 'getDriverProfile').mockResolvedValue(driverProfile() as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('[W-31] the pay link says where the money actually goes', () => {
  it('states the link that is taking money RIGHT NOW', async () => {
    renderWithQuery(<AccountPage />);
    expect(await screen.findByText(/Paying into now/)).toBeTruthy();
    expect(screen.getByText(LIVE)).toBeTruthy();
  });

  it('a staged change says the money has NOT moved, and when it will', async () => {
    vi.spyOn(moverApi, 'getDriverProfile').mockResolvedValue(driverProfile({
      mmgPayUrlPending: PENDING,
      mmgPayUrlApplyAt: '2026-09-04T14:00:00.000Z',
    }) as never);
    renderWithQuery(<AccountPage />);

    expect(await screen.findByText(/your money has NOT moved yet/)).toBeTruthy();
    expect(screen.getByText(PENDING)).toBeTruthy();
    expect(screen.getByText(/every payment still goes to the link above/)).toBeTruthy();
  });

  it('offers the "this wasn’t me" cancel the API has always had', async () => {
    const cancel = vi.spyOn(moverApi, 'cancelPendingMmgPayUrl').mockResolvedValue({} as never);
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.spyOn(moverApi, 'getDriverProfile').mockResolvedValue(driverProfile({ mmgPayUrlPending: PENDING }) as never);
    const user = userEvent.setup();
    renderWithQuery(<AccountPage />);

    await user.click(await screen.findByRole('button', { name: /This wasn’t me/ }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it('changing where the money goes asks first, and names both ends', async () => {
    const update = vi.spyOn(moverApi, 'updateDriverProfile').mockResolvedValue({} as never);
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const user = userEvent.setup();
    renderWithQuery(<AccountPage />);

    const box = await screen.findByPlaceholderText('https://pay.mmg.gy/…');
    await user.clear(box);
    await user.type(box, PENDING);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(PENDING));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(LIVE));
    // Declined — nothing was sent.
    expect(update).not.toHaveBeenCalled();
  });

  it('with no link at all it says riders cannot pay, rather than showing an empty box and nothing else', async () => {
    vi.spyOn(moverApi, 'getDriverProfile').mockResolvedValue(driverProfile({ mmgPayUrl: null }) as never);
    renderWithQuery(<AccountPage />);
    expect(await screen.findByText(/riders cannot pay you by MMG/)).toBeTruthy();
  });
});
