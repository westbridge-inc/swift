import { haversineDistance } from '../../utils/distance';

// ---------------------------------------------------------------------------
// DispatchPlanner — hard rule 4: swappable interface. The rider auto-assign
// sweep hands the CURRENT batch of unassigned deliveries + free riders to the
// planner and applies whatever pairing comes back. Greedy (default) mirrors
// the historical nearest-rider behavior; VROOM solves the batch globally so
// two simultaneous orders never fight over the same nearest rider.
// One order per rider (capacity 1) — the cash-float model stays intact.
// ---------------------------------------------------------------------------

export interface PlanJob {
  orderId: string;
  lat: number;
  lng: number;
}

export interface PlanVehicle {
  riderId: string;
  lat: number;
  lng: number;
}

export interface PlanAssignment {
  orderId: string;
  riderId: string;
}

export interface DispatchPlanner {
  /** Pair each job with at most one vehicle (and vice versa). Jobs that no
   *  vehicle can serve (e.g. none within range) are simply absent. */
  planAssignments(jobs: PlanJob[], vehicles: PlanVehicle[]): Promise<PlanAssignment[]>;
}

/** No rider is auto-assigned to a pickup further than this. */
export const MAX_ASSIGN_KM = 10;

/** The historical behavior: per order, the nearest still-free rider ≤ 10km. */
export class GreedyDispatchPlanner implements DispatchPlanner {
  async planAssignments(jobs: PlanJob[], vehicles: PlanVehicle[]): Promise<PlanAssignment[]> {
    const free = [...vehicles];
    const out: PlanAssignment[] = [];
    for (const job of jobs) {
      let bestIdx = -1;
      let bestKm = Infinity;
      free.forEach((v, i) => {
        const km = haversineDistance(job.lat, job.lng, v.lat, v.lng);
        if (km < bestKm) {
          bestKm = km;
          bestIdx = i;
        }
      });
      if (bestIdx >= 0 && bestKm <= MAX_ASSIGN_KM) {
        out.push({ orderId: job.orderId, riderId: free[bestIdx]!.riderId });
        free.splice(bestIdx, 1);
      }
    }
    return out;
  }
}

// VROOM (vroom-express) — the build kit's dispatch brain. Self-hosted, sits on
// OSRM for travel times. We model each delivery as a job and each rider as a
// capacity-1 vehicle; VROOM returns globally-cost-minimal routes.
const VROOM_TIMEOUT_MS = 5000;

interface VroomResponse {
  code?: number; // 0 = success
  routes?: Array<{
    vehicle?: number;
    steps?: Array<{ type?: string; id?: number }>;
  }>;
}

export class VroomDispatchPlanner implements DispatchPlanner {
  private fallback = new GreedyDispatchPlanner();

  constructor(private baseUrl: string) {}

  async planAssignments(jobs: PlanJob[], vehicles: PlanVehicle[]): Promise<PlanAssignment[]> {
    if (jobs.length === 0 || vehicles.length === 0) return [];
    // A single job/vehicle pair has nothing to optimise — skip the round-trip.
    if (jobs.length === 1 && vehicles.length === 1) return this.fallback.planAssignments(jobs, vehicles);

    const body = {
      jobs: jobs.map((j, i) => ({ id: i, location: [j.lng, j.lat], delivery: [1] })),
      vehicles: vehicles.map((v, i) => ({ id: i, start: [v.lng, v.lat], capacity: [1] })),
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
      if (!res.ok) return this.fallback.planAssignments(jobs, vehicles);
      const data = (await res.json()) as VroomResponse;
      if (data.code !== 0 || !data.routes) return this.fallback.planAssignments(jobs, vehicles);

      const out: PlanAssignment[] = [];
      for (const route of data.routes) {
        const vehicle = vehicles[route.vehicle ?? -1];
        if (!vehicle) continue;
        const jobStep = route.steps?.find((s) => s.type === 'job');
        const job = jobStep?.id != null ? jobs[jobStep.id] : undefined;
        if (!job) continue;
        // Respect the historical range cap even when VROOM finds a route.
        if (haversineDistance(job.lat, job.lng, vehicle.lat, vehicle.lng) > MAX_ASSIGN_KM) continue;
        out.push({ orderId: job.orderId, riderId: vehicle.riderId });
      }
      return out;
    } catch {
      return this.fallback.planAssignments(jobs, vehicles); // solver down — greedy carries on
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Planner selection is config, not code. */
export function getDispatchPlanner(): DispatchPlanner {
  const planner = process.env['DISPATCH_PLANNER'] ?? 'greedy';
  switch (planner) {
    case 'greedy':
      return new GreedyDispatchPlanner();
    case 'vroom': {
      const baseUrl = process.env['VROOM_URL'];
      if (!baseUrl) throw new Error('VROOM_URL is required when DISPATCH_PLANNER=vroom');
      return new VroomDispatchPlanner(baseUrl);
    }
    default:
      throw new Error(`Unknown DISPATCH_PLANNER: ${planner}`);
  }
}
