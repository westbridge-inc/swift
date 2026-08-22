/**
 * ELV-2 A10 — PERFORMANCE SNAPSHOT (numbers, not vibes).
 *
 * The protocol asks for a "before" baseline that Part 10 must beat. Half of it
 * is device-side (cold start, TTI, map FPS) and needs the app on a judge
 * device; half is server-side and measurable right now, repeatably, from the
 * running rig. This script does the server-side half properly rather than
 * leaving the whole of A10 blocked on a device session:
 *
 *   · p50 / p95 / max latency on the hot paths, measured not estimated;
 *   · the +80ms RTT judge applied as a STATED adjustment, never baked in —
 *     raw and judged are both printed, because a number you cannot
 *     decompose is not a baseline;
 *   · response payload bytes per endpoint (the protocol's "image payload
 *     sizes on home/store" starts here — the JSON is what carries the URLs
 *     and the counts).
 *
 * Honesty rules this script follows:
 *   · a non-2xx response is NEVER folded into a latency number. An endpoint
 *     that 401s fast would otherwise look like the fastest thing we ship.
 *   · warm-up requests are discarded explicitly and the count is printed, so
 *     nobody has to wonder whether cold JIT is in the sample.
 *   · every endpoint reports its sample size. A p95 over 5 samples is not a
 *     p95 and will be labelled as such.
 *
 * Run: BASELINE_API=http://localhost:3020/api/v1 \
 *      DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/a10-perf-snapshot.ts
 */
import { PrismaClient } from '@prisma/client';

const A = process.env['BASELINE_API'] ?? 'http://localhost:3000/api/v1';
const HEALTH = A.replace('/api/v1', '') + '/health';
const prisma = new PrismaClient();
const CUSTOMER_PHONE = '+5925566001';

/** The device judge's added round trip, per the protocol. Applied as a stated
 *  adjustment to the reported figure — never mixed into the measurement. */
const JUDGE_RTT_MS = 80;
/** Discarded before measuring, so cold JIT/pool warm-up is out of the sample. */
const WARMUP = 3;
/** A p95 needs a real sample. Below this it is reported as an estimate. */
const MIN_SAMPLE_FOR_P95 = 20;
const SAMPLES = Number(process.env['A10_SAMPLES'] ?? 20);
/** The product's global ceiling. The harness paces itself from THIS rather
 *  than from a guessed delay — the first paced attempt used 120ms picked by
 *  feel and still tripped the limiter, because what matters is total requests
 *  per minute across the whole run, not the gap between two of them. */
const RATE_CEILING_PER_MIN = Number(process.env['RATE_LIMIT_MAX'] ?? 200);
/** Endpoints measured below; used to size the pace. Keep in sync. */
const ENDPOINT_COUNT = 14;
/** Stay at ~70% of the ceiling: enough headroom that a retry or a stray
 *  request cannot push the run over. */
const PACE_MS = Number(
  process.env['A10_PACE_MS']
  ?? Math.ceil((ENDPOINT_COUNT * (SAMPLES + WARMUP)) / (RATE_CEILING_PER_MIN * 0.7) * 60_000 / (ENDPOINT_COUNT * (SAMPLES + WARMUP))),
);

function log(step: string, detail: unknown = '') {
  console.log(`${new Date().toISOString()} · ${step}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function http(method: string, path: string, body?: unknown, token?: string) {
  const started = process.hrtime.bigint();
  const res = await fetch(`${A}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { status: res.status, ms, bytes: Buffer.byteLength(text), text };
}

const pickToken = (j: any): string | undefined =>
  j?.data?.tokens?.accessToken ?? j?.data?.tokens?.token ?? j?.data?.token ?? j?.data?.accessToken;

async function loginByOtp(phone: string): Promise<string> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await http('POST', '/auth/send-otp', { phone });
    const v = await http('POST', '/auth/verify-otp', { phone, code: '000000' });
    const t = pickToken(JSON.parse(v.text || '{}'));
    if (t) return t;
    if (attempt === 6) throw new Error(`no token for ${phone}`);
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error('unreachable');
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

interface Row {
  name: string;
  method: string;
  path: string;
  auth: boolean;
  n: number;
  errors: number;
  p50: number;
  p95: number;
  max: number;
  bytes: number;
  /** Every status seen, so "not measured" always says WHY. */
  statuses: Map<number, number>;
}

async function measure(name: string, method: string, path: string, token?: string): Promise<Row> {
  for (let i = 0; i < WARMUP; i++) await http(method, path, undefined, token);
  const times: number[] = [];
  const statuses = new Map<number, number>();
  let errors = 0;
  let bytes = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const r = await http(method, path, undefined, token);
    statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    // A non-2xx is not a latency sample. An endpoint that 401s in 2ms would
    // otherwise be reported as the fastest thing we ship.
    if (r.status >= 200 && r.status < 300) {
      times.push(r.ms);
      bytes = Math.max(bytes, r.bytes);
    } else {
      errors += 1;
    }
    // The harness must not measure ITSELF. The first run of this script fired
    // ~33 requests per endpoint back to back, exhausted the customer rate-limit
    // budget partway down the list, and reported the last four endpoints as
    // "not measured" — as though THEY were the problem. They return 200 on a
    // hand probe. A load generator that trips a limiter and then blames the
    // endpoint is measuring its own impatience.
    if (PACE_MS > 0) await new Promise((r2) => setTimeout(r2, PACE_MS));
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    name,
    method,
    path,
    auth: !!token,
    n: times.length,
    errors,
    statuses,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1]! : NaN,
    bytes,
  };
}

const ms = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)}ms` : 'n/a');
const kb = (v: number) => `${(v / 1024).toFixed(1)}KB`;

async function main() {
  const h = await fetch(HEALTH).then((r) => r.status).catch(() => 0);
  if (h !== 200) throw new Error(`rig not healthy (${h})`);

  const token = await loginByOtp(CUSTOMER_PHONE);
  const vendor = await prisma.vendor.findFirst({ where: { status: 'ACTIVE', isVerified: true }, select: { id: true, slug: true } });
  if (!vendor) throw new Error('no ACTIVE verified vendor on the rig — the store paths cannot be measured honestly');
  log('measuring', { samples: SAMPLES, warmupDiscarded: WARMUP, judgeRttMs: JUDGE_RTT_MS, vendor: vendor.slug });

  const rows: Row[] = [];
  // Public / unauthenticated — the SEO surface and the guest funnel.
  rows.push(await measure('public storefront directory', 'GET', '/public/storefronts'));
  rows.push(await measure('public storefront page', 'GET', `/public/storefronts/${vendor.slug}`));
  rows.push(await measure('countries picker', 'GET', '/auth/countries'));
  rows.push(await measure('pricing', 'GET', '/auth/pricing'));
  // Authenticated customer hot paths — the ones a person hits every session.
  rows.push(await measure('customer home', 'GET', '/customer/home', token));
  rows.push(await measure('vendor list', 'GET', '/customer/vendors', token));
  rows.push(await measure('vendor detail (store page)', 'GET', `/customer/vendors/${vendor.id}`, token));
  rows.push(await measure('vendor reviews', 'GET', `/customer/vendors/${vendor.id}/reviews`, token));
  rows.push(await measure('cart', 'GET', '/customer/cart', token));
  rows.push(await measure('order list', 'GET', '/customer/orders', token));
  rows.push(await measure('addresses', 'GET', '/customer/addresses', token));
  rows.push(await measure('profile', 'GET', '/customer/profile', token));
  rows.push(await measure('favorites', 'GET', '/customer/favorites', token));
  rows.push(await measure('taxi availability', 'GET', '/rides/availability?lat=6.8&lng=-58.15', token));

  const slowest = [...rows].filter((r) => r.n > 0).sort((a, b) => b.p95 - a.p95);
  const heaviest = [...rows].filter((r) => r.n > 0).sort((a, b) => b.bytes - a.bytes);

  console.log('\n## A10 — server-side performance baseline\n');
  console.log(`samples per endpoint: ${SAMPLES} (first ${WARMUP} discarded as warm-up) · judge RTT adjustment: +${JUDGE_RTT_MS}ms\n`);
  console.log('| Endpoint | Method | Auth | n | err | p50 | p95 | p95 +judge | max | payload |');
  console.log('|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of slowest) {
    console.log(
      `| ${r.name} | ${r.method} | ${r.auth ? 'yes' : 'no'} | ${r.n} | ${r.errors} | ${ms(r.p50)} | ${ms(r.p95)}`
      + ` | ${ms(r.p95 + JUDGE_RTT_MS)} | ${ms(r.max)} | ${kb(r.bytes)} |`,
    );
  }
  const unmeasured = rows.filter((r) => r.n === 0);
  if (unmeasured.length > 0) {
    console.log('\nNOT MEASURED (every sample non-2xx — recorded, never silently dropped):');
    for (const r of unmeasured) {
      const seen = [...r.statuses.entries()].map(([code, n]) => `${code}x${n}`).join(' ');
      console.log(`  · ${r.name} (${r.method} ${r.path}) — ${r.errors} non-2xx: ${seen}`);
    }
    if (unmeasured.some((r) => r.statuses.has(429))) {
      console.log('    ⚠ 429s present: this harness tripped a rate limit. Raise A10_PACE_MS and re-run — the endpoint is not the finding.');
    }
  }
  if (SAMPLES < MIN_SAMPLE_FOR_P95) {
    console.log(`\n⚠ SAMPLE TOO SMALL: ${SAMPLES} < ${MIN_SAMPLE_FOR_P95}. The p95 column above is an ESTIMATE, not a p95.`);
  }

  console.log('\n### Heaviest payloads (the "image payload sizes" thread starts here)\n');
  for (const r of heaviest.slice(0, 5)) console.log(`  · ${r.name}: ${kb(r.bytes)}`);

  console.log('\n### Budgets from the protocol (Part 10 must beat these)\n');
  const READ_BUDGET = 400;
  const overBudget = slowest.filter((r) => r.p95 + JUDGE_RTT_MS > READ_BUDGET);
  console.log(`API p95 reads budget: ${READ_BUDGET}ms on the hot paths, judged.`);
  if (overBudget.length === 0) {
    console.log(`ALL ${slowest.length} measured read paths are inside budget WITH the judge adjustment applied.`);
  } else {
    console.log(`OVER BUDGET (${overBudget.length}):`);
    for (const r of overBudget) console.log(`  · ${r.name}: ${ms(r.p95 + JUDGE_RTT_MS)} judged (raw ${ms(r.p95)})`);
  }
  console.log('\nA10 SERVER-SIDE COMPLETE.');
}

main()
  .catch((e) => { console.error('A10 FAILED:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
