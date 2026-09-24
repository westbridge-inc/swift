import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { SosRow } from '../lib/safetyView';
import Safety from './Safety';

// ---------------------------------------------------------------------------
// [PRIV2-S1] The war-room card is the ONLY screen a responder has for a live
// SOS. The note a person types when they press SOS mid-ride ("he has a knife
// now") lives in ops-only records — the alert and its repeat-press rows — and
// never on the order timeline the other person on the ride reads. So if the
// card does not show it, nobody who can act ever reads it. These render the
// console against the feed the server returns and read the card back.
// ---------------------------------------------------------------------------

const feed = vi.hoisted(() => ({ alerts: [] as unknown[] }));

vi.mock('../lib/api', () => ({
  fetchSosAlerts: vi.fn(async () => feed.alerts),
  fetchIncidents: vi.fn(async () => []),
  fetchOpsAlerts: vi.fn(async () => []),
  ackSosAlert: vi.fn(),
  resolveSosAlert: vi.fn(),
  incidentAction: vi.fn(),
  decideIncident: vi.fn(),
  fetchEvidenceForCase: vi.fn(),
  evidenceAction: vi.fn(),
  ackOpsAlert: vi.fn(),
  raiseIncident: vi.fn(),
}));

const T0 = '2026-09-24T02:10:00.000Z';
const T1 = '2026-09-24T02:12:30.000Z';
const T2 = '2026-09-24T02:13:00.000Z';
/** Exactly how the card formats a time, so the assertion does not depend on the machine's locale. */
const time = (iso: string) => new Date(iso).toLocaleTimeString();

const alert = (over: Partial<SosRow> = {}): SosRow => ({
  id: 'sos-1', actorUserId: 'u-passenger', actorRole: 'CUSTOMER', status: 'ACTIVE', orderId: 'ride-1',
  triggeredAt: T0, triggerSource: 'BUTTON', triggerLat: 6.80744, triggerLng: -58.16188, triggerAddressText: null,
  triggerNote: null, retriggers: null, userSafeFlaggedAt: null, acknowledgedAt: null, retriggerCount: 0, ...over,
});

function renderSafety(alerts: SosRow[]) {
  feed.alerts = alerts;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(<QueryClientProvider client={client}><Safety /></QueryClientProvider>);
}

describe('the war-room card shows what the person said', () => {
  it('renders the trigger note first, then each repeat press that carried words, each with its time, above the position', async () => {
    renderSafety([alert({
      triggerNote: 'being followed',
      retriggerCount: 2,
      retriggers: [
        { seq: 1, at: T1, note: 'he has a knife now', lat: 6.808, lng: -58.162 },
        { seq: 2, at: T2, note: null, lat: 6.809, lng: -58.163 },
      ],
    })]);

    const said = await screen.findByLabelText('What they said');
    const items = within(said).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toHaveLength(2);
    expect(items[0]!.textContent).toContain('being followed');
    expect(items[0]!.textContent).toContain(time(T0));
    expect(items[1]!.textContent).toContain('he has a knife now');
    expect(items[1]!.textContent).toContain(time(T1));
    // The press that said nothing is not shown as a message; the badge counts it.
    expect(said.textContent).not.toContain(time(T2));
    expect(screen.getByText('asked again ×2')).toBeTruthy();

    // The words come BEFORE the position: a responder reads what happened
    // before they read where. The position is still there.
    const position = screen.getByText('6.80744, -58.16188');
    expect(said.compareDocumentPosition(position) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('No message was typed.')).toBeNull();
  });

  it('an alert raised without words says so, rather than leaving a responder to guess whether the card is hiding them', async () => {
    // The shipped app's SOS button sends a position and no note — most alerts
    // look like this, and the absence has to be legible as an absence.
    renderSafety([alert()]);
    expect(await screen.findByText('No message was typed.')).toBeTruthy();
    expect(screen.queryByLabelText('What they said')).toBeNull();
  });

  it('renders the note as text: a note that looks like markup never becomes markup', async () => {
    const hostile = '<img src=x onerror="document.title=\'pwned\'"><script>document.title="pwned"</script> he has a knife';
    const { container } = renderSafety([alert({ triggerNote: hostile })]);
    const said = await screen.findByLabelText('What they said');
    expect(said.textContent).toContain(hostile);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(document.title).not.toBe('pwned');
  });

  it('says how many earlier presses the bounded summary no longer carries', async () => {
    // The server keeps the newest presses in the alert's summary; the count on
    // the alert is the truth. Showing 20 of 25 without saying so would let a
    // responder believe they had read everything the person said.
    const newest20 = Array.from({ length: 20 }, (_, i) => ({ seq: i + 6, at: T1, note: i === 19 ? 'still here' : null }));
    renderSafety([alert({ triggerNote: 'help me', retriggerCount: 25, retriggers: newest20 })]);
    const said = await screen.findByLabelText('What they said');
    expect(within(said).getAllByRole('listitem').map((li) => li.textContent)).toHaveLength(2);
    expect(await screen.findByText('5 earlier repeat presses are not shown here.')).toBeTruthy();
  });
});
