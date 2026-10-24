import { describe, it, expect } from 'vitest';
import { channelDelivered, sosReachedAnyone } from '../modules/safety/delivery-proof';

// [F-028-06] The proof oracle produced two S0 false positives in a row by
// re-deriving "seems delivered" locally. These tests pin the corrected rules.

describe('sosReachedAnyone', () => {
  it('an ALL-FAILED contact list is not a delivery — the exact F-028-06 case', () => {
    // Production writes one {ok:false} entry per failed emergency-contact SMS.
    // The old oracle judged arrays by LENGTH, so "every text bounced" read as
    // a successful channel and the receipt claimed help was reached.
    const receipts = {
      opsPaged: 0,
      socketListeners: 0,
      contacts: [{ id: 'c1', ok: false }, { id: 'c2', ok: false }],
    };
    expect(sosReachedAnyone(receipts, 0)).toBe(false);
  });

  it('one successful SMS among failures IS a delivery', () => {
    const receipts = { opsPaged: 0, contacts: [{ id: 'c1', ok: false }, { id: 'c2', ok: true }] };
    expect(sosReachedAnyone(receipts, 0)).toBe(true);
  });

  it('war-room MEMBERSHIP counts for nothing — no shipped client listens', () => {
    // socketListeners counts sockets in the room. No client in web, mobile,
    // admin, or the desktop ops console (which polls REST and has no socket
    // layer) has a handler for sos:active — a logged-in socket can sit in the
    // room while the app discards the event. Membership ≠ delivery.
    expect(channelDelivered('socketListeners', 7)).toBe(false);
    expect(sosReachedAnyone({ socketListeners: 7 }, 0)).toBe(false);
  });

  it('an ops page that REACHED people is a delivery — opsPaged counts accepted pushes and on-call texts', () => {
    expect(sosReachedAnyone({ opsPaged: 3, socketListeners: 0 }, 0)).toBe(true);
  });

  it('[AUD-L8b-008 · AUD-G7-003] inbox rows, addressed responders and re-page attempts count for nothing', () => {
    // An ops page writes one inbox row per responder whether or not any push
    // or text went out; `recipients` is who it was addressed to; `repages` is
    // how many re-pages were attempted. None of them is a person told.
    for (const key of ['opsInbox', 'recipients', 'repages']) expect(channelDelivered(key, 4), key).toBe(false);
    expect(sosReachedAnyone({ opsPaged: 0, opsInbox: 4, socketListeners: 2, repages: 1 }, 0)).toBe(false);
    expect(sosReachedAnyone({ opsPaged: 0, opsPushed: 0, oncallTexted: 0, opsInbox: 4, recipients: 4, opsAlertId: 'x' }, 0)).toBe(false);
    expect(sosReachedAnyone({ opsPaged: 1, opsInbox: 4 }, 0)).toBe(true);
  });

  it('string receipts are reasons, never deliveries', () => {
    expect(sosReachedAnyone({ contacts: 'skipped:guardian-default' }, 0)).toBe(false);
  });

  it('a total failure reads as a total failure (the F-027-16 case stays closed)', () => {
    expect(sosReachedAnyone({ opsPaged: 0, socketListeners: 0 }, 0)).toBe(false);
    expect(sosReachedAnyone({}, 0)).toBe(false);
    expect(sosReachedAnyone(null, 0)).toBe(false);
  });

  it('persisted notices count independently of receipts', () => {
    expect(sosReachedAnyone(null, 2)).toBe(true);
  });
});
