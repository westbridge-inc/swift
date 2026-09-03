import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { LocationField } from './location-field';
import type { PickedPlace } from '@/lib/place';
import * as customer from '@/lib/customer';

// ---------------------------------------------------------------------------
// [W-18 / W-19] THE TEXT IN THE BOX IS THE PLACE, OR THERE IS NO PLACE.
//
// The taxi form kept the two apart: pick a destination, edit the visible text
// without choosing again, and it submitted the OLD coordinates — a driver sent
// to the address the passenger had just replaced, while the screen showed the
// new one. The courier form had the same defect and its own copy of this box.
//
// One field now, and typing invalidates the selection. These drive the field
// the way a person does, and assert on what the PARENT is told to submit.
// ---------------------------------------------------------------------------

const LAMAHA = { placeId: 'p-lamaha', primary: '42 Lamaha Street', secondary: 'Georgetown', lat: 6.81, lng: -58.16 };
// No coordinates on the suggestion, so choosing it MUST fetch the details —
// which is the path where the lookup can fail and leave a name with nothing
// behind it.
const CAMP = { placeId: 'p-camp', primary: '9 Camp Road', secondary: 'Georgetown' };

function Harness({ onState }: { onState: (_t: string, _p: PickedPlace | null) => void }) {
  const [text, setText] = useState('');
  const [place, setPlace] = useState<PickedPlace | null>(null);
  return (
    <LocationField
      label="Where to?"
      text={text}
      place={place}
      onChange={(t, p) => { setText(t); setPlace(p); onState(t, p); }}
    />
  );
}

beforeEach(() => {
  vi.spyOn(customer, 'placesAutocomplete').mockResolvedValue([LAMAHA, CAMP] as never);
  vi.spyOn(customer, 'placeDetails').mockResolvedValue({ lat: LAMAHA.lat, lng: LAMAHA.lng } as never);
});
afterEach(() => vi.restoreAllMocks());

describe('[W-18] the box and the pin cannot disagree', () => {
  it('choosing a suggestion gives the parent the point AND the words that named it', async () => {
    const user = userEvent.setup();
    const onState = vi.fn();
    render(<Harness onState={onState} />);

    await user.type(screen.getByPlaceholderText('Search address…'), '42 Lam');
    await user.click(await screen.findByRole('button', { name: /42 Lamaha Street/ }));

    await waitFor(() => {
      const [text, place] = onState.mock.calls.at(-1)!;
      expect(text).toBe('42 Lamaha Street');
      expect(place).toMatchObject({ label: '42 Lamaha Street', lat: LAMAHA.lat, lng: LAMAHA.lng });
    });
  });

  it('EDITING the text after choosing drops the point — the exact W-18 defect', async () => {
    const user = userEvent.setup();
    const onState = vi.fn();
    render(<Harness onState={onState} />);

    await user.type(screen.getByPlaceholderText('Search address…'), '42 Lam');
    await user.click(await screen.findByRole('button', { name: /42 Lamaha Street/ }));
    await waitFor(() => expect(onState.mock.calls.at(-1)![1]).not.toBeNull());

    // One more character is enough: the box no longer names the chosen place.
    await user.type(screen.getByPlaceholderText('Search address…'), 'x');
    await waitFor(() => {
      const [text, place] = onState.mock.calls.at(-1)!;
      expect(text).toBe('42 Lamaha Streetx');
      expect(place, 'the old coordinates must not survive an edit').toBeNull();
    });
  });

  it('clearing the box clears the point', async () => {
    const user = userEvent.setup();
    const onState = vi.fn();
    render(<Harness onState={onState} />);

    await user.type(screen.getByPlaceholderText('Search address…'), '42 Lam');
    await user.click(await screen.findByRole('button', { name: /42 Lamaha Street/ }));
    await waitFor(() => expect(onState.mock.calls.at(-1)![1]).not.toBeNull());

    await user.clear(screen.getByPlaceholderText('Search address…'));
    await waitFor(() => expect(onState.mock.calls.at(-1)![1]).toBeNull());
  });

  it('the box shows the text and nothing else — a cleared address never reappears', async () => {
    const user = userEvent.setup();
    render(<Harness onState={() => {}} />);
    const box = screen.getByPlaceholderText('Search address…') as HTMLInputElement;

    await user.type(box, '42 Lam');
    await user.click(await screen.findByRole('button', { name: /42 Lamaha Street/ }));
    await waitFor(() => expect(box.value).toBe('42 Lamaha Street'));

    await user.clear(box);
    expect(box.value).toBe('');
  });

  it('a failed details lookup leaves NO point behind the name, and says so', async () => {
    vi.spyOn(customer, 'placeDetails').mockRejectedValue(new Error('places down'));
    const user = userEvent.setup();
    const onState = vi.fn();
    render(<Harness onState={onState} />);

    await user.type(screen.getByPlaceholderText('Search address…'), '9 Camp');
    await user.click(await screen.findByRole('button', { name: /9 Camp Road/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // The name is in the box; there is nothing behind it, and the parent knows.
    expect(onState.mock.calls.at(-1)![1]).toBeNull();
  });
});
