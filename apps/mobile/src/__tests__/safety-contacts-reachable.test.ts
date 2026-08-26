import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// [S15] THE DEFECT THIS GATE EXISTS FOR WAS NOT A BUG IN ANY LINE OF CODE.
//
// `sos.service.ts` fans an ACTIVE alert out to VERIFIED emergency contacts by
// SMS — correct, careful, and covered by its own tests on the API side
// (sos-emergency-fanout: "SMSs VERIFIED contacts but never unverified ones").
// All five routes behind it were built, owner-scoped and tested. And nothing
// in the app ever called them, so the list they read was empty for every user
// on the platform: the emergency button reached ops and reached nobody who
// knows you.
//
// Every layer passed its own tests. The chain was broken BETWEEN them, which
// is precisely the failure no unit test catches. So this asserts the chain
// itself — route has a caller, screen has a route, route has a door — because
// the way this regresses is deletion by tidying, not by a wrong line.
// ---------------------------------------------------------------------------

const SRC = path.join(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('the emergency-contact chain is connected end to end [S15]', () => {
  it('every emergency-contact route has a caller in the API client', () => {
    const api = read('services/api.ts');
    // Each entry is a route the server exposes. A route listed here with no
    // caller means the safety engine is talking to itself again.
    const routes = [
      "api.get('/safety/emergency-contacts')",
      "api.post('/safety/emergency-contacts'",
      '/verify`',
      '/resend`',
      'removeEmergencyContact',
    ];
    const missing = routes.filter((r) => !api.includes(r));
    expect(missing, `no client caller for: ${missing.join(', ')}`).toEqual([]);
  });

  it('the screen is registered on the stack — an unrouted screen is unreachable', () => {
    const stack = read('navigation/CustomerStack.tsx');
    expect(stack).toContain('EmergencyContactsScreen');
    expect(stack).toContain('name="EmergencyContacts"');
  });

  it('something navigates to it — a registered screen with no door is the same bug one layer up', () => {
    const doors = walk(SRC).filter((f) => {
      if (f.includes(path.join('navigation', 'CustomerStack'))) return false;
      if (f.includes(path.join('safety', 'screens'))) return false;
      return read(path.relative(SRC, f)).includes("navigate('EmergencyContacts')");
    });
    expect(doors.length, 'no screen navigates to EmergencyContacts').toBeGreaterThan(0);
  });

  it('the verified/unverified distinction is stated in the UI, not just held in the data', () => {
    // The server REFUSES to fan out to an unverified row. If the screen does
    // not say so, a mistyped digit looks exactly like a saved contact and the
    // owner believes someone will be called who never will be.
    const screen = read('modules/safety/screens/EmergencyContactsScreen.tsx');
    expect(screen).toContain('will NOT be alerted');
    expect(screen).toMatch(/verifiedAt/);
  });
});
