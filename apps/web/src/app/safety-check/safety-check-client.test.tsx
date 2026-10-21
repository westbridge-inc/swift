import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafetyCheckClient, parseSafetyCheckLink } from './safety-check-client';

// [WEB-TAXI · owner 21 Oct 2026] Trip Guardian's texted answer link: a rider
// no push reached answers the waiting check-in here, without signing in. The
// secret is after the '#' and goes to the API only with the answer.

const REF = 'cmh0sessionid0000000001';
const SECRET = 'AbCdEfGhIjKlMnOpQrStUv';

function at(hash: string) {
  window.history.replaceState(null, '', `/safety-check${hash}`);
}
const fetchAnswering = (status: number) => vi.fn().mockResolvedValue(new Response(JSON.stringify(status === 200 ? { success: true, data: {} } : { success: false }), { status }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); at(''); });

describe('the link', () => {
  it('is <check>.<secret> after the #, nothing else', () => {
    expect(parseSafetyCheckLink(`#${REF}.${SECRET}`)).toEqual({ ref: REF, secret: SECRET });
    expect(parseSafetyCheckLink('')).toBeNull();
    expect(parseSafetyCheckLink(`#${REF}`)).toBeNull();
    expect(parseSafetyCheckLink(`#${REF}.short`)).toBeNull();
    expect(parseSafetyCheckLink(`#${REF}.${SECRET}<script>`)).toBeNull();
  });
});

describe('the page', () => {
  it('asks the phone’s question and sends the answer with the link, to the public answer endpoint', async () => {
    at(`#${REF}.${SECRET}`);
    const fetchMock = fetchAnswering(200);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<SafetyCheckClient />);
    expect(await screen.findByRole('heading', { name: 'Everything okay?' })).toBeTruthy();
    expect(screen.getByText('Swift’s Trip Guardian checks in when a trip pauses or changes route. Your driver can’t see your answer.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'I’m okay' }));
    expect(await screen.findByText('Thanks — Swift has your answer')).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/v1\/safety\/public\/checkin$/);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ ref: REF, secret: SECRET, response: 'OK' });
    expect((init as RequestInit).credentials).toBeUndefined(); // no session rides along
  });

  it('I need help: Swift is alerted and the police line is the next step', async () => {
    at(`#${REF}.${SECRET}`);
    vi.stubGlobal('fetch', fetchAnswering(200));
    const user = userEvent.setup();
    render(<SafetyCheckClient />);
    await user.click(await screen.findByRole('button', { name: 'I need help' }));
    expect(await screen.findByText('Swift’s safety team has been alerted')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Call 911' }).getAttribute('href')).toBe('tel:911');
  });

  it('a distress answer that did not send says so, leads with the police, and can be sent again', async () => {
    at(`#${REF}.${SECRET}`);
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(new Response('{"success":true,"data":{}}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<SafetyCheckClient />);
    await user.click(await screen.findByRole('button', { name: 'I need help' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Swift was NOT alerted — your answer didn’t send.Call 911 now, then try again.');
    await user.click(screen.getByRole('button', { name: 'I need help' }));
    expect(await screen.findByText('Swift’s safety team has been alerted')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a closed check (or a bad link) is said plainly, with the police line', async () => {
    at(`#${REF}.${SECRET}`);
    vi.stubGlobal('fetch', fetchAnswering(404));
    const user = userEvent.setup();
    render(<SafetyCheckClient />);
    await user.click(await screen.findByRole('button', { name: 'I’m okay' }));
    expect(await screen.findByText('This safety check is already closed')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Call 911' })).toBeTruthy();
  });

  it('an incomplete link sends nothing and points to the police line', async () => {
    at('#nope');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<SafetyCheckClient />);
    expect(await screen.findByText('This safety check link is not complete')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Call 911' })).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
