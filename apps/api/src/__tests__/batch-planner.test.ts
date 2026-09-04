import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  SoloBatchPlanner, VroomBatchPlanner, getBatchPlanner, runSaving, MAX_PICKUP_KM,
  type BatchJob, type BatchVehicle, type PlannedRun,
} from '../providers/dispatch/batch-planner';

// ---------------------------------------------------------------------------
// The batch planner — VROOM with the cash float as a hard constraint.
//
// A rider carrying two cash orders fronts both. The moment orders travel
// together the float stops being a property of the order and becomes a
// property of the ROUTE, which is why it goes into the VROOM model as a
// capacity dimension rather than staying a filter applied afterwards: an
// unfundable route must be unrepresentable, not merely rejected.
//
// The concurrency notes say the real ceiling on batching is CASH FLOAT, not
// routing efficiency. These tests are that sentence, executable.
//
// Everything here is SHADOW. Nothing assigns. A plan is not an accepted offer,
// and rider consent is the other invariant this must never bypass.
// ---------------------------------------------------------------------------

const GT = { lat: 6.8055, lng: -58.1553 };
const near = (dLat = 0, dLng = 0) => ({ lat: GT.lat + dLat, lng: GT.lng + dLng });

const JOB = (over: Partial<BatchJob> = {}): BatchJob => ({
  orderId: 'o1',
  pickup: near(0.001, 0.001),
  dropoff: near(0.004, 0.004),
  sizePoints: 2,
  cashToCollect: 1000,
  ...over,
});

const RIDER = (over: Partial<BatchVehicle> = {}): BatchVehicle => ({
  riderId: 'r1', ...GT, capacityPoints: 4, availableFloat: 5000, ...over,
});

afterEach(() => vi.unstubAllGlobals());

/** A VROOM that returns exactly the routes a test dictates. */
function stubVroom(routes: Array<{ vehicle: number; pickupIds: number[] }>, code = 0) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      code,
      routes: routes.map((r) => ({
        vehicle: r.vehicle,
        steps: [
          { type: 'start' },
          ...r.pickupIds.flatMap((id) => [{ type: 'pickup', id }, { type: 'delivery', id }]),
          { type: 'end' },
        ],
      })),
    }),
  })));
}

describe('the floor: every order on its own', () => {
  it('is what the platform does today, so a dead solver costs nothing', async () => {
    const runs = await new SoloBatchPlanner().planRuns([JOB(), JOB({ orderId: 'o2' })], [RIDER(), RIDER({ riderId: 'r2' })]);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.orderIds.length === 1)).toBe(true);
  });

  it('will not hand a rider an order they cannot fund or carry', async () => {
    const broke = RIDER({ availableFloat: 500 });
    expect(await new SoloBatchPlanner().planRuns([JOB({ cashToCollect: 4000 })], [broke])).toEqual([]);
    const small = RIDER({ capacityPoints: 1 });
    expect(await new SoloBatchPlanner().planRuns([JOB({ sizePoints: 4 })], [small])).toEqual([]);
  });

  it('respects the range cap on the pickup', async () => {
    const far = JOB({ pickup: { lat: GT.lat + 1, lng: GT.lng + 1 } }); // ~150 km
    expect(await new SoloBatchPlanner().planRuns([far], [RIDER()])).toEqual([]);
  });
});

describe('the float is a CONSTRAINT, not a filter', () => {
  it('goes to VROOM as a capacity dimension beside the size points', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, routes: [] }) }));
    vi.stubGlobal('fetch', fetchSpy);
    await new VroomBatchPlanner('http://vroom').planRuns(
      [JOB({ orderId: 'a', sizePoints: 2, cashToCollect: 1500 }), JOB({ orderId: 'b', sizePoints: 1, cashToCollect: 900 })],
      [RIDER({ capacityPoints: 4, availableFloat: 5000 })],
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]! as unknown as [string, { body: string }])[1].body);
    // Dimension 0 is size points, dimension 1 is cash. If the cash ever stops
    // being sent, VROOM starts returning routes nobody can fund.
    expect(body.shipments[0].amount).toEqual([2, 1500]);
    expect(body.shipments[1].amount).toEqual([1, 900]);
    expect(body.vehicles[0].capacity).toEqual([4, 5000]);
  });

  it('models a delivery as a SHIPMENT so a dropoff cannot precede its pickup', async () => {
    // Two independent jobs would let the solver route a delivery before the
    // rider has collected it — a route that is cheaper and impossible.
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, routes: [] }) }));
    vi.stubGlobal('fetch', fetchSpy);
    await new VroomBatchPlanner('http://vroom').planRuns([JOB({ orderId: 'a' }), JOB({ orderId: 'b' })], [RIDER()]);
    const body = JSON.parse((fetchSpy.mock.calls[0]! as unknown as [string, { body: string }])[1].body);
    expect(body.shipments).toBeDefined();
    expect(body.jobs).toBeUndefined();
    expect(body.shipments[0]).toHaveProperty('pickup');
    expect(body.shipments[0]).toHaveProperty('delivery');
  });

  it('DROPS a returned route that would overdraw the float', async () => {
    // The constraint is in the model, so a correct solver cannot do this. The
    // cost of being wrong is a rider fronting money they do not have, and "the
    // solver would not do that" is a belief, not a guarantee.
    stubVroom([{ vehicle: 0, pickupIds: [0, 1] }]);
    const runs = await new VroomBatchPlanner('http://vroom').planRuns(
      [JOB({ orderId: 'a', cashToCollect: 3000 }), JOB({ orderId: 'b', cashToCollect: 3000 })],
      [RIDER({ availableFloat: 4000 })],
    );
    expect(runs).toEqual([]);
  });

  it('DROPS an over-capacity route rather than trimming it to fit', async () => {
    // Trimming would silently change which orders a person was planned to
    // carry, and the evidence row would describe a run that was never planned.
    stubVroom([{ vehicle: 0, pickupIds: [0, 1] }]);
    const runs = await new VroomBatchPlanner('http://vroom').planRuns(
      [JOB({ orderId: 'a', sizePoints: 3 }), JOB({ orderId: 'b', sizePoints: 3 })],
      [RIDER({ capacityPoints: 4 })],
    );
    expect(runs).toEqual([]);
  });

  it('keeps a route that fits both dimensions, in the solver\'s order', async () => {
    stubVroom([{ vehicle: 0, pickupIds: [1, 0] }]);
    const runs = await new VroomBatchPlanner('http://vroom').planRuns(
      [JOB({ orderId: 'a', sizePoints: 2, cashToCollect: 1000 }), JOB({ orderId: 'b', sizePoints: 2, cashToCollect: 1000 })],
      [RIDER({ capacityPoints: 4, availableFloat: 5000 })],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.orderIds).toEqual(['b', 'a']); // order preserved
    expect(runs[0]!.cash).toBe(2000);
    expect(runs[0]!.points).toBe(4);
  });

  it('counts each shipment once, not twice', async () => {
    // A shipment appears as a pickup AND a delivery step. Reading both would
    // double its cash and reject fundable runs — or, worse, pass unfundable
    // ones if the arithmetic went the other way.
    stubVroom([{ vehicle: 0, pickupIds: [0] }]);
    const runs = await new VroomBatchPlanner('http://vroom').planRuns(
      [JOB({ orderId: 'a', cashToCollect: 1000 }), JOB({ orderId: 'b' })],
      [RIDER({ availableFloat: 1500 })],
    );
    expect(runs[0]!.cash).toBe(1000);
  });
});

describe('a batching experiment may never cost a delivery', () => {
  it('falls back to solo when the solver errors, times out or answers badly', async () => {
    const jobs = [JOB({ orderId: 'a' }), JOB({ orderId: 'b' })];
    const riders = [RIDER(), RIDER({ riderId: 'r2' })];

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await new VroomBatchPlanner('http://vroom').planRuns(jobs, riders)).toHaveLength(2);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await new VroomBatchPlanner('http://vroom').planRuns(jobs, riders)).toHaveLength(2);

    stubVroom([], 3); // VROOM's own error code
    expect(await new VroomBatchPlanner('http://vroom').planRuns(jobs, riders)).toHaveLength(2);
  });

  it('does not call the solver when there is nothing to group', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await new VroomBatchPlanner('http://vroom').planRuns([JOB()], [RIDER()]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('defaults to solo — today\'s behaviour — and needs a URL to use VROOM', () => {
    expect(getBatchPlanner({})).toBeInstanceOf(SoloBatchPlanner);
    expect(() => getBatchPlanner({ BATCH_PLANNER: 'vroom' })).toThrow(/VROOM_URL/);
    expect(getBatchPlanner({ BATCH_PLANNER: 'vroom', VROOM_URL: 'http://v' })).toBeInstanceOf(VroomBatchPlanner);
    expect(() => getBatchPlanner({ BATCH_PLANNER: 'magic' })).toThrow(/Unknown/);
  });
});

describe('what the evidence row says', () => {
  const A = JOB({ orderId: 'a', pickup: near(0.002, 0), dropoff: near(0.02, 0) });
  const B = JOB({ orderId: 'b', pickup: near(0.002, 0.0001), dropoff: near(0.021, 0) });

  it('measures the run against serving the same orders one at a time', () => {
    const run: PlannedRun = { riderId: 'r1', orderIds: ['a', 'b'], points: 4, cash: 2000 };
    const s = runSaving(run, [A, B], GT);
    expect(s.plannedM).toBeGreaterThan(0);
    expect(s.soloM).toBeGreaterThan(0);
    expect(s.savedM).toBe(s.soloM - s.plannedM);
    // Two orders from nearly the same shop to nearly the same street is the
    // case batching exists for — it must show a saving or the metric is wrong.
    expect(s.savedM).toBeGreaterThan(0);
  });

  it('reports a NEGATIVE saving instead of clipping it to zero', () => {
    // Two weeks of these rows exist to answer whether batching helps in
    // Georgetown. A metric that cannot say "no" answers nothing.
    //
    // The losing shape, and it is worth naming because it is common: one SHORT
    // local delivery and one further away. Batched, the rider collects both
    // before delivering either, so they cross the long leg THREE times —
    // out to the far pickup, back for the near dropoff, out again. Served one
    // at a time they cross it once.
    const shortLocal = JOB({ orderId: 'a', pickup: near(0, 0), dropoff: near(0.002, 0) });
    const farAway = JOB({ orderId: 'b', pickup: near(0.03, 0), dropoff: near(0.032, 0) });
    const run: PlannedRun = { riderId: 'r1', orderIds: ['a', 'b'], points: 4, cash: 2000 };
    const s = runSaving(run, [shortLocal, farAway], GT);
    expect(s.savedM).toBeLessThan(0);
    expect(s.plannedM).toBeGreaterThan(s.soloM);
  });

  it('is zero-safe when the run names orders that are gone', () => {
    const s = runSaving({ riderId: 'r1', orderIds: ['ghost'], points: 0, cash: 0 }, [A], GT);
    expect(s).toMatchObject({ plannedM: 0, soloM: 0, savedM: 0 });
  });
});

describe('the range cap survives the solver', () => {
  it('drops a run whose FIRST pickup is beyond the cap', async () => {
    stubVroom([{ vehicle: 0, pickupIds: [0] }]);
    const far = JOB({ orderId: 'far', pickup: { lat: GT.lat + 1, lng: GT.lng } });
    const runs = await new VroomBatchPlanner('http://vroom').planRuns([far, JOB({ orderId: 'b' })], [RIDER()]);
    expect(runs).toEqual([]);
    expect(MAX_PICKUP_KM).toBe(10);
  });
});
