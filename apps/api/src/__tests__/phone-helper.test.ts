import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// [PHONE-HELPER] The phone-test counterpart helper (scripts/livetest/
// phone-helper.ts). It plays the second party of a Phones-gate journey as a
// journeys roster TEST account, through the real API. Proven here against a
// stand-in API that records every call and WHO made it:
//
//   * the guard runs first, exactly as the journeys suite's does (gates p, a,
//     b, c): a usage error connects to nothing; a public target, a production
//     identity or a missing admin phone is refused before any actor signs in;
//   * each action makes exactly the calls the app itself would make, as the
//     account that plays the role (the store's calls carry the store's token);
//   * no shortcut: no /admin call and no test-control call but the identity
//     probe, in any action — there is no DB, no seed, no backdoor;
//   * the accounts are the journeys roster's, all never-a-subscriber +5920….
// Imported by path, like livetest-guard.test.ts (scripts/ is outside rootDir).
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
let helper: any;
let roster: any;
beforeAll(async () => {
  helper = await import(pathToFileURL(join(ROOT, 'scripts/livetest/phone-helper.ts')).href);
  roster = await import(pathToFileURL(join(ROOT, 'scripts/livetest/roster.ts')).href);
});

const ADMIN = '+5920400000';
const ENV = { LIVETEST_ADMIN_PHONE: ADMIN };
const STAGING = { deploymentId: 'swift-staging-1', environment: 'staging', buildSha: 'b8', dataClassification: 'synthetic', testTenant: 'swift-default' };
const id = (tag: string) => `cl${tag.padStart(24, '0')}`.slice(0, 26);
const ORDER = id('order1');
const STORE = id('store1');
const JOB = id('job1');

interface Call { method: string; path: string; actor: string; body: any }
type Route = (method: string, path: string, actor: string, body: any) => [number, unknown] | undefined;

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

/** A stand-in API. `actor` is the roster id (or ADMIN) whose token made the call; '-' when none. */
function api(route: Route = () => undefined, identity: Record<string, unknown> = STAGING): Call[] {
  const byPhone = new Map<string, string>([[ADMIN, 'ADMIN']]);
  for (const a of Object.values(helper.ACTORS) as any[]) byPhone.set(a.phone, a.id);
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (input: any, init: any) => {
    const url = new URL(String(input));
    const path = `${url.pathname.replace(/^\/api\/v1/, '')}${url.search}`;
    const method = String(init?.method ?? 'GET');
    const auth = String(init?.headers?.authorization ?? '');
    const actor = auth ? byPhone.get(auth.replace(/^Bearer tok-/, '')) ?? '?' : '-';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body instanceof FormData ? 'multipart' : null;
    calls.push({ method, path, actor, body });
    const reply = (status: number, json: unknown) => ({ status, text: async () => JSON.stringify(json) }) as unknown as Response;
    if (path === '/auth/verify-otp') {
      const phone = body?.phone as string;
      return byPhone.has(phone) ? reply(200, { success: true, data: { tokens: { accessToken: `tok-${phone}`, refreshToken: `r-${phone}`, expiresIn: 900 }, user: { id: `u-${phone}` } } }) : reply(400, { success: false, error: { code: 'INVALID_OTP' } });
    }
    if (path === '/test-control/identity') return auth ? reply(200, { success: true, data: identity }) : reply(401, { success: false, error: { code: 'UNAUTHORIZED' } });
    const handled = route(method, path, actor, body);
    if (handled) return reply(handled[0], handled[1]);
    return reply(200, { success: true, data: {} });
  }) as unknown as typeof fetch;
  return calls;
}

/** A clock that only moves when the helper sleeps. */
function deps() {
  let t = Date.UTC(2026, 8, 30, 12, 0, 0);
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l), sleep: async (ms: number) => { t += ms; }, now: () => t };
}

const guardCall = (c: Call) => c.path === '/test-control/identity' || (c.path === '/auth/verify-otp' && c.body?.phone === ADMIN);
const signIns = (calls: Call[]) => calls.filter((c) => c.path === '/auth/verify-otp').map((c) => c.body?.phone);
const actorCalls = (calls: Call[]) => calls.filter((c) => !guardCall(c) && c.path !== '/auth/verify-otp');
const seq = (calls: Call[]) => actorCalls(calls).map((c) => `${c.actor} ${c.method} ${c.path}`);

describe('[PHONE-HELPER] the accounts are the journeys roster’s test accounts', () => {
  it('every helper phone is a roster phone and never a subscriber (+5920…)', () => {
    const rosterPhones = new Set(roster.fixturePhones());
    for (const phone of helper.helperPhones()) {
      expect(phone).toMatch(/^\+5920\d{6}$/);
      expect(rosterPhones.has(phone), phone).toBe(true);
    }
  });

  it('every role has a default player of that role; movers carry their kind', () => {
    for (const [role, who] of Object.entries(helper.DEFAULT_ACTOR) as Array<[string, string]>) {
      expect(helper.ACTORS[who].roles, `${role} → ${who}`).toContain(role);
    }
    for (const a of Object.values(helper.ACTORS) as any[]) {
      if (a.roles.some((r: string) => ['rider', 'driver', 'courier'].includes(r))) expect(a.kind).toBeDefined();
    }
  });
});

describe('[PHONE-HELPER] parsing: a bad command connects to nothing', () => {
  it('each role takes only its own actions, and each action’s required values', () => {
    const bad = [
      [], ['admin', 'approve'], ['store'], ['store', 'refund'], ['rider', 'deliver', '--order', ORDER],
      ['driver', 'start', '--order', ORDER], ['store', 'handover', '--order', ORDER], ['provider', 'quote', '--job', JOB],
      ['customer', 'ride', '--at', '6.81,-58.15'], ['customer', 'order'],
    ];
    for (const argv of bad) expect(() => helper.parseHelperArgs(argv), argv.join(' ')).toThrow(helper.HelperUsage);
  });

  it('ids, PINs, codes, amounts, waits and coordinates are validated — swapped lat/lng included', () => {
    const cases: Array<[string[], RegExp]> = [
      [['customer', 'codes', '--order', "x'; drop table orders"], /not an id/],
      [['rider', 'deliver', '--order', ORDER, '--pin', '12ab'], /--pin/],
      [['store', 'handover', '--order', ORDER, '--code', '12345'], /6-digit/],
      [['provider', 'quote', '--job', JOB, '--amount', '-5'], /--amount/],
      [['rider', 'accept', '--wait', '9999'], /--wait/],
      [['store', 'open', '--at', '-58.15,6.81'], /not in Guyana/],
      [['store', 'open', '--at', '51.5,-0.12'], /not in Guyana/],
      [['driver', 'finish', '--order', ORDER, '--outcome', 'vanished'], /paid or no_show/],
      [['store', 'open', '--as', 'DR1'], /not a store/],
      [['all', 'cleanup', '--as', 'R1'], /does not apply/],
      [['store', 'open', '--bogus', 'x'], /unknown flag/],
      [['store', 'accept', '--order', ORDER, '--order', ORDER], /twice/],
    ];
    for (const [argv, why] of cases) expect(() => helper.parseHelperArgs(argv), argv.join(' ')).toThrow(why);
  });

  it('defaults: taxi rides are the L2 passenger C7’s, parcels C8’s, the rest the role’s default', () => {
    expect(helper.parseHelperArgs(['customer', 'ride', '--at', '6.81,-58.15', '--to', '6.82,-58.14']).as).toBe('C7');
    expect(helper.parseHelperArgs(['customer', 'send', '--at', '6.81,-58.15', '--to', '6.82,-58.14']).as).toBe('C8');
    expect(helper.parseHelperArgs(['customer', 'order', '--store', STORE]).as).toBe('C4');
    expect(helper.parseHelperArgs(['courier', 'accept']).as).toBe('DR3');
    expect(helper.parseHelperArgs(['store', 'open', '--at=6.8013,-58.1551'])).toMatchObject({ as: 'R1', at: { lat: 6.8013, lng: -58.1551 } });
  });

  it('a usage error is exit 2 with no request at all', async () => {
    const calls = api();
    expect(await helper.phoneHelper(['store', 'refund'], ENV, deps())).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('[PHONE-HELPER] the journeys guard runs before any actor signs in', () => {
  it('a production identity → exit 3; only the admin proof ran, no helper account signed in, no action', async () => {
    const calls = api(undefined, { ...STAGING, environment: 'production' });
    const d = deps();
    expect(await helper.phoneHelper(['store', 'open'], ENV, d)).toBe(3);
    expect(d.lines.join('\n')).toContain('REFUSED');
    expect(signIns(calls)).toEqual([ADMIN]);
    expect(actorCalls(calls)).toEqual([]);
  });

  it('non-synthetic data, a deployment other than the pinned one, or the public host → exit 3', async () => {
    let calls = api(undefined, { ...STAGING, dataClassification: 'real' });
    expect(await helper.phoneHelper(['store', 'open'], ENV, deps())).toBe(3);
    expect(actorCalls(calls)).toEqual([]);
    calls = api();
    expect(await helper.phoneHelper(['store', 'open'], { ...ENV, LIVETEST_EXPECT_DEPLOYMENT_ID: 'swift-staging-2' }, deps())).toBe(3);
    expect(actorCalls(calls)).toEqual([]);
    calls = api();
    expect(await helper.phoneHelper(['store', 'open'], { ...ENV, LIVETEST_PUBLIC_HOST: 'localhost' }, deps())).toBe(3);
    expect(calls).toEqual([]);
  });

  it('no admin phone, or one that could reach a subscriber → exit 3 before any request', async () => {
    const calls = api();
    expect(await helper.phoneHelper(['store', 'open'], {}, deps())).toBe(3);
    expect(await helper.phoneHelper(['store', 'open'], { LIVETEST_ADMIN_PHONE: '+5926001234' }, deps())).toBe(3);
    expect(calls).toEqual([]);
  });
});

describe('[PHONE-HELPER] store (R1 by default)', () => {
  const vendor = { id: STORE, name: 'TEST-Kitchen-One', status: 'ACTIVE', latitude: 6.809, longitude: -58.152 };
  function storeApi(extra: Route = () => undefined) {
    const flags = { isCurrentlyOpen: false, acceptingOrders: false };
    return api((method, path, actor, body) => {
      const hit = extra(method, path, actor, body);
      if (hit) return hit;
      if (path === '/vendor/profile' && method === 'GET') return [200, { success: true, data: { vendors: [{ ...vendor, ...flags }] } }];
      if (path === '/vendor/vendor/toggle-open') { flags.isCurrentlyOpen = !flags.isCurrentlyOpen; return [200, { success: true, data: { isCurrentlyOpen: flags.isCurrentlyOpen } }]; }
      if (path === '/vendor/vendor/toggle-orders') { flags.acceptingOrders = !flags.acceptingOrders; return [200, { success: true, data: { acceptingOrders: flags.acceptingOrders } }]; }
      if (path === '/vendor/items?limit=50') return [200, { success: true, data: [{ id: id('item1'), name: 'R1 Plate', basePrice: 1500, isAvailable: true }] }];
      return undefined;
    });
  }

  it('open --at: the store’s own pin moves there, it opens and accepts — every call as R1', async () => {
    const calls = storeApi();
    const d = deps();
    expect(await helper.phoneHelper(['store', 'open', '--at', '6.8013,-58.1551'], ENV, d)).toBe(0);
    expect(signIns(calls)).toEqual([ADMIN, helper.ACTORS.R1.phone]);
    expect(seq(calls)).toEqual([
      'R1 GET /vendor/profile',
      'R1 PUT /vendor/profile',
      'R1 PUT /vendor/vendor/toggle-open',
      'R1 PUT /vendor/vendor/toggle-orders',
      'R1 GET /vendor/items?limit=50',
    ]);
    expect(actorCalls(calls)[1]!.body).toEqual({ latitude: 6.8013, longitude: -58.1551 });
    expect(d.lines.join('\n')).toContain('OK: R1 "TEST-Kitchen-One" is open and accepting at 6.8013,-58.1551');
  });

  it('accept --order accepts that order; with no --order it waits for the next PENDING one (after its hold)', async () => {
    let calls = storeApi();
    expect(await helper.phoneHelper(['store', 'accept', '--order', ORDER], ENV, deps())).toBe(0);
    expect(seq(calls)).toEqual([`R1 PUT /vendor/orders/${ORDER}/accept`]);

    let polls = 0;
    calls = storeApi((method, path) => {
      if (path === '/vendor/orders?limit=50') {
        polls += 1;
        return [200, { success: true, data: polls < 3 ? [] : [{ id: ORDER, status: 'PENDING', createdAt: '2026-09-30T12:01:00Z' }, { id: id('old'), status: 'PREPARING', createdAt: '2026-09-30T11:00:00Z' }] }];
      }
      return undefined;
    });
    expect(await helper.phoneHelper(['store', 'accept', '--wait', '60'], ENV, deps())).toBe(0);
    expect(seq(calls).at(-1)).toBe(`R1 PUT /vendor/orders/${ORDER}/accept`);
    expect(polls).toBe(3);
  });

  it('accept with nothing arriving gives up after --wait, accepting nothing', async () => {
    const calls = storeApi((_m, path) => (path === '/vendor/orders?limit=50' ? [200, { success: true, data: [] }] : undefined));
    expect(await helper.phoneHelper(['store', 'accept', '--wait', '10'], ENV, deps())).toBe(1);
    expect(actorCalls(calls).some((c) => c.method === 'PUT')).toBe(false);
  });

  it('ready = preparing then ready; handover = the counter code, as the store', async () => {
    let calls = storeApi();
    expect(await helper.phoneHelper(['store', 'ready', '--order', ORDER], ENV, deps())).toBe(0);
    expect(seq(calls)).toEqual([`R1 PUT /vendor/orders/${ORDER}/preparing`, `R1 PUT /vendor/orders/${ORDER}/ready`]);
    calls = storeApi();
    expect(await helper.phoneHelper(['store', 'handover', '--order', ORDER, '--code', '123456'], ENV, deps())).toBe(0);
    expect(actorCalls(calls)).toEqual([{ method: 'PUT', path: `/vendor/orders/${ORDER}/complete-pickup`, actor: 'R1', body: { code: '123456' } }]);
  });

  it('a refused step is exit 1 and names the API’s answer', async () => {
    storeApi((_m, path) => (path.endsWith('/complete-pickup') ? [400, { success: false, error: { code: 'WRONG_PICKUP_CODE', message: 'That code is not right' } }] : undefined));
    const d = deps();
    expect(await helper.phoneHelper(['store', 'handover', '--order', ORDER, '--code', '654321'], ENV, d)).toBe(1);
    expect(d.lines.join('\n')).toContain('400 WRONG_PICKUP_CODE');
  });
});

describe('[PHONE-HELPER] rider / courier / driver: the mover’s own calls', () => {
  it('rider accept: online where told, position kept fresh while waiting, then the offer taken with its attempt id', async () => {
    let polls = 0;
    const calls = api((method, path) => {
      if (path === '/rider/offers/current') {
        polls += 1;
        return [200, { success: true, data: { offer: polls < 7 ? null : { orderId: ORDER, offerAttemptId: 'att-9', orderNumber: 'SW-1' } } }];
      }
      return undefined;
    });
    expect(await helper.phoneHelper(['rider', 'accept', '--at', '6.81,-58.15', '--wait', '120'], ENV, deps())).toBe(0);
    const s = seq(calls);
    expect(s[0]).toBe('DR2 POST /rider/go-online');
    expect(actorCalls(calls)[0]!.body).toEqual({ latitude: 6.81, longitude: -58.15 });
    expect(s.filter((x) => x === 'DR2 PUT /rider/location').length).toBeGreaterThanOrEqual(2);
    expect(s.at(-1)).toBe('DR2 POST /rider/offers/accept');
    expect(actorCalls(calls).at(-1)!.body).toEqual({ orderId: ORDER, offerAttemptId: 'att-9' });
  });

  it('rider accept --order ignores an offer for another order', async () => {
    const other = id('other');
    let polls = 0;
    const calls = api((_m, path) => {
      if (path === '/rider/offers/current') {
        polls += 1;
        return [200, { success: true, data: { offer: { orderId: polls < 3 ? other : ORDER, offerAttemptId: `a${polls}` } } }];
      }
      return undefined;
    });
    expect(await helper.phoneHelper(['rider', 'accept', '--order', ORDER, '--wait', '60'], ENV, deps())).toBe(0);
    const accepts = actorCalls(calls).filter((c) => c.path === '/rider/offers/accept');
    expect(accepts).toEqual([{ method: 'POST', path: '/rider/offers/accept', actor: 'DR2', body: { orderId: ORDER, offerAttemptId: 'a3' } }]);
  });

  it('rider pickup walks from the leg’s own rung to picked up; deliver walks on to the door and hands over with the PIN at the door', async () => {
    const legs = (status: string) => (_m: string, path: string) => (path === '/rider/orders/active-legs' ? [200, { success: true, data: { legs: [{ id: ORDER, status, deliveryLat: 6.815, deliveryLng: -58.149 }] } }] as [number, unknown] : undefined);
    let calls = api(legs('RIDER_EN_ROUTE_PICKUP'));
    expect(await helper.phoneHelper(['rider', 'pickup', '--order', ORDER], ENV, deps())).toBe(0);
    expect(seq(calls)).toEqual(['DR2 GET /rider/orders/active-legs', `DR2 PUT /rider/orders/${ORDER}/arrived-pickup`, `DR2 PUT /rider/orders/${ORDER}/picked-up`]);
    calls = api(legs('PICKED_UP'));
    expect(await helper.phoneHelper(['rider', 'deliver', '--order', ORDER, '--pin', '4321'], ENV, deps())).toBe(0);
    expect(seq(calls)).toEqual(['DR2 GET /rider/orders/active-legs', `DR2 PUT /rider/orders/${ORDER}/en-route-delivery`, `DR2 PUT /rider/orders/${ORDER}/arrived`, `DR2 POST /rider/orders/${ORDER}/handover`]);
    expect(actorCalls(calls).at(-1)!.body).toEqual({ outcome: 'paid', gps: { lat: 6.815, lng: -58.149 }, ridePin: '4321' });
  });

  it('a rider that does not hold the order does nothing', async () => {
    const calls = api((_m, path) => (path === '/rider/orders/active-legs' ? [200, { success: true, data: { legs: [] } }] : undefined));
    expect(await helper.phoneHelper(['rider', 'pickup', '--order', ORDER], ENV, deps())).toBe(1);
    expect(actorCalls(calls).filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('courier collect: to the pickup, the sender’s cash, a photo the server issues, then the pickup proof with it', async () => {
    const calls = api((_m, path) => {
      if (path === '/rider/orders/active-legs') return [200, { success: true, data: { legs: [{ id: ORDER, status: 'RIDER_ASSIGNED', pickupLat: 6.814, pickupLng: -58.154 }] } }];
      if (path === `/courier/order/${ORDER}/pickup-proof-photo`) return [201, { success: true, data: { url: '/uploads/courier-proof/issued/p.png' } }];
      return undefined;
    });
    expect(await helper.phoneHelper(['courier', 'collect', '--order', ORDER], ENV, deps())).toBe(0);
    expect(seq(calls)).toEqual([
      'DR3 GET /rider/orders/active-legs',
      `DR3 PUT /rider/orders/${ORDER}/en-route-pickup`,
      `DR3 PUT /rider/orders/${ORDER}/arrived-pickup`,
      `DR3 POST /courier/order/${ORDER}/collect`,
      `DR3 POST /courier/order/${ORDER}/pickup-proof-photo`,
      `DR3 POST /courier/order/${ORDER}/pickup-proof`,
    ]);
    const a = actorCalls(calls);
    expect(a[3]!.body).toEqual({ outcome: 'paid', gps: { lat: 6.814, lng: -58.154 } });
    expect(a[4]!.body).toBe('multipart');
    expect(a[5]!.body).toEqual({ proofPhotoUrl: '/uploads/courier-proof/issued/p.png', gps: { lat: 6.814, lng: -58.154 } });
  });

  it('courier deliver: to the drop-off, then the drop-off photo and its proof', async () => {
    const calls = api((_m, path) => {
      if (path === '/rider/orders/active-legs') return [200, { success: true, data: { legs: [{ id: ORDER, status: 'PICKED_UP' }] } }];
      if (path === `/courier/order/${ORDER}/proof-photo`) return [201, { success: true, data: { url: '/uploads/proof/issued/d.png' } }];
      return undefined;
    });
    expect(await helper.phoneHelper(['courier', 'deliver', '--order', ORDER], ENV, deps())).toBe(0);
    expect(seq(calls).slice(1)).toEqual([`DR3 PUT /rider/orders/${ORDER}/en-route-delivery`, `DR3 PUT /rider/orders/${ORDER}/arrived`, `DR3 POST /courier/order/${ORDER}/proof-photo`, `DR3 POST /courier/order/${ORDER}/proof`]);
    expect(actorCalls(calls).at(-1)!.body).toEqual({ proofPhotoUrl: '/uploads/proof/issued/d.png' });
  });

  it('driver accept → arrive (a refused arrival retried once past the location debounce) → start with the PIN → finish in cash', async () => {
    const ride = { id: ORDER, status: 'DRIVER_ASSIGNED', pickupLat: 6.811, pickupLng: -58.153, deliveryLat: 6.825, deliveryLng: -58.14 };
    let arrivals = 0;
    const calls = api((method, path) => {
      if (path === '/driver/offers/current') return [200, { success: true, data: { orderId: ORDER, offerAttemptId: 'd-1' } }];
      if (path === '/driver/rides/active') return [200, { success: true, data: ride }];
      if (path === `/driver/rides/${ORDER}/arrived`) {
        arrivals += 1;
        return arrivals === 1 ? [409, { success: false, error: { code: 'ARRIVAL_NOT_VERIFIED' } }] : [200, { success: true, data: { status: 'DRIVER_ARRIVED' } }];
      }
      return undefined;
    });
    const d = deps();
    const t0 = d.now();
    expect(await helper.phoneHelper(['driver', 'accept', '--at', '6.811,-58.153'], ENV, d)).toBe(0);
    expect(await helper.phoneHelper(['driver', 'arrive', '--order', ORDER], ENV, d)).toBe(0);
    expect(d.now() - t0).toBeGreaterThanOrEqual(11_000);
    expect(await helper.phoneHelper(['driver', 'start', '--order', ORDER, '--pin', '2468'], ENV, d)).toBe(0);
    expect(await helper.phoneHelper(['driver', 'finish', '--order', ORDER], ENV, d)).toBe(0);
    const writes = actorCalls(calls).filter((c) => c.method !== 'GET').map((c) => `${c.actor} ${c.method} ${c.path}`);
    expect(writes).toEqual([
      'T2 POST /driver/go-online', 'T2 PUT /driver/location', 'T2 POST /driver/offers/accept',
      `T2 PUT /driver/rides/${ORDER}/en-route`, 'T2 PUT /driver/location', `T2 PUT /driver/rides/${ORDER}/arrived`, 'T2 PUT /driver/location', `T2 PUT /driver/rides/${ORDER}/arrived`,
      `T2 PUT /driver/rides/${ORDER}/verify-pin`, `T2 PUT /driver/rides/${ORDER}/start`,
      `T2 POST /driver/rides/${ORDER}/handover`,
    ]);
    const a = actorCalls(calls);
    expect(a.find((c) => c.path.endsWith('/verify-pin'))!.body).toEqual({ pin: '2468' });
    expect(a.find((c) => c.path.endsWith('/handover'))!.body).toEqual({ outcome: 'paid', gps: { lat: 6.825, lng: -58.14 } });
  });

  it('driver finish --outcome no_show records the no-show outcome', async () => {
    const calls = api((_m, path) => (path === '/driver/rides/active' ? [200, { success: true, data: { id: ORDER, status: 'RIDE_IN_PROGRESS', deliveryLat: 6.825, deliveryLng: -58.14 } }] : undefined));
    expect(await helper.phoneHelper(['driver', 'finish', '--order', ORDER, '--outcome', 'no_show'], ENV, deps())).toBe(0);
    expect(actorCalls(calls).at(-1)!.body).toEqual({ outcome: 'no_show', gps: { lat: 6.825, lng: -58.14 } });
  });

  it('offline takes the mover offline, as itself', async () => {
    const calls = api();
    expect(await helper.phoneHelper(['courier', 'offline', '--as', 'DR4'], ENV, deps())).toBe(0);
    expect(seq(calls)).toEqual(['DR4 POST /rider/go-offline']);
  });
});

describe('[PHONE-HELPER] customer: orders, codes, rides and parcels as the customer', () => {
  const store = { id: STORE, name: 'Owner Test Store', latitude: 6.8, longitude: -58.16, categories: [{ items: [{ id: id('item7'), name: 'Pepperpot', basePrice: 2000 }] }] };
  const shop: Route = (method, path) => {
    if (path === `/customer/vendors/${STORE}`) return [200, { success: true, data: store }];
    if (path === '/customer/cart') return [200, { success: true, data: { items: [] } }];
    if (path === '/customer/addresses' && method === 'GET') return [200, { success: true, data: [] }];
    if (path === '/customer/addresses' && method === 'POST') return [201, { success: true, data: { id: id('addr1') } }];
    if (path === '/customer/checkout') return [201, { success: true, data: { orders: [{ id: ORDER, orderNumber: 'SW-9', holdExpiresAt: '2026-09-30T12:05:00Z' }] } }];
    return undefined;
  };

  it('order --pickup: the store’s first item, a counter-pickup cash checkout, no address', async () => {
    const calls = api(shop);
    const d = deps();
    expect(await helper.phoneHelper(['customer', 'order', '--store', STORE, '--pickup'], ENV, d)).toBe(0);
    const checkout = actorCalls(calls).find((c) => c.path === '/customer/checkout')!;
    expect(checkout.actor).toBe('C4');
    expect(checkout.body).toEqual({ paymentMethod: 'CASH', fulfillmentSelections: { [STORE]: 'PICKUP' } });
    expect(actorCalls(calls).some((c) => c.path === '/customer/cart/address')).toBe(false);
    expect(actorCalls(calls).find((c) => c.path === '/customer/cart/items')!.body).toEqual({ vendorId: STORE, itemId: id('item7'), quantity: 1 });
    expect(d.lines.join('\n')).toContain(`C4 placed ${ORDER} (SW-9)`);
  });

  it('order (delivery): a door address, then an express cash checkout', async () => {
    const calls = api(shop);
    expect(await helper.phoneHelper(['customer', 'order', '--store', STORE, '--at', '6.805,-58.155', '--as', 'C6'], ENV, deps())).toBe(0);
    const a = actorCalls(calls);
    expect(a.every((c) => c.actor === 'C6')).toBe(true);
    expect(a.find((c) => c.path === '/customer/cart/address')!.body).toEqual({ addressId: id('addr1') });
    expect(a.find((c) => c.path === '/customer/checkout')!.body).toEqual({ paymentMethod: 'CASH', express: true });
  });

  it('codes prints what the customer holds: the pickup code and the door PIN', async () => {
    api((_m, path) => (path === `/customer/orders/${ORDER}` ? [200, { success: true, data: { status: 'READY_FOR_PICKUP', pickupCode: '482913', ridePin: '5521' } }] : undefined));
    const d = deps();
    expect(await helper.phoneHelper(['customer', 'codes', '--order', ORDER], ENV, d)).toBe(0);
    expect(d.lines.join('\n')).toContain('pickup code 482913 · door PIN 5521');
  });

  it('ride (C7, the L2 passenger) requests with the given points and prints the passenger PIN; ride-pin reads it back', async () => {
    const calls = api((method, path) => {
      if (path === '/rides/request') return [201, { success: true, data: { ride: { id: ORDER, status: 'PENDING', ridePin: '7788' } } }];
      if (path === `/rides/${ORDER}`) return [200, { success: true, data: { status: 'DRIVER_ARRIVED', ridePin: '7788' } }];
      return undefined;
    });
    const d = deps();
    expect(await helper.phoneHelper(['customer', 'ride', '--at', '6.811,-58.153', '--to', '6.825,-58.14'], ENV, d)).toBe(0);
    expect(actorCalls(calls)[0]).toMatchObject({ actor: 'C7', method: 'POST', path: '/rides/request', body: { pickup: { lat: 6.811, lng: -58.153 }, dropoff: { lat: 6.825, lng: -58.14 }, passengerCount: 1, rideClass: 'ECONOMY' } });
    expect(d.lines.join('\n')).toContain('the passenger PIN is 7788');
    expect(await helper.phoneHelper(['customer', 'ride-pin', '--order', ORDER], ENV, d)).toBe(0);
    expect(d.lines.join('\n')).toContain('passenger PIN 7788');
  });

  it('send (C8) books a small cash parcel from the sender to the never-a-subscriber test recipient', async () => {
    const calls = api((_m, path) => (path === '/courier/order' ? [201, { success: true, data: { orderId: ORDER, fee: 800 } }] : undefined));
    expect(await helper.phoneHelper(['customer', 'send', '--at', '6.814,-58.154', '--to', '6.8215,-58.145'], ENV, deps())).toBe(0);
    const c = actorCalls(calls)[0]!;
    expect(c).toMatchObject({ actor: 'C8', path: '/courier/order', body: { payer: 'SENDER', packageSize: 'SMALL', recipientPhone: roster.RECIPIENT_PHONE } });
    expect(roster.RECIPIENT_PHONE).toMatch(/^\+5920\d{6}$/);
  });

  it('cancel and cancel-ride go through the customer’s own cancel routes', async () => {
    const calls = api();
    expect(await helper.phoneHelper(['customer', 'cancel', '--order', ORDER], ENV, deps())).toBe(0);
    expect(await helper.phoneHelper(['customer', 'cancel-ride', '--order', ORDER], ENV, deps())).toBe(0);
    expect(seq(calls)).toEqual([`C4 POST /customer/orders/${ORDER}/cancel`, `C7 POST /rides/${ORDER}/cancel`]);
  });
});

describe('[PHONE-HELPER] provider (SP1): quote, confirm, complete — the provider’s own calls', () => {
  it('each step is the provider’s route for that job', async () => {
    const calls = api((_m, path) => (path === '/services/jobs' ? [200, { success: true, data: [{ id: JOB, status: 'REQUESTED' }, { id: id('done'), status: 'COMPLETED' }] }] : undefined));
    const d = deps();
    expect(await helper.phoneHelper(['provider', 'jobs'], ENV, d)).toBe(0);
    expect(d.lines.join('\n')).toContain(`SP1 has 1 open job(s): ${JOB} REQUESTED`);
    expect(await helper.phoneHelper(['provider', 'quote', '--job', JOB, '--amount', '45000'], ENV, d)).toBe(0);
    expect(await helper.phoneHelper(['provider', 'confirm', '--job', JOB], ENV, d)).toBe(0);
    expect(await helper.phoneHelper(['provider', 'complete', '--job', JOB], ENV, d)).toBe(0);
    expect(actorCalls(calls).filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: `/services/jobs/${JOB}/quote`, actor: 'SP1', body: { amount: 45000 } },
      { method: 'POST', path: `/services/jobs/${JOB}/confirm`, actor: 'SP1', body: {} },
      { method: 'POST', path: `/services/jobs/${JOB}/complete`, actor: 'SP1', body: {} },
    ]);
  });
});

describe('[PHONE-HELPER] all: status and cleanup across every helper account', () => {
  it('cleanup takes every mover offline and closes every helper store (pin back home only when it was moved)', async () => {
    const moved = { id: STORE, name: 'TEST-Kitchen-One', status: 'ACTIVE', latitude: 6.8013, longitude: -58.1551, isCurrentlyOpen: true, acceptingOrders: true };
    const home = { ...moved, id: id('store2'), name: 'TEST-Kitchen-Two', latitude: 6.821, longitude: -58.144 };
    const calls = api((method, path, actor) => {
      if (path === '/vendor/profile' && method === 'GET') return [200, { success: true, data: { vendors: [actor === 'R1' ? moved : home] } }];
      if (path === '/vendor/vendor/toggle-open') return [200, { success: true, data: { isCurrentlyOpen: false } }];
      if (path === '/vendor/vendor/toggle-orders') return [200, { success: true, data: { acceptingOrders: false } }];
      if (path === '/rider/orders/active-legs' || path === '/driver/rides/active') return [200, { success: true, data: null }];
      return undefined;
    });
    expect(await helper.phoneHelper(['all', 'cleanup'], ENV, deps())).toBe(0);
    const s = seq(calls);
    for (const m of ['DR1', 'DR2', 'DR3', 'DR4']) expect(s).toContain(`${m} POST /rider/go-offline`);
    for (const m of ['T1', 'T2', 'T3']) expect(s).toContain(`${m} POST /driver/go-offline`);
    const pinMoves = actorCalls(calls).filter((c) => c.method === 'PUT' && c.path === '/vendor/profile');
    expect(pinMoves).toEqual([{ method: 'PUT', path: '/vendor/profile', actor: 'R1', body: { latitude: 6.809, longitude: -58.152 } }]);
  });
});

describe('[PHONE-HELPER] no shortcuts, whatever the action', () => {
  it('no action calls an admin route or a test-control route (the identity probe is the guard’s)', async () => {
    const calls = api((method, path) => {
      if (path === '/rider/offers/current' || path === '/driver/offers/current') return [200, { success: true, data: { offer: { orderId: ORDER, offerAttemptId: 'x' } } }];
      if (path === '/rider/orders/active-legs') return [200, { success: true, data: { legs: [{ id: ORDER, status: 'RIDER_ASSIGNED', pickupLat: 6.81, pickupLng: -58.15, deliveryLat: 6.82, deliveryLng: -58.14 }] } }];
      if (path === '/driver/rides/active') return [200, { success: true, data: { id: ORDER, status: 'DRIVER_ASSIGNED', pickupLat: 6.81, pickupLng: -58.15, deliveryLat: 6.82, deliveryLng: -58.14 } }];
      if (path === '/vendor/profile' && method === 'GET') return [200, { success: true, data: { vendors: [{ id: STORE, name: 'S', status: 'ACTIVE', latitude: 6.809, longitude: -58.152 }] } }];
      if (path === `/customer/vendors/${STORE}`) return [200, { success: true, data: { id: STORE, name: 'S', latitude: 6.8, longitude: -58.16, categories: [{ items: [{ id: id('i') }] }] } }];
      if (path === '/customer/checkout') return [201, { success: true, data: { orders: [{ id: ORDER }] } }];
      if (path === '/rides/request') return [201, { success: true, data: { ride: { id: ORDER } } }];
      if (path === '/courier/order') return [201, { success: true, data: { orderId: ORDER } }];
      if (path === '/customer/addresses' && method === 'POST') return [201, { success: true, data: { id: id('a') } }];
      return undefined;
    });
    const at = ['--at', '6.81,-58.15'];
    const commands: string[][] = [
      ['customer', 'order', '--store', STORE, '--pickup'], ['customer', 'order', '--store', STORE, ...at], ['customer', 'codes', '--order', ORDER],
      ['customer', 'cancel', '--order', ORDER], ['customer', 'ride', ...at, '--to', '6.82,-58.14'], ['customer', 'ride-pin', '--order', ORDER],
      ['customer', 'cancel-ride', '--order', ORDER], ['customer', 'send', ...at, '--to', '6.82,-58.14'],
      ['store', 'open', ...at], ['store', 'orders'], ['store', 'accept', '--order', ORDER], ['store', 'ready', '--order', ORDER],
      ['store', 'handover', '--order', ORDER, '--code', '111111'], ['store', 'close'],
      ['rider', 'accept', '--wait', '5'], ['rider', 'pickup', '--order', ORDER], ['rider', 'deliver', '--order', ORDER, '--pin', '1234'], ['rider', 'offline'],
      ['courier', 'accept', '--wait', '5'], ['courier', 'collect', '--order', ORDER], ['courier', 'deliver', '--order', ORDER], ['courier', 'offline'],
      ['driver', 'accept', '--wait', '5'], ['driver', 'arrive', '--order', ORDER], ['driver', 'start', '--order', ORDER, '--pin', '1234'],
      ['driver', 'finish', '--order', ORDER], ['driver', 'offline'],
      ['provider', 'jobs'], ['provider', 'quote', '--job', JOB, '--amount', '100'], ['provider', 'confirm', '--job', JOB], ['provider', 'complete', '--job', JOB],
      ['all', 'status'], ['all', 'cleanup'],
    ];
    const covered = new Set<string>();
    for (const argv of commands) {
      covered.add(`${argv[0]} ${argv[1]}`);
      await helper.phoneHelper(argv, ENV, deps());
    }
    // Every action of every role was run at least once.
    for (const [role, actions] of Object.entries(helper.ACTIONS) as Array<[string, string[]]>) {
      for (const a of actions) expect(covered.has(`${role} ${a}`), `${role} ${a}`).toBe(true);
    }
    expect(calls.filter((c) => c.path.startsWith('/admin'))).toEqual([]);
    expect([...new Set(calls.filter((c) => c.path.startsWith('/test-control')).map((c) => `${c.method} ${c.path}`))]).toEqual(['GET /test-control/identity']);
    // Every action call is made by a helper account (never unauthenticated, never the admin).
    for (const c of actorCalls(calls)) expect(Object.keys(helper.ACTORS), `${c.method} ${c.path} by ${c.actor}`).toContain(c.actor);
  });
});
