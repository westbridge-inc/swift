import { haversineDistance } from '../../utils/distance';

// ---------------------------------------------------------------------------
// The batch planner — VROOM, with the cash float as a hard constraint.
//
// A `DispatchPlanner` already exists and stays exactly as it is: capacity ONE
// vehicle, one order per rider, "so the cash-float model stays intact". That
// planner answers "who takes this order". This one answers a different
// question — "which orders travel together" — and it cannot borrow the same
// shape, because the moment a rider carries two cash orders the float stops
// being a property of the order and becomes a property of the ROUTE.
//
// WHY THE FLOAT IS IN THE MODEL AND NOT A FILTER AFTERWARDS
//
// `eligibility.ts` already has R4: summed cash within the rider's float cap.
// It is applied to a batch someone else proposed. Hand VROOM an unconstrained
// problem and it returns the cost-minimal route, which for a cash marketplace
// is frequently a beautiful five-stop run the rider cannot fund; R4 then
// rejects it and the optimisation is thrown away. Worse, the second-best route
// VROOM never returned might have been fundable.
//
// VROOM supports multiple capacity dimensions natively, so the float belongs
// beside the size points as dimension [1]. Then every route it returns is
// fundable BY CONSTRUCTION, and R4 becomes a check that should never fire
// rather than a filter doing the real work.
//
// The concurrency notes put it plainly and this file exists to respect it:
// the real ceiling on batching is CASH FLOAT, not routing efficiency.
//
// SHADOW ONLY. Nothing here assigns anything. The caller records what VROOM
// WOULD have routed as evidence rows beside the existing shadow scan, because
// a batching go/no-go reads weeks of those rows — and rider consent is the
// other invariant this must never bypass: a plan is not an accepted offer.
// ---------------------------------------------------------------------------

export interface BatchJob {
  orderId: string;
  /** Where the rider collects. */
  pickup: { lat: number; lng: number };
  /** Where it goes. */
  dropoff: { lat: number; lng: number };
  /** Size points — the same currency R3 counts in. */
  sizePoints: number;
  /** Cash the rider fronts for this order. Zero for a prepaid order. */
  cashToCollect: number;
}

export interface BatchVehicle {
  riderId: string;
  lat: number;
  lng: number;
  /** R3's capacity for this vehicle type (BICYCLE 3, MOTORBIKE 4, CAR 6). */
  capacityPoints: number;
  /** R4's ceiling: what this rider may still front, right now. */
  availableFloat: number;
}

export interface PlannedRun {
  riderId: string;
  /** In the order VROOM wants them served. */
  orderIds: string[];
  /** Summed size points — must be ≤ the vehicle's capacityPoints. */
  points: number;
  /** Summed cash — must be ≤ the vehicle's availableFloat. */
  cash: number;
}

export interface BatchPlanner {
  /** Group jobs into per-rider runs. A job no rider can fund or carry is
   *  simply absent — never silently squeezed into a route. */
  planRuns(jobs: BatchJob[], vehicles: BatchVehicle[]): Promise<PlannedRun[]>;
}

/** A run is never planned across a pickup further away than this. */
export const MAX_PICKUP_KM = 10;

/**
 * The floor: every job on its own.
 *
 * Not a degraded mode — it is what the platform does today, so a solver that
 * is down, slow or wrong costs nothing. Also the honest baseline the shadow
 * evidence is measured AGAINST: "VROOM saved N metres" only means something
 * next to what solo delivery would have travelled.
 */
export class SoloBatchPlanner implements BatchPlanner {
  async planRuns(jobs: BatchJob[], vehicles: BatchVehicle[]): Promise<PlannedRun[]> {
    const free = [...vehicles];
    const out: PlannedRun[] = [];
    for (const job of jobs) {
      const idx = free.findIndex(
        (v) =>
          v.capacityPoints >= job.sizePoints &&
          v.availableFloat >= job.cashToCollect &&
          haversineDistance(job.pickup.lat, job.pickup.lng, v.lat, v.lng) <= MAX_PICKUP_KM,
      );
      if (idx < 0) continue;
      out.push({ riderId: free[idx]!.riderId, orderIds: [job.orderId], points: job.sizePoints, cash: job.cashToCollect });
      free.splice(idx, 1);
    }
    return out;
  }
}

const VROOM_TIMEOUT_MS = 5000;

interface VroomShipmentResponse {
  code?: number;
  routes?: Array<{
    vehicle?: number;
    steps?: Array<{ type?: string; id?: number; job?: number }>;
  }>;
  unassigned?: Array<{ id?: number }>;
}

export class VroomBatchPlanner implements BatchPlanner {
  private fallback = new SoloBatchPlanner();

  constructor(private baseUrl: string) {}

  async planRuns(jobs: BatchJob[], vehicles: BatchVehicle[]): Promise<PlannedRun[]> {
    if (jobs.length === 0 || vehicles.length === 0) return [];
    // Nothing to group. Skipping the round-trip also keeps the solver out of
    // the common case entirely, which is most of them.
    if (jobs.length === 1) return this.fallback.planRuns(jobs, vehicles);

    const body = {
      // A delivery is a SHIPMENT — a pickup and a dropoff that must be served
      // by the same vehicle, pickup first. Modelling it as two independent
      // jobs would let VROOM route a dropoff before its own collection.
      shipments: jobs.map((j, i) => ({
        pickup: { id: i, location: [j.pickup.lng, j.pickup.lat] },
        delivery: { id: i, location: [j.dropoff.lng, j.dropoff.lat] },
        // [points, cash] — dimension 1 is the float, and it is what makes an
        // unfundable route unrepresentable rather than merely rejected later.
        amount: [j.sizePoints, Math.round(j.cashToCollect)],
      })),
      vehicles: vehicles.map((v, i) => ({
        id: i,
        start: [v.lng, v.lat],
        capacity: [v.capacityPoints, Math.round(v.availableFloat)],
      })),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VROOM_TIMEOUT_MS);
    try {
      const res = await fetch(this.baseUrl.replace(/\/$/, ''), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return this.fallback.planRuns(jobs, vehicles);
      const data = (await res.json()) as VroomShipmentResponse;
      if (data.code !== 0 || !data.routes) return this.fallback.planRuns(jobs, vehicles);
      return this.readRoutes(data, jobs, vehicles);
    } catch {
      // Solver down, slow or unreachable — the platform's own behaviour
      // carries on. A batching experiment may never cost a delivery.
      return this.fallback.planRuns(jobs, vehicles);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read the solver's answer, and re-check it.
   *
   * The constraints are in the model, so a correct VROOM cannot return an
   * over-capacity or unfundable route. This verifies anyway: the cost of a
   * wrong answer here is a rider fronting cash they do not have, and "the
   * solver would not do that" is a belief, not a guarantee. A route that fails
   * its own constraints is DROPPED, never trimmed to fit — trimming would
   * silently change which orders a person was planned to carry.
   */
  private readRoutes(data: VroomShipmentResponse, jobs: BatchJob[], vehicles: BatchVehicle[]): PlannedRun[] {
    const out: PlannedRun[] = [];
    for (const route of data.routes ?? []) {
      const vehicle = vehicles[route.vehicle ?? -1];
      if (!vehicle) continue;

      // Order matters and the pickup step is what establishes it: a shipment
      // appears twice, and taking both would double-count its cash.
      const orderIds: string[] = [];
      for (const step of route.steps ?? []) {
        if (step.type !== 'pickup') continue;
        const job = step.id != null ? jobs[step.id] : undefined;
        if (job) orderIds.push(job.orderId);
      }
      if (orderIds.length === 0) continue;

      const served = orderIds.map((id) => jobs.find((j) => j.orderId === id)!).filter(Boolean);
      const points = served.reduce((s, j) => s + j.sizePoints, 0);
      const cash = served.reduce((s, j) => s + j.cashToCollect, 0);
      if (points > vehicle.capacityPoints) continue;
      if (cash > vehicle.availableFloat) continue;
      // The historical range cap applies to the FIRST pickup — where the rider
      // actually has to travel to from where they are standing.
      const first = served[0]!;
      if (haversineDistance(first.pickup.lat, first.pickup.lng, vehicle.lat, vehicle.lng) > MAX_PICKUP_KM) continue;

      out.push({ riderId: vehicle.riderId, orderIds, points, cash });
    }
    return out;
  }
}

/** Selection is config, not code — and it defaults to solo, which is today. */
export function getBatchPlanner(env: Record<string, string | undefined> = process.env): BatchPlanner {
  const planner = env['BATCH_PLANNER'] ?? 'solo';
  switch (planner) {
    case 'solo':
      return new SoloBatchPlanner();
    case 'vroom': {
      const baseUrl = env['VROOM_URL'];
      if (!baseUrl) throw new Error('VROOM_URL is required when BATCH_PLANNER=vroom');
      return new VroomBatchPlanner(baseUrl);
    }
    default:
      throw new Error(`Unknown BATCH_PLANNER: ${planner}`);
  }
}

// ── What the evidence row says ─────────────────────────────────────────────

export interface RunSaving {
  riderId: string;
  orderIds: string[];
  /** Metres the planned run travels, pickup order included. */
  plannedM: number;
  /** Metres the same orders would travel served one at a time. */
  soloM: number;
  /** soloM − plannedM. Negative means batching was WORSE. */
  savedM: number;
}

const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  Math.round(haversineDistance(a.lat, a.lng, b.lat, b.lng) * 1000);

/**
 * What this run saved, against the honest baseline.
 *
 * Straight-line, and deliberately so in shadow: OSRM road distance is the
 * right number for a live offer, but it is a call per leg per tick, and an
 * evidence sweep that costs a routing storm gets turned off. Straight-line is
 * a CONSERVATIVE proxy here — it understates the detour a real road network
 * imposes on a multi-stop run, so it understates the saving too, and evidence
 * that errs against the change it is arguing for is the kind worth reading.
 *
 * A negative saving is reported, never clipped to zero. The whole point of two
 * weeks of these rows is to find out whether batching helps in Georgetown, and
 * a metric that cannot say "no" answers nothing.
 */
export function runSaving(run: PlannedRun, jobs: BatchJob[], vehicle: { lat: number; lng: number }): RunSaving {
  const served = run.orderIds.map((id) => jobs.find((j) => j.orderId === id)).filter((j): j is BatchJob => !!j);
  if (served.length === 0) {
    return { riderId: run.riderId, orderIds: run.orderIds, plannedM: 0, soloM: 0, savedM: 0 };
  }

  // Planned: rider → every pickup in order → every dropoff in order.
  let plannedM = metres(vehicle, served[0]!.pickup);
  for (let i = 1; i < served.length; i += 1) plannedM += metres(served[i - 1]!.pickup, served[i]!.pickup);
  plannedM += metres(served[served.length - 1]!.pickup, served[0]!.dropoff);
  for (let i = 1; i < served.length; i += 1) plannedM += metres(served[i - 1]!.dropoff, served[i]!.dropoff);

  // Solo: rider → p1 → d1 → p2 → d2 … — the SAME stops, served one order
  // fully before the next, continuing from where the last one ended.
  //
  // An earlier version charged the rider a trip from their starting position
  // before EVERY order, as if they teleported home between deliveries. That
  // inflates the baseline and makes batching look better than it is, which is
  // the one direction this number must never err in: the whole purpose of the
  // evidence is to find out whether batching is worth doing at all. Batching's
  // saving comes from interleaving pickups and dropoffs, not from avoiding a
  // return journey nobody makes.
  let soloM = metres(vehicle, served[0]!.pickup) + metres(served[0]!.pickup, served[0]!.dropoff);
  for (let i = 1; i < served.length; i += 1) {
    soloM += metres(served[i - 1]!.dropoff, served[i]!.pickup) + metres(served[i]!.pickup, served[i]!.dropoff);
  }

  return { riderId: run.riderId, orderIds: run.orderIds, plannedM, soloM, savedM: soloM - plannedM };
}
