import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// [O-1 · REVIEW-F #2092] The website's Call control with the call switch ON (it ships OFF).
const apiFetch = vi.fn();
vi.mock('@/lib/auth', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiRequestError: class ApiRequestError extends Error { code?: string },
}));

import { CallPartyButton } from './call-party-button';
import { CALL_WORDS, fetchCallConfig, resetCallConfigForTests } from '@/lib/call-bridge';

const ON = { data: { enabled: true, callerId: '+15005550006' } };

describe('[O-1] the call switch, as the website remembers it (S4-2)', () => {
  beforeEach(() => { resetCallConfigForTests(); apiFetch.mockReset(); });

  it('a failed read is not remembered: the next ask gets the switch', async () => {
    apiFetch.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(ON);
    expect(await fetchCallConfig()).toBeNull();
    expect(await fetchCallConfig()).toEqual({ enabled: true, callerId: '+15005550006' });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('a good answer is kept for a few minutes; two asks at once share one request', async () => {
    apiFetch.mockResolvedValue(ON);
    await Promise.all([fetchCallConfig(), fetchCallConfig()]);
    await fetchCallConfig();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await fetchCallConfig(Date.now() + 5 * 60_000 + 1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});

describe('[O-1] "Call via Swift" buttons say whom they call (S4-3)', () => {
  beforeEach(() => { resetCallConfigForTests(); apiFetch.mockReset(); apiFetch.mockResolvedValue(ON); });

  it('two buttons on the store desk have two different accessible names', async () => {
    render(
      <>
        <CallPartyButton orderId="o1" target="customer" phone={null} label="Call" icon={false} ariaLabel="Call Ana" />
        <CallPartyButton orderId="o1" target="rider" phone={null} label="Call" icon={false} ariaLabel="Call the rider" />
      </>,
    );
    expect(await screen.findByRole('button', { name: 'Call Ana via Swift' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Call the rider via Swift' })).toBeTruthy();
    // what the eye reads is unchanged
    expect(screen.getAllByText(CALL_WORDS.viaSwift)).toHaveLength(2);
  });

  it('without an ariaLabel the visible words are the name', async () => {
    render(<CallPartyButton orderId="o1" target="rider" phone={null} label="Call rider" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Call via Swift/ })).toBeTruthy());
  });
});

describe('[O-1] after a tap (S4-1)', () => {
  it('says only what is true for every app: both phones show Swift’s number', () => {
    expect(CALL_WORDS.started).toContain('Both phones show Swift’s number.');
    expect(CALL_WORDS.started).not.toMatch(/neither/i);
  });
});
