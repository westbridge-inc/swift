import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// [SAFE-B] The synthetic livetest callers keep the new contracts: the courier
// cleanup closes a job only with a server-issued proof (and records only the
// recipient's pending cash outcome), and the vendor billing journey accepts a
// cold session's step-up refusal without bypassing it or requesting SMS.
//
// The livetest modules are loaded by path, as the sibling livetest suites do
// (scripts/ sits outside this package's rootDir, so a computed specifier keeps
// tsc out of it); their HTTP client and the heavier journey modules are mocked.
// ---------------------------------------------------------------------------

const http = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), PUT: vi.fn(), req: vi.fn(), upload: vi.fn() }));
vi.mock('../../../../scripts/livetest/client.js', () => ({ ...http, FIXTURE_PNG: Buffer.from('synthetic'), codeOf: (r: any) => r.json?.error?.code ?? '' }));
vi.mock('../../../../scripts/livetest/journeys/common.js', () => ({
  ...http, codeOf: (r: any) => r.json?.error?.code ?? '', brief: (r: any) => String(r.status),
}));
vi.mock('../../../../scripts/livetest/journeys/auth.js', () => ({}));
vi.mock('../../../../scripts/livetest/provision.js', () => ({}));
vi.mock('../../../../scripts/livetest/journeys/customer.js', () => ({}));
vi.mock('../../../../scripts/livetest/journeys/dispatch.js', () => ({}));
vi.mock('../../../../scripts/livetest/roster.js', () => ({ BUSINESS_PHONE: 'synthetic' }));

const ROOT = join(__dirname, '../../../..');
let completeCourierFixture: any;
let VEND_04: any;
beforeAll(async () => {
  ({ completeCourierFixture } = await import(pathToFileURL(join(ROOT, 'scripts/livetest/courier-cleanup.ts')).href));
  ({ VEND_04 } = await import(pathToFileURL(join(ROOT, 'scripts/livetest/journeys/vendor.ts')).href));
});

const reply = (status: number, data: unknown = {}, code?: string) => ({ status, ok: status >= 200 && status < 300, json: { data, ...(code ? { error: { code } } : {}) }, text: '' });
const session = { token: 'synthetic-session', userId: 'synthetic-rider' };
const gps = { lat: 6.8, lng: -58.1 };
const leg = { id: 'synthetic-order', status: 'ARRIVED', paymentMethod: 'CASH', paymentStatus: 'CAPTURED', courierPayer: 'SENDER' };
beforeEach(() => {
  vi.resetAllMocks();
  http.upload.mockResolvedValue(reply(201, { url: '/synthetic-issued-proof' }));
  http.POST.mockResolvedValue(reply(200));
});

describe('synthetic courier cleanup follows issued proof and payment contracts', () => {
  it.each(['CASH', 'MOBILE_MONEY'])('completes captured %s with issued proof and no new cash declaration', async (paymentMethod) => {
    await completeCourierFixture(session, { ...leg, paymentMethod }, gps);
    expect(http.upload.mock.calls[0]?.slice(0, 2)).toEqual(['/courier/order/synthetic-order/proof-photo', session.token]);
    expect(http.POST).toHaveBeenCalledWith('/courier/order/synthetic-order/proof', { proofPhotoUrl: '/synthetic-issued-proof' }, session.token);
  });
  it('records only the pending recipient cash outcome with proof', async () => {
    await completeCourierFixture(session, { ...leg, paymentStatus: 'PENDING', courierPayer: 'RECIPIENT' }, gps);
    expect(http.POST).toHaveBeenCalledWith('/courier/order/synthetic-order/proof', {
      proofPhotoUrl: '/synthetic-issued-proof', outcome: 'paid', gps,
    }, session.token);
  });
  it.each([
    { status: 'RIDER_ASSIGNED' }, { status: 'RETURNING' },
    { paymentStatus: 'PENDING', courierPayer: 'SENDER' },
    { paymentStatus: 'PENDING', courierPayer: null },
    { paymentStatus: 'PENDING', paymentMethod: 'MOBILE_MONEY' },
  ])('leaves unsupported state or unpaid sender untouched: %o', async (change) => {
    expect((await completeCourierFixture(session, { ...leg, ...change }, gps)).ok).toBe(false);
    expect(http.upload).not.toHaveBeenCalled();
    expect(http.POST).not.toHaveBeenCalled();
  });
  it.each([reply(503), reply(201, {})])('never completes without a successful issued URL: %o', async (uploadResult) => {
    http.upload.mockResolvedValue(uploadResult);
    expect((await completeCourierFixture(session, leg, gps)).ok).toBe(false);
    expect(http.POST).not.toHaveBeenCalled();
  });
});

describe('billing journey acknowledges cold sessions without bypassing step-up', () => {
  const ctx = { roster: { vendors: { R1: { session: { token: 'owner-session' } } }, customers: { C2: { session: { token: 'customer-session' } } } } };
  const recorder = () => ({ check: vi.fn(), expect: vi.fn(), deny: vi.fn(), skipCase: vi.fn(), skipAll: vi.fn() });
  beforeEach(() => {
    http.GET.mockImplementation(async (_path: string, token: string) => token === 'customer-session' ? reply(403) : reply(200, { status: 'ACTIVE', weeklyFeeGyd: 100, san: 'synthetic' }));
    http.req.mockResolvedValue(reply(503));
  });
  it('records the cold refusal, skips positive changes and still checks ownership without requesting SMS', async () => {
    http.PUT.mockResolvedValue(reply(403, {}, 'STEP_UP_REQUIRED'));
    const rec = recorder();
    await VEND_04.run!(rec, ctx);
    expect(http.PUT.mock.calls.map((call) => call[1])).toEqual([{ method: 'CASH' }]);
    expect(rec.skipCase).toHaveBeenCalledWith('stop billing', expect.stringContaining('verified session'));
    expect(http.GET).toHaveBeenCalledWith('/vendor/subscription', 'customer-session');
    expect(http.POST).not.toHaveBeenCalled();
    expect(http.req.mock.calls.every((call) => !String(call[1]).startsWith('/auth/'))).toBe(true);
  });
  it('retains all billing changes and payer validation for a legitimately warm session', async () => {
    http.PUT.mockImplementation(async (_path: string, body: { method: string }) => body.method === 'MOBILE_MONEY' ? reply(400, {}, 'MSISDN_REQUIRED') : reply(200));
    const rec = recorder();
    await VEND_04.run!(rec, ctx);
    expect(http.PUT.mock.calls.map((call) => call[1].method)).toEqual(['CASH', 'MOBILE_MONEY', 'NONE', 'CASH']);
    expect(rec.skipCase).not.toHaveBeenCalled();
    expect(rec.deny).toHaveBeenCalledWith('MMG billing without the payer number', expect.objectContaining({ status: 400 }), [400], ['MSISDN_REQUIRED']);
    expect(http.POST).not.toHaveBeenCalled();
  });
});
