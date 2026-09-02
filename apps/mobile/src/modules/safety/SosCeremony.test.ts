import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [MOB-018] The SOS ceremony renders SERVER facts and dials the MARKET's
// number. This test reads the component's source, the way the scanner and
// navigator tests do (the mobile suite renders nothing native), and pins the
// contracts a later edit could quietly undo:
//   - no hard-coded emergency number; the dial comes from the market policy,
//     and only a VERIFIED number is dialed without a tap;
//   - confirm and cancel take their resulting status from the server's answer,
//     never from the button that was pressed;
//   - only a real 409 SOS_NOT_CANCELLABLE means "too late — help is being
//     reached"; every other failure is UNKNOWN, an unreachable server OFFLINE;
//   - the paged copy never claims a live map; it says what was attached.
// ---------------------------------------------------------------------------

const SRC = readFileSync(new URL('./SosCeremony.tsx', import.meta.url), 'utf8');
const STRIPPED = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const between = (from: string, to: string) => {
  const a = STRIPPED.indexOf(from); const b = STRIPPED.indexOf(to, a + 1);
  expect(a, from).toBeGreaterThan(-1); expect(b, to).toBeGreaterThan(a);
  return STRIPPED.slice(a, b);
};

describe('the dial is the market’s, never a literal', () => {
  it('imports the one dial policy and never names a number', () => {
    expect(STRIPPED).toContain("from '../../services/emergencyPolicy'");
    expect(STRIPPED).toContain('emergencyDialFor(country');
    expect(STRIPPED).not.toMatch(/tel:\d/);
    expect(STRIPPED).not.toMatch(/['"`]911['"`]/);
  });
  it('dials without a tap ONLY when the decision is auto (a verified number)', () => {
    const raise = between('const startRaise = () => {', 'const pageNow = () => {');
    expect(raise).toContain("if (decision.kind === 'auto') void openExternal(telUrl(decision.number)");
    expect(raise).not.toMatch(/kind === 'confirm'\) void openExternal/);
    const dialNow = between('const dialNow = () => {', 'const startRaise = () => {');
    expect(dialNow).toContain("if (decision.kind === 'manual') return;");
    // the copy names the decision, and an unverified candidate gets its own explicit button
    expect(STRIPPED).toContain('{emergencyDialCopy(dial)}');
    expect(STRIPPED).toContain("dial.kind === 'confirm' ? (");
    expect(STRIPPED).toContain('label={`Dial ${dial.number}`}');
  });
});

describe('every rendered state is the server’s', () => {
  it('confirm takes the status from the response, records a mismatch, and never assumes ACTIVE', () => {
    const page = between('const pageNow = () => {', 'const cancelAlert = () => {');
    expect(page).toContain('const status = serverStatus(data);');
    expect(page).toContain("recordSosTransition('ACTIVE', 'UNKNOWN')");
    expect(page).toContain("setOutcome('confirm-unknown')");
    expect(page).not.toMatch(/setAlert\(\{ \.\.\.alert, status: 'ACTIVE' \}\)/);
    // the error path is UNKNOWN or OFFLINE, never a paged state
    const onError = page.slice(page.indexOf('onError:'));
    expect(onError).toContain("isOffline(err) ? 'offline' : 'confirm-unknown'");
    expect(onError).not.toContain("status: 'ACTIVE'");
    expect(onError).not.toContain('setAlert(');
  });
  it('cancel treats ONLY a 409 SOS_NOT_CANCELLABLE as too-late; anything else is unknown or offline', () => {
    const cancel = between('const cancelAlert = () => {', 'const live = alert');
    expect(cancel).toContain('if (isSosNotCancellable(err)) {');
    const helper = between('function isSosNotCancellable(err: unknown): boolean {', 'export function SosCeremony(');
    expect(helper).toContain('err.response?.status === 409');
    expect(helper).toContain("=== 'SOS_NOT_CANCELLABLE'");
    // the ACTIVE inference exists only inside the 409 branch
    const branch = cancel.slice(cancel.indexOf('if (isSosNotCancellable(err)) {'), cancel.indexOf('return;', cancel.indexOf('if (isSosNotCancellable(err)) {')));
    expect(branch).toContain("setAlert({ ...alert, status: 'ACTIVE' })");
    const after = cancel.slice(cancel.indexOf('return;', cancel.indexOf('if (isSosNotCancellable(err)) {')));
    expect(after).not.toContain("status: 'ACTIVE'");
    expect(after).toContain("setOutcome(isOffline(err) ? 'offline' : 'cancel-unknown')");
    // a successful cancel is CANCELLED only when the server says so
    expect(cancel).toContain("if (status === 'CANCELLED') { setAlert({ ...alert, status: 'CANCELLED' }); return; }");
  });
  it('serverStatus admits only the five real statuses; isOffline is "no response at all"', () => {
    const status = between('function serverStatus(data: unknown)', 'function isOffline(err: unknown): boolean {');
    expect(status).toContain('SOS_STATUSES as readonly string[]).includes(status)');
    expect(STRIPPED).toContain("['TRIGGER_PENDING', 'ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED']");
    const offline = between('function isOffline(err: unknown): boolean {', 'function isSosNotCancellable');
    expect(offline).toContain('isAxiosError(err) && !err.response');
  });
});

describe('the paged copy is honest about the evidence', () => {
  it('never claims a live map; it states what was attached, by accuracy band, or that nothing was', () => {
    expect(STRIPPED).not.toMatch(/live map/i);
    expect(STRIPPED).toContain('No location could be attached');
    expect(STRIPPED).toContain("attached === 'under_50m'");
    expect(STRIPPED).toContain("attached === 'over_250m'");
    const raise = between('const startRaise = () => {', 'const pageNow = () => {');
    expect(raise).toContain('const band = locationAccuracyBand(coords);');
    expect(raise).toContain('recordSosLocation(band);');
    expect(raise).toContain('setAttached(band);');
  });
  it('an unreachable server on the raise is said out loud as OFFLINE', () => {
    expect(STRIPPED).toContain("You appear to be offline — Swift was NOT alerted.");
    const raise = between('const startRaise = () => {', 'const pageNow = () => {');
    expect(raise).toContain("if (isOffline(err)) setOutcome('offline')");
  });
});
