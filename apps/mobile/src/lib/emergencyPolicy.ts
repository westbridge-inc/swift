// THE EMERGENCY DIAL POLICY [MOB-018] — pure, no RN imports, fully testable.
//
// Three screens dialed a hard-coded `tel:911`: right in Guyana, wrong the
// moment a configured market is not Guyana, and unknowable from the code. The
// number a person is told to dial in an emergency is a MARKET FACT that ops
// verifies (a drill on a real device, legal/operations sign-off). So:
//
//   the server serves a signed, cacheable policy per market — verified
//   numbers, per service (apps/api modules/country/emergency-policy.ts);
//   the app carries a bundled fallback for when the server cannot be reached;
//   and ONE resolution decides what the SOS surfaces do:
//     auto     a VERIFIED number: dialed immediately, first, before anything Swift-side
//     confirm  an UNVERIFIED candidate: shown with its country, dialed on an explicit tap
//     manual   nothing trustworthy: an honest manual dial sheet, never a wrong number
//
// Every decision is counted (emergency_dial_market) so a market that keeps
// landing on `manual` is visible before someone needs it.

export type EmergencyService = 'police' | 'fire' | 'ambulance';
export const EMERGENCY_SERVICES: EmergencyService[] = ['police', 'fire', 'ambulance'];

export interface EmergencyNumber {
  number: string;
  verified: boolean;
}

export type EmergencyNumbers = Partial<Record<EmergencyService, EmergencyNumber>>;

export interface EmergencyPolicy {
  country: string;
  numbers: EmergencyNumbers;
  source: 'server' | 'bundled';
  expiresAt?: string;
}

export type EmergencyDial =
  | { kind: 'auto'; country: string; number: string; service: EmergencyService; source: EmergencyPolicy['source'] }
  | { kind: 'confirm'; country: string; number: string; service: EmergencyService; source: EmergencyPolicy['source'] }
  | { kind: 'manual'; country: string | null };

const NUMBER_RE = /^\+?[0-9]{2,15}$/;

/**
 * The offline fallback. GUYANA is the launch market and its police number is
 * what the app has always dialed. Every other entry is a widely published
 * national number that ops has NOT yet verified for Swift: offered with a
 * confirm, never auto-dialed, until the server's policy marks it verified.
 * Add a market here only with its source; never guess a number.
 */
export const BUNDLED_EMERGENCY_POLICIES: Readonly<Record<string, EmergencyNumbers>> = Object.freeze({
  GY: { police: { number: '911', verified: true }, fire: { number: '912', verified: false }, ambulance: { number: '913', verified: false } },
  TT: { police: { number: '999', verified: false }, fire: { number: '990', verified: false }, ambulance: { number: '811', verified: false } },
  JM: { police: { number: '119', verified: false }, fire: { number: '110', verified: false }, ambulance: { number: '110', verified: false } },
  BB: { police: { number: '211', verified: false }, fire: { number: '311', verified: false }, ambulance: { number: '511', verified: false } },
  SR: { police: { number: '115', verified: false }, fire: { number: '110', verified: false }, ambulance: { number: '113', verified: false } },
});

export function bundledPolicyFor(country: string | null | undefined): EmergencyPolicy | null {
  const code = (country ?? '').toUpperCase();
  const numbers = BUNDLED_EMERGENCY_POLICIES[code];
  return numbers ? { country: code, numbers, source: 'bundled' } : null;
}

/** The API's `/public/emergency-policy` payload, validated; anything malformed or expired is not a policy. */
export function parseServedPolicy(raw: unknown, now = Date.now()): EmergencyPolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1 || typeof r['country'] !== 'string' || !/^[A-Z]{2}$/.test(r['country'])) return null;
  if (typeof r['expiresAt'] !== 'string') return null;
  const expires = Date.parse(r['expiresAt']);
  if (!Number.isFinite(expires) || expires <= now) return null;
  const sig = r['signature'];
  if (!sig || typeof sig !== 'object' || typeof (sig as Record<string, unknown>)['kid'] !== 'string' || typeof (sig as Record<string, unknown>)['value'] !== 'string') return null;
  const nums = r['numbers'];
  if (!nums || typeof nums !== 'object' || Array.isArray(nums)) return null;
  const numbers: EmergencyNumbers = {};
  for (const service of EMERGENCY_SERVICES) {
    const entry = (nums as Record<string, unknown>)[service];
    if (entry === undefined || entry === null) continue;
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e['number'] !== 'string' || !NUMBER_RE.test(e['number']) || typeof e['verified'] !== 'boolean') return null;
    numbers[service] = { number: e['number'], verified: e['verified'] };
  }
  if (Object.keys(numbers).length === 0) return null;
  return { country: r['country'], numbers, source: 'server', expiresAt: r['expiresAt'] };
}

/** The policy in force for a market: the server's (for that market, unexpired) wins; else the bundle; else nothing. */
export function policyFor(country: string | null | undefined, served: EmergencyPolicy | null, now = Date.now()): EmergencyPolicy | null {
  const code = (country ?? '').toUpperCase();
  if (served && served.country === code && (!served.expiresAt || Date.parse(served.expiresAt) > now)) return served;
  return bundledPolicyFor(code);
}

/** What the SOS surface does for a service in a market. Verified auto-dials; unverified asks; nothing trustworthy is a manual sheet. */
export function resolveEmergencyDial(policy: EmergencyPolicy | null, service: EmergencyService = 'police'): EmergencyDial {
  if (!policy) return { kind: 'manual', country: null };
  const entry = policy.numbers[service];
  if (!entry || !NUMBER_RE.test(entry.number)) return { kind: 'manual', country: policy.country };
  return entry.verified
    ? { kind: 'auto', country: policy.country, number: entry.number, service, source: policy.source }
    : { kind: 'confirm', country: policy.country, number: entry.number, service, source: policy.source };
}

/** A tel: URL from a dial decision's number — digits and a leading + only. */
export function telUrl(number: string): string {
  return `tel:${number.replace(/[^0-9+]/g, '')}`;
}

// ---------------------------------------------------------------------------
// On-device counters: emergency_dial_market, sos_transition_mismatch and
// sos_location_evidence. Reasons and bands only — never a coordinate.
// ---------------------------------------------------------------------------

const counters = { dial: new Map<string, number>(), transition: new Map<string, number>(), location: new Map<string, number>() };
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export function recordEmergencyDial(dial: EmergencyDial): void {
  bump(counters.dial, `${dial.country ?? 'none'}:${dial.kind}${dial.kind === 'manual' ? '' : `:${dial.source}`}`);
}

/** The client expected one status and the server answered another (or nothing usable). */
export function recordSosTransition(expected: string, actual: string): void {
  bump(counters.transition, `${expected}->${actual}`);
}

export type LocationAccuracyBand = 'none' | 'under_50m' | 'under_250m' | 'over_250m' | 'unknown_accuracy';

export function locationAccuracyBand(coords: { accuracyM?: number | null } | undefined): LocationAccuracyBand {
  if (!coords) return 'none';
  const a = coords.accuracyM;
  if (a == null || !Number.isFinite(a)) return 'unknown_accuracy';
  if (a < 50) return 'under_50m';
  if (a < 250) return 'under_250m';
  return 'over_250m';
}

export function recordSosLocation(band: LocationAccuracyBand): void {
  bump(counters.location, band);
}

export function emergencyCounters(): { dial: Record<string, number>; transition: Record<string, number>; location: Record<string, number> } {
  return { dial: Object.fromEntries(counters.dial), transition: Object.fromEntries(counters.transition), location: Object.fromEntries(counters.location) };
}

export function resetEmergencyCountersForTests(): void {
  counters.dial.clear();
  counters.transition.clear();
  counters.location.clear();
}
