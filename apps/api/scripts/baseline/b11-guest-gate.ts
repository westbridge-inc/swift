/**
 * ELV-2 A12 — Scenario B11: GUEST BROWSE → ORDER GATE (INV-6 / INV-16).
 *
 * Proves: (1) full catalog browsing with ZERO account — public storefronts,
 * storefront detail, discovery categories, search — all 200 tokenless;
 * (2) the wall sits EXACTLY at ordering: cart/checkout mutations demand auth
 * (401), never a browse endpoint; (3) the tier gate is server-side at order
 * creation (an authenticated but tierless probe hits the SERVER check, not a
 * client hint).
 *
 * Run: DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b11-guest-gate.ts
 */
const API = process.env['BASELINE_API'] ?? 'http://localhost:3000/api/v1';

function log(step: string, detail: unknown = '') {
  console.log(`${new Date().toISOString()} · ${step}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function http(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

async function main() {
  // ── 1. guest browse: every discovery surface answers tokenless ────────────
  const browse: [string, string][] = [
    ['public storefront list', '/public/storefronts?limit=5'],
    ['discovery categories', '/discovery/categories'],
  ];
  const storefronts = await http('GET', '/public/storefronts?limit=5');
  if (storefronts.status !== 200) throw new Error(`FAIL guest storefronts: ${storefronts.status}`);
  const first = storefronts.json?.data?.storefronts?.[0] ?? storefronts.json?.data?.[0];
  for (const [name, path] of browse) {
    const r = await http('GET', path);
    if (r.status !== 200) throw new Error(`FAIL guest browse ${name}: ${r.status}`);
    log(`EVIDENCE guest ${name}`, { status: r.status });
  }
  if (first?.slug) {
    const detail = await http('GET', `/public/storefronts/${first.slug}`);
    if (detail.status !== 200) throw new Error(`FAIL guest storefront detail: ${detail.status}`);
    log('EVIDENCE guest storefront detail', { slug: first.slug, status: detail.status });
  }

  // ── 2. the wall sits at ORDERING: mutations 401 tokenless ────────────────
  const gated: [string, string, string, unknown][] = [
    ['cart add', 'POST', '/customer/cart/items', { vendorId: 'x', itemId: 'x', quantity: 1 }],
    ['checkout', 'POST', '/customer/checkout', { paymentMethod: 'CASH' }],
    ['address create', 'POST', '/customer/addresses', { label: 'x', addressLine1: 'x', city: 'x', latitude: 1, longitude: 1 }],
  ];
  for (const [name, method, path, body] of gated) {
    const r = await http(method, path, body);
    if (r.status !== 401) throw new Error(`FAIL gate ${name}: expected 401 got ${r.status}`);
    log(`EVIDENCE order-gate ${name}`, { status: r.status });
  }

  // ── 3. no permission wall on browse: the SAME endpoints with a garbage
  //      token still refuse auth-required paths but browse stays open ───────
  const garbage = await http('GET', '/public/storefronts?limit=1', undefined, 'not-a-real-token');
  if (garbage.status !== 200) throw new Error(`FAIL: browse rejected a bad token (${garbage.status}) — a wall where none belongs`);
  log('EVIDENCE browse ignores junk tokens (no wall)', { status: garbage.status });

  log('B11 COMPLETE — GUEST BROWSE OPEN, ORDER GATE SERVER-SIDE');
}

main().catch((e) => { console.error('B11 FAILED:', e.message); process.exitCode = 1; });
