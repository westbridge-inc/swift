import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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

// [CALL-RELAY-ON · owner 6 Nov 2026] Guyana networks show only the number: the page says which number Swift calls
// from (the server's), with Copy and a contact card to save it as Swift. Nothing while the bridge is off.
describe('[CALL-RELAY-ON] the caller line under "Call via Swift"', () => {
  const NANP = { data: { enabled: true, callerId: '+18785550123' } };
  beforeEach(() => { resetCallConfigForTests(); apiFetch.mockReset(); });

  it('bridge on: the line, Copy, and Save contact (a vCard of Swift\'s number)', async () => {
    apiFetch.mockResolvedValue(NANP);
    render(<CallPartyButton orderId="o1" target="rider" phone={null} label="Call rider" />);
    expect(await screen.findByText('Swift calls you from +1 878 555 0123 (save it as Swift).')).toBeTruthy();
    const save = screen.getByRole('link', { name: 'Save Swift as a contact' });
    expect(save.getAttribute('download')).toBe('Swift.vcf');
    expect(decodeURIComponent(save.getAttribute('href')!.replace(/^data:text\/vcard;charset=utf-8,/, ''))).toContain('TEL;TYPE=VOICE:+18785550123');
    expect(screen.getByRole('button', { name: "Copy Swift's call number" })).toBeTruthy();
  });

  it('Copy writes the number itself and says so; a browser that refuses gets told how to copy by hand', async () => {
    apiFetch.mockResolvedValue(NANP);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CallPartyButton orderId="o1" target="rider" phone={null} label="Call rider" />);
    fireEvent.click(await screen.findByRole('button', { name: "Copy Swift's call number" }));
    expect(writeText).toHaveBeenCalledWith('+18785550123');
    expect(await screen.findByText('Number copied. Save it in your contacts as Swift.')).toBeTruthy();
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: "Copy Swift's call number" }));
    expect(await screen.findByText('Select the number to copy it.')).toBeTruthy();
  });

  it('two buttons on one page show the line once when asked (the store desk)', async () => {
    apiFetch.mockResolvedValue(NANP);
    render(
      <>
        <CallPartyButton orderId="o1" target="customer" phone={null} label="Call" icon={false} ariaLabel="Call Ana" />
        <CallPartyButton orderId="o1" target="rider" phone={null} label="Call" icon={false} ariaLabel="Call the rider" callerLine={false} />
      </>,
    );
    await screen.findByRole('button', { name: 'Call the rider via Swift' });
    expect(screen.getAllByText(/^Swift calls you from/)).toHaveLength(1);
  });

  it('bridge off: today\'s tel: link, no line, no copy, no card', async () => {
    apiFetch.mockResolvedValue({ data: { enabled: false, callerId: null } });
    render(<CallPartyButton orderId="o1" target="rider" phone="+5920600001" label="Call rider" />);
    expect(await screen.findByRole('link', { name: /Call rider/ })).toBeTruthy();
    expect(screen.queryByText(/Swift calls you from/)).toBeNull();
    expect(screen.queryByRole('button', { name: "Copy Swift's call number" })).toBeNull();
  });
});
