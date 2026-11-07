import { describe, expect, it } from 'vitest';
import { customerTimeline, withoutPositionEvidence } from '../modules/order/customer-timeline';

// ---------------------------------------------------------------------------
// [REVIEW-G2 S4-1 on #2080] The custody relay's handoff note was written with its own position format
// ("… — GPS 6.80000,-58.15000"), which the customer's timeline cut did not know, so a customer read the relay
// rider's handoff position. The note now uses the one ' — gps:' form; rows already written in the old form
// (staging, any copy) are cut too.
// ---------------------------------------------------------------------------

const AT = new Date('2026-10-25T12:00:00Z');

describe('the customer never reads a mover\'s recorded position, in any form a note has carried it', () => {
  it.each([
    ["Custody handed to a relay rider — holder's handoff code verified — GPS 6.80000,-58.15000", "Custody handed to a relay rider — holder's handoff code verified"],
    ["Custody handed to a relay rider — holder's handoff code verified — GPS -6.80000,58.15000", "Custody handed to a relay rider — holder's handoff code verified"],
    ["Custody handed to a relay rider — holder's handoff code verified — gps:6.80000,-58.15000", "Custody handed to a relay rider — holder's handoff code verified"],
    ['Rider picked up — gps:6.80448,-58.15527 (12 m from the store)', 'Rider picked up'],
    ['Arrived at stop 1 — no GPS fix on file', 'Arrived at stop 1'],
  ])('%s', (note, shown) => {
    expect(withoutPositionEvidence(note)).toBe(shown);
    expect(customerTimeline([{ status: 'PICKED_UP', note, createdAt: AT }])).toEqual([{ status: 'PICKED_UP', note: shown, timestamp: AT }]);
  });

  it('a note that merely mentions GPS in words keeps its words', () => {
    for (const note of ['GPS was off on the phone, the rider called ahead', 'Rider confirmed — GPS signal weak in the building']) {
      expect(withoutPositionEvidence(note)).toBe(note);
    }
  });
});
