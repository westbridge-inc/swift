import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// MKT-F057 — the rider asks for the customer's delivery PIN at the door on
// BOTH goods rails (MMG "Mark delivered" and cash "Record cash & hand over",
// the DoorCash flow since row 56), and never displays the value it verifies.
//
// Read as source (the mobile Vitest harness has no RN renderer, same as
// pin-gate.test.ts). The server is the authority: MISSING_PIN / INVALID_PIN /
// MAX_ATTEMPTS return as error toasts, so the buttons must NOT be disabled on
// an empty entry — a legacy order without a PIN completes without one, and a
// new order's missing PIN surfaces as the server's own refusal.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREEN = strip(readFileSync(new URL('./ActiveJobScreen.tsx', import.meta.url), 'utf8'));
// [L02 · row 56] The cash door's statement flow (amount, review, confirm).
const DOOR_CASH = strip(readFileSync(new URL('../DoorCash.tsx', import.meta.url), 'utf8'));

describe('the rider door PIN ceremony [MKT-F057]', () => {
  it('asks for the customer code with the same 6-digit CodeInput the driver ceremony uses', () => {
    expect(SCREEN).toMatch(/const doorPinCeremony = \(/);
    expect(SCREEN).toMatch(/Ask \{custName \?\? 'the customer'\} for their delivery code/);
    expect(SCREEN.match(/length=\{RIDE_PIN_LENGTH\}/g)?.length).toBeGreaterThanOrEqual(2); // driver + rider doors
  });

  it('puts the ceremony on both goods doors — MMG and cash', () => {
    expect(SCREEN.match(/\{doorPinCeremony\}/g)).toHaveLength(2);
  });

  it('sends the entered PIN with both completion actions', () => {
    // MMG: PUT /delivered
    expect(SCREEN).toMatch(/action: 'delivered', pin/);
    // Cash: POST /handover (the paid outcomes) — the screen hands the typed code
    // to the cash door, which sends it with every hand-over statement
    // (behaviour: ActiveJobScreen.doorCash.navigation.test.ts).
    expect(SCREEN).toMatch(/<DoorCash[^>]*\bpin=\{pin\}/);
    expect(SCREEN).toMatch(/submit=\{\(fields, handlers\) => riderAct\.mutate\(\{ id: job\.id, action: 'handover', \.\.\.fields, handoverVersion: door\.version \?\? undefined \}, handlers\)\}/);
    expect(DOOR_CASH).toMatch(/\{ \.\.\.fields, \.\.\.\(fields\.outcome === 'paid' && pin \? \{ pin \} : \{\}\) \}/);
  });

  it('never disables the door on an empty PIN — the server answers MISSING_PIN, and legacy orders complete', () => {
    expect(SCREEN).toMatch(/bigButton\(deliverLabel, markDelivered, \{ loading: riderAct\.isPending \|\| courierProof\.isPending, disabled: busy \}\)/);
    // Cash: the door opens on busy only (never on the code); its refusals of
    // the code come back through the screen's onPinRefused.
    expect(DOOR_CASH).toMatch(/label="Record cash & hand over"\s+testID="door-cash-paid"\s+disabled=\{busy\}/);
    expect(SCREEN).toMatch(/onDoorRefused=\{onPinRefused\}/);
  });

  it('surfaces PIN refusals through the input error state', () => {
    // [L02 · row 56] Only a refusal OF THE CODE marks the boxes; a cash-amount
    // refusal at the same door is answered in its own popup (behaviour:
    // ActiveJobScreen.doorCash.navigation.test.ts).
    expect(SCREEN).toMatch(/error=\{pinRefused\}/);
    expect(SCREEN).toMatch(/const pinRefused = riderAct\.isError && DOOR_CODE_REFUSALS\.has\(/);
  });

  it('surfaces the server refusal words as a toast — MISSING_PIN / INVALID_PIN / MAX_ATTEMPTS', () => {
    expect(SCREEN).toMatch(/body\?\.code === 'MISSING_PIN' \|\| body\?\.code === 'INVALID_PIN' \|\| body\?\.code === 'MAX_ATTEMPTS'/);
    expect(SCREEN).toMatch(/toast\.error\(body\.message \?\? /);
    // The toast carries the server's words — never the value the rider verified.
    expect(SCREEN).not.toMatch(/toast\.error\(pin/);
  });

  it('forgets a typed code when the displayed job changes — a stop A guess can never burn a stop B attempt', () => {
    // The stop-selector tap clears the box, and a job-id keyed effect catches
    // the paths that bypass the tap: a leg dropped from the run (the
    // legs.find(...) ?? legs[0] fallback) or a refetch swapping the live job.
    expect(SCREEN).toMatch(/setSelectedLegId\(leg\.id\); setPin\(''\);/);
    expect(SCREEN).toMatch(/useEffect\(\(\) => \{\s*setPin\(''\);\s*\}, \[job\?\.id\]\);/);
  });

  it('never displays the PIN value the rider verifies', () => {
    // The job payload omits the code (server-side HANDOVER_SECRETS_OMIT), and
    // nothing on this screen renders it: the rider's OWN entry is the only
    // PIN-shaped value here, and it is sent, never displayed.
    expect(SCREEN).not.toMatch(/job\.ridePin\b/);
    expect(SCREEN).not.toMatch(/\{ridePin\}/);
  });

  it('the failed outcomes (no_show / refused) never carry the PIN', () => {
    const outcomeLines = SCREEN
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes("action: 'handover', outcome"));
    // The driver and rider unpaid sheets both record the failed outcome.
    expect(outcomeLines.length).toBeGreaterThanOrEqual(2);
    for (const line of outcomeLines) expect(line).not.toMatch(/ridePin/);
  });
});
