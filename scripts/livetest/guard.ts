// The journey suite's target guard [TASK-057]. The suite signs accounts in
// with the dev OTP code and then places orders, moves money records and
// suspends users, so it REFUSES to start unless every gate below holds, and
// every refusal happens before its first write:
//
//   (a) the target is private: a loopback or RFC 1918 address, or a single-
//       label service name (the Docker service `api-journeys`) that resolves
//       only to such addresses. The public hostname (LIVETEST_PUBLIC_HOST,
//       plus the known Swift domains) and every dotted DNS name are refused by
//       name, before any lookup or connection.
//   (b) GET /api/v1/test-control/identity answers: first unauthenticated (401
//       proves the route exists; production never registers it, so it answers
//       404 and the run stops without signing anyone in), then as the seed
//       admin, and the database declares an environment that is not
//       production. Optional pins (LIVETEST_EXPECT_DEPLOYMENT_ID,
//       LIVETEST_EXPECT_ENVIRONMENT, LIVETEST_EXPECT_BUILD_SHA) must match
//       exactly.
//   (c) the declared data classification is `synthetic`.
//   (p) every phone the suite creates, files or sends to is one no subscriber
//       can hold: +5920… (a 0 after +592 is never a subscriber number). The
//       shared worker serves this instance with the PUBLIC provider settings,
//       so once real SMS is on (Phase B) a live number would be texted — OTPs,
//       SOS alerts to an "emergency contact". The single exception is the
//       Ofcom drama range (+447700900xxx), used only to prove the non-Guyana
//       refusal and never sent a message.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type Gate = 'a' | 'b' | 'c' | 'p';

export class TargetRefused extends Error {
  constructor(public readonly gate: Gate, message: string) {
    super(message);
    this.name = 'TargetRefused';
  }
}

/** Never a Guyana subscriber: +592 followed by 0 and six digits. */
export const FICTIONAL_GY = /^\+5920\d{6}$/;
/** Ofcom's reserved drama numbers (07700 900000–900999): never allocated to anyone. */
export const FICTIONAL_NON_GY = /^\+447700900\d{3}$/;

/** Gate (p): refuse if any phone the suite would use could reach a real person. */
export function refuseLivePhones(phones: Iterable<string>, allowNonGy: Iterable<string> = []): void {
  const nonGy = new Set(allowNonGy);
  const live = [...phones].filter((p) => !FICTIONAL_GY.test(p) && !(nonGy.has(p) && FICTIONAL_NON_GY.test(p)));
  if (live.length > 0) {
    throw new TargetRefused('p', `these phones could belong to real people (only +5920… may be used): ${[...new Set(live)].join(', ')}`);
  }
}

export interface TargetIdentity {
  deploymentId: string;
  environment: string;
  buildSha: string;
  dataClassification: string;
  testTenant: string;
}

/** Public Swift names, refused whatever LIVETEST_PUBLIC_HOST says. */
const PUBLIC_SUFFIXES = ['swiftgy.com', 'swift.gy'];

function v4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function v6Private(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1') return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Private(mapped[1]!);
  return /^f[cd][0-9a-f]{2}:/.test(s); // fc00::/7 unique-local
}

/** Loopback or private (RFC 1918 / ULA) address literal. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Private(ip);
  if (kind === 6) return v6Private(ip);
  return false;
}

/**
 * Gate (a), by name only — no lookup, no connection. Returns the hostname
 * that still needs its addresses checked (a single-label service name), or
 * null when the literal address was already proven private.
 */
export function refusePublicName(rawUrl: string, env: Record<string, string | undefined> = process.env): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TargetRefused('a', `LIVETEST_BASE_URL is not a URL: ${JSON.stringify(rawUrl)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TargetRefused('a', `unsupported protocol ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  const publicHost = (env['LIVETEST_PUBLIC_HOST'] ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (publicHost && host === publicHost) {
    throw new TargetRefused('a', `${host} is the public API hostname; the suite runs only against the private api-journeys instance`);
  }
  if (PUBLIC_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    throw new TargetRefused('a', `${host} is a public Swift domain; the suite runs only against the private api-journeys instance`);
  }
  if (isIP(host)) {
    if (!isPrivateAddress(host)) throw new TargetRefused('a', `${host} is not a loopback or private address`);
    return null;
  }
  if (host.includes('.')) {
    throw new TargetRefused('a', `${host} is a DNS name; the private instance is reached by its service name (api-journeys) or a private address`);
  }
  return host;
}

/** Gate (a), complete: a service name must resolve to private addresses only. */
export async function refusePublicTarget(
  rawUrl: string,
  env: Record<string, string | undefined> = process.env,
  resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address),
): Promise<void> {
  const host = refusePublicName(rawUrl, env);
  if (host === null) return;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new TargetRefused('a', `${host} does not resolve`);
  }
  if (addresses.length === 0 || !addresses.every(isPrivateAddress)) {
    throw new TargetRefused('a', `${host} resolves to a non-private address (${addresses.join(', ') || 'none'})`);
  }
}

interface Http {
  get(path: string, token?: string): Promise<{ status: number; json: any }>;
}

/** Gates (b) and (c). `signIn` runs only after the unauthenticated probe proved the route exists. */
export async function refuseUnsafeIdentity(
  http: Http,
  signIn: () => Promise<string>,
  env: Record<string, string | undefined> = process.env,
): Promise<TargetIdentity> {
  const probe = await http.get('/test-control/identity');
  if (probe.status === 404) {
    throw new TargetRefused('b', 'the target does not serve /test-control/identity (production, or TEST_CONTROL_ENABLED is off): not the private journeys instance');
  }
  if (probe.status !== 401) {
    throw new TargetRefused('b', `the unauthenticated identity probe answered ${probe.status}, expected 401`);
  }
  let token: string;
  try {
    token = await signIn();
  } catch (e: any) {
    throw new TargetRefused('b', `could not sign in the seed admin through the private instance's dev OTP code: ${e?.message ?? e}`);
  }
  const res = await http.get('/test-control/identity', token);
  const id = res.json?.data;
  if (res.status !== 200 || !id) {
    throw new TargetRefused('b', `/test-control/identity answered ${res.status} to an authenticated caller`);
  }
  const environment = String(id.environment ?? '');
  if (!environment || environment === 'unknown') {
    throw new TargetRefused('b', 'the database declares no deployment identity (deployment_identity singleton missing)');
  }
  if (environment.toLowerCase() === 'production') {
    throw new TargetRefused('b', 'the target declares environment=production; production is never a journeys target');
  }
  const pins: Array<[string, string]> = [
    ['LIVETEST_EXPECT_DEPLOYMENT_ID', 'deploymentId'],
    ['LIVETEST_EXPECT_ENVIRONMENT', 'environment'],
    ['LIVETEST_EXPECT_BUILD_SHA', 'buildSha'],
  ];
  for (const [name, field] of pins) {
    const want = env[name];
    if (want && String(id[field]) !== want) {
      throw new TargetRefused('b', `${field}: the target says ${String(id[field])}, ${name} expects ${want}`);
    }
  }
  if (id.dataClassification !== 'synthetic') {
    throw new TargetRefused('c', `data classification is ${JSON.stringify(id.dataClassification)}, not synthetic`);
  }
  return {
    deploymentId: String(id.deploymentId),
    environment,
    buildSha: String(id.buildSha ?? 'unknown'),
    dataClassification: String(id.dataClassification),
    testTenant: String(id.testTenant ?? ''),
  };
}
