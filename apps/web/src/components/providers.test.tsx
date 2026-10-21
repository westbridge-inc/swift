import { render, screen } from '@testing-library/react';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { Providers } from './providers';

// ---------------------------------------------------------------------------
// [UI-SWEEP U22] A query started offline is PAUSED by default: not loading,
// not failed, no data. The console pages read that as empty ("No items
// match.", "No earner profile on this account"). The consoles' provider makes
// an offline request fail instead, so every page shows its "Couldn't load"
// state; the customer site keeps the default.
// ---------------------------------------------------------------------------

function Probe() {
  const q = useQuery({ queryKey: ['probe'], queryFn: () => Promise.reject(new TypeError('Failed to fetch')), retry: false });
  return <p>{q.isError ? 'failed' : q.fetchStatus}</p>;
}

afterEach(() => { onlineManager.setOnline(true); });

describe('[U22] an offline read in a console fails; it never pauses into "empty"', () => {
  it('the consoles\' provider: offline, the read fails', async () => {
    onlineManager.setOnline(false);
    render(<Providers offline="fail"><Probe /></Providers>);
    expect(await screen.findByText('failed')).toBeTruthy();
  });

  it('control: the default provider pauses it (the customer site keeps this)', async () => {
    onlineManager.setOnline(false);
    render(<Providers><Probe /></Providers>);
    expect(await screen.findByText('paused')).toBeTruthy();
  });
});
