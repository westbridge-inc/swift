import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GreedyDispatchPlanner,
  VroomDispatchPlanner,
  getDispatchPlanner,
} from '../providers/dispatch/dispatch-planner';

// ---------------------------------------------------------------------------
// Dispatch planning (build-kit L). The greedy planner mirrors the historical
// nearest-rider rule; VROOM solves the batch globally and falls back to greedy
// on any failure. (The force-assign sweep that applied these plans was removed
// in SWIFT-023; the planner remains a pure library, not wired to a live path.)
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}

// Two pickups and two riders arranged so GREEDY (order A first) picks the
// shared-nearest rider for A, while the GLOBAL optimum swaps them.
const JOB_A = { orderId: 'A', lat: 6.8100, lng: -58.1500 };
const JOB_B = { orderId: 'B', lat: 6.8110, lng: -58.1500 };
const RIDER_1 = { riderId: 'r1', lat: 6.8105, lng: -58.1500 }; // between both
const RIDER_2 = { riderId: 'r2', lat: 6.8000, lng: -58.1500 }; // south — near A only

describe('GreedyDispatchPlanner', () => {
  it('assigns each order the nearest still-free rider within 10km', async () => {
    const plan = await new GreedyDispatchPlanner().planAssignments([JOB_A, JOB_B], [RIDER_1, RIDER_2]);
    // A grabs r1 (nearest overall), B falls to r2.
    expect(plan).toEqual([
      { orderId: 'A', riderId: 'r1' },
      { orderId: 'B', riderId: 'r2' },
    ]);
  });

  it('leaves an order unassigned when nobody is within range', async () => {
    const farJob = { orderId: 'far', lat: 8.0, lng: -59.5 };
    const plan = await new GreedyDispatchPlanner().planAssignments([farJob], [RIDER_1]);
    expect(plan).toEqual([]);
  });
});

describe('VroomDispatchPlanner', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps VROOM routes back to order/rider pairs (index-based ids)', async () => {
    // VROOM's global optimum: vehicle 0 (r1) → job 1 (B); vehicle 1 (r2) → job 0 (A).
    const f = mockFetch(200, {
      code: 0,
      routes: [
        { vehicle: 0, steps: [{ type: 'start' }, { type: 'job', id: 1 }, { type: 'end' }] },
        { vehicle: 1, steps: [{ type: 'start' }, { type: 'job', id: 0 }, { type: 'end' }] },
      ],
    });
    vi.stubGlobal('fetch', f);
    const plan = await new VroomDispatchPlanner('http://vroom.test').planAssignments([JOB_A, JOB_B], [RIDER_1, RIDER_2]);
    expect(plan).toEqual([
      { orderId: 'B', riderId: 'r1' },
      { orderId: 'A', riderId: 'r2' },
    ]);

    const [, init] = f.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.vehicles[0].capacity).toEqual([1]); // one order per rider — cash-float model intact
    expect(body.jobs[0].location).toEqual([JOB_A.lng, JOB_A.lat]); // lng,lat order
  });

  it('falls back to greedy when the solver is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const plan = await new VroomDispatchPlanner('http://vroom.test').planAssignments([JOB_A, JOB_B], [RIDER_1, RIDER_2]);
    expect(plan).toEqual(await new GreedyDispatchPlanner().planAssignments([JOB_A, JOB_B], [RIDER_1, RIDER_2]));
  });

  it('selection is config: greedy default, vroom needs VROOM_URL', () => {
    // The dev .env may point at live local engines — pin a clean env here.
    delete process.env['DISPATCH_PLANNER'];
    delete process.env['VROOM_URL'];
    expect(getDispatchPlanner()).toBeInstanceOf(GreedyDispatchPlanner);
    process.env['DISPATCH_PLANNER'] = 'vroom';
    expect(() => getDispatchPlanner()).toThrow(/VROOM_URL/);
    process.env['VROOM_URL'] = 'http://vroom.test';
    expect(getDispatchPlanner()).toBeInstanceOf(VroomDispatchPlanner);
    delete process.env['DISPATCH_PLANNER'];
    delete process.env['VROOM_URL'];
  });
});

