import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [M-28] A cash courier job closes on its cash outcome — in the app too.
//
// The server refuses a bare proof on an unpaid cash job (a proof never
// implies money): sender-pays answers PAYMENT_NOT_CAPTURED until the collect
// step records the fee at pickup; recipient-pays answers OUTCOME_REQUIRED
// until the outcome and the rider's location travel with the proof. These
// pin the seams that make the app do exactly that, and that nothing offers
// the old bare proof or the generic door handover for a courier:
//
//   client: courierApi.proof posts a body (photo + optional outcome + GPS);
//           courierApi.collect posts the sender's outcome + GPS
//   hook:   the proof hook sends the CALLER's outcome on the evidence fix,
//           never a default; the collect hook rides the same fix
//   screen: sender-pays → a collect step before custody ('paid' / 'refused');
//           recipient-pays → the proof carries 'paid', the unpaid sheet routes
//           the courier's failed outcomes into the proof capture; the courier
//           branch precedes the generic cash door
//
// Comments are stripped first so a phrase in a comment can never satisfy an
// assertion about code (the hazard-matching rule).
// ---------------------------------------------------------------------------

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const COURIER = strip(readFileSync(new URL('./courier.ts', import.meta.url), 'utf8'));
const MOVER = strip(readFileSync(new URL('./mover.ts', import.meta.url), 'utf8'));
const API = strip(readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8'));
const SCREEN = strip(readFileSync(new URL('../modules/mover/screens/ActiveJobScreen.tsx', import.meta.url), 'utf8'));

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  expect(to, `anchor not found: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('the stripper', () => {
  it('leaves code behind', () => {
    expect(COURIER.length).toBeGreaterThan(2_000);
    expect(API.length).toBeGreaterThan(5_000);
    expect(SCREEN.length).toBeGreaterThan(5_000);
    expect(COURIER).toContain('export function useCourierProof');
    expect(COURIER).toContain('export function useCourierCollect');
  });
});

describe('the client', () => {
  const courierApi = body(API, 'export const courierApi', '\n};');
  it('the proof posts a body that can carry the outcome and GPS — no bare-url signature remains', () => {
    expect(courierApi).toContain('`/courier/order/${id}/proof`, body, capturedAuthConfig(session)');
    expect(courierApi).toContain("body: { proofPhotoUrl: string; outcome?: 'paid' | 'no_show' | 'refused'; gps?: { lat: number; lng: number } }");
    expect(courierApi).not.toContain('{ proofPhotoUrl }, capturedAuthConfig');
  });
  it("the sender's fee is collected through its own route with the outcome and GPS", () => {
    expect(courierApi).toContain('`/courier/order/${id}/collect`, body, capturedAuthConfig(session)');
    expect(courierApi).toContain("body: { outcome: 'paid' | 'refused'; gps: { lat: number; lng: number } }");
  });
});

describe('the proof hook', () => {
  const hook = body(COURIER, 'export function useCourierProof', 'export function useCourierCollect');
  it("sends the caller's outcome with the evidence fix — and the photo alone when no outcome is given", () => {
    expect(hook).toContain('outcome?: CourierCashOutcome');
    expect(hook).toContain('const fix = await evidenceFix(owner)');
    expect(hook).toContain('body = { proofPhotoUrl: url, outcome, gps: fix.gps }');
    expect(hook).toContain('courierApi.proof(orderId, body, current)');
    expect(hook).not.toContain("outcome ?? 'paid'");
    expect(hook).not.toContain("outcome: 'paid'");
  });
  it('re-proves the auth principal after the wait, like every cash step', () => {
    expect(hook).toContain('requireAuthSessionForPrincipal(owner)');
    expect(MOVER).toContain('export async function evidenceFix(owner: AuthSessionSnapshot)');
    expect(COURIER).toContain("import { evidenceFix } from './mover'");
  });
});

describe('the collect hook', () => {
  const hook = body(COURIER, 'export function useCourierCollect', '\n}\n');
  it("posts the sender's outcome on the evidence fix", () => {
    expect(hook).toContain("{ orderId: string; outcome: 'paid' | 'refused' }");
    expect(hook).toContain('const { gps, current } = await evidenceFix(owner)');
    expect(hook).toContain('courierApi.collect(orderId, { outcome, gps }, current)');
  });
});

describe('the screen', () => {
  it('reads who pays and whether the fee is captured from server truth, never a default', () => {
    expect(SCREEN).toContain("const courierCash = isCourier && job?.paymentMethod === 'CASH'");
    expect(SCREEN).toContain("const feeCaptured = job?.paymentStatus === 'CAPTURED'");
    expect(SCREEN).toContain("const senderFeeDue = courierCash && job?.courierPayer === 'SENDER' && !feeCaptured");
    expect(SCREEN).toContain("const recipientFeeDue = courierCash && job?.courierPayer !== 'SENDER' && !feeCaptured");
  });
  it('sender pays → the collect step stands before custody, with both outcomes named', () => {
    const collect = body(SCREEN, 'const collectFromSender', 'const closeRating');
    expect(collect).toContain('courierCollect.mutate(');
    expect(collect).toContain('{ orderId: job.id, outcome }');
    expect(SCREEN).toContain("bigButton(`Collected ${courierFee} from the sender`, () => collectFromSender('paid')");
    expect(SCREEN).toContain("onPress={() => collectFromSender('refused')}");
    expect(SCREEN).toContain('label="Sender didn\'t pay"');
    expect(SCREEN).toContain('label="Sender refused to pay"');
  });
  it("recipient pays → the door's proof carries 'paid'; the failed outcomes route into the proof capture", () => {
    expect(SCREEN).toContain("() => captureCourierProof('paid')");
    expect(SCREEN).toContain('label="Recipient didn\'t pay"');
    const record = body(SCREEN, 'const recordUnpaid', 'const collectFromSender');
    expect(record).toContain('else if (isCourier) void captureCourierProof(outcome)');
    const capture = body(SCREEN, 'const captureCourierProof', 'const markDelivered');
    expect(capture).toContain("async (outcome?: 'paid' | FailedOutcome)");
    expect(capture).toContain('{ orderId: job.id, uri: shot.assets[0].uri, outcome, authSession: owner ?? undefined }');
  });
  it('the courier branch precedes the generic cash door, so a courier never reaches the bare handover', () => {
    const courierDoor = SCREEN.indexOf(') : isCourier ? (');
    const mmgDoor = SCREEN.indexOf(') : isMmgPaid ? (');
    expect(courierDoor).toBeGreaterThan(-1);
    expect(mmgDoor).toBeGreaterThan(courierDoor);
    // The generic cash door's tap is the rider's handover; it lives after the courier branch.
    const cashTap = SCREEN.indexOf("riderAct.mutate({ id: job.id, action: 'handover' })");
    expect(cashTap).toBeGreaterThan(mmgDoor);
    // The already-paid courier door sends the photo alone.
    expect(SCREEN).toContain("bigButton('Capture proof & deliver', () => captureCourierProof(), { loading: courierProof.isPending, disabled: busy })");
  });
  it('the unpaid sheet speaks to the courier in its own words on the same two outcomes', () => {
    expect(SCREEN).toContain("isCourier ? 'The recipient didn’t pay?'");
    expect(SCREEN).toContain("isCourier ? 'Nobody there'");
    expect(SCREEN).toContain("recordUnpaid('refused')");
    expect(SCREEN).toContain("recordUnpaid('no_show')");
  });
});
