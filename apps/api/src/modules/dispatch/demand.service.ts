import type { PrismaClient } from '@prisma/client';
import { haversineDistance } from '../../utils/distance';

/**
 * Earner-facing demand reads (dashboard plan Phase A) — the availability
 * framework in reverse: REAL waiting work, shown to the people who can take
 * it. Privacy is structural: taxi pickups are rounded to ~300 m and carry no
 * customer fields; delivery demand is grouped by VENDOR (public storefront
 * data). Nothing here reveals who is waiting — only that work exists.
 */

/** How far back a waiting taxi request still counts as live demand. */
const TAXI_DEMAND_WINDOW_MIN = 15;
/** ~300 m snap: coarse enough to hide a doorstep, fine enough to drive toward. */
const POINT_SNAP_DEG = 0.003;
/** ~1.3 km cluster cells for the "N waiting near here" badges. */
const CLUSTER_CELL_DEG = 0.012;

const snap = (v: number, step: number) => Math.round(v / step) * step;

export type DemandPoint = { lat: number; lng: number };
export type DemandCluster = { lat: number; lng: number; count: number };

function clusterPoints(points: DemandPoint[]): DemandCluster[] {
  const cells = new Map<string, { latSum: number; lngSum: number; count: number }>();
  for (const p of points) {
    const key = `${snap(p.lat, CLUSTER_CELL_DEG)}:${snap(p.lng, CLUSTER_CELL_DEG)}`;
    const c = cells.get(key) ?? { latSum: 0, lngSum: 0, count: 0 };
    c.latSum += p.lat;
    c.lngSum += p.lng;
    c.count += 1;
    cells.set(key, c);
  }
  return [...cells.values()]
    .map((c) => ({ lat: c.latSum / c.count, lng: c.lngSum / c.count, count: c.count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Taxi demand around a driver: waiting requests (PENDING, unassigned, fresh)
 * plus active supply-watchers ("notify me when a driver is available") —
 * people who WANT a ride the moment someone goes online.
 */
export async function driverDemand(
  prisma: PrismaClient,
  at: { lat: number; lng: number },
  radiusKm = 8,
): Promise<{ waiting: number; watchers: number; points: DemandPoint[]; clusters: DemandCluster[] }> {
  const since = new Date(Date.now() - TAXI_DEMAND_WINDOW_MIN * 60_000);
  const [requests, watches] = await Promise.all([
    prisma.order.findMany({
      where: {
        orderType: 'TAXI',
        status: 'PENDING',
        driverId: null,
        placedAt: { gte: since },
        pickupLat: { not: null },
        pickupLng: { not: null },
      },
      select: { pickupLat: true, pickupLng: true },
      take: 500,
    }),
    prisma.supplyWatch.findMany({
      where: { pool: 'DRIVER', notifiedAt: null, expiresAt: { gt: new Date() } },
      select: { lat: true, lng: true },
      take: 500,
    }),
  ]);

  const near = (lat: number, lng: number) => haversineDistance(at.lat, at.lng, lat, lng) <= radiusKm;
  const points = requests
    .filter((r) => near(Number(r.pickupLat), Number(r.pickupLng)))
    .map((r) => ({ lat: snap(Number(r.pickupLat), POINT_SNAP_DEG), lng: snap(Number(r.pickupLng), POINT_SNAP_DEG) }));
  const watchers = watches.filter((w) => near(w.lat, w.lng)).length;

  return { waiting: points.length, watchers, points, clusters: clusterPoints(points) };
}

export type VendorDemand = {
  vendorId: string;
  name: string;
  lat: number;
  lng: number;
  ready: number;
  soon: number;
  feesWaiting: number;
};

/**
 * Delivery demand around a rider: unassigned vendor-backed deliveries,
 * grouped by store — READY (collect now) vs SOON (in the kitchen), with the
 * delivery fees waiting at each store. Held orders stay invisible.
 */
export async function riderDemand(
  prisma: PrismaClient,
  at: { lat: number; lng: number },
  radiusKm = 8,
): Promise<{ ready: number; soon: number; stores: VendorDemand[] }> {
  const orders = await prisma.order.findMany({
    where: {
      fulfillment: 'DELIVERY',
      riderId: null,
      vendorId: { not: null },
      orderType: { not: 'TAXI' },
      status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
      OR: [{ holdExpiresAt: null }, { holdExpiresAt: { lte: new Date() } }],
    },
    select: {
      status: true,
      deliveryFee: true,
      vendor: { select: { id: true, name: true, latitude: true, longitude: true } },
    },
    take: 500,
  });

  const byVendor = new Map<string, VendorDemand>();
  for (const o of orders) {
    const v = o.vendor;
    if (!v || haversineDistance(at.lat, at.lng, v.latitude, v.longitude) > radiusKm) continue;
    const row = byVendor.get(v.id) ?? {
      vendorId: v.id, name: v.name, lat: v.latitude, lng: v.longitude,
      ready: 0, soon: 0, feesWaiting: 0,
    };
    if (o.status === 'READY_FOR_PICKUP') row.ready += 1;
    else row.soon += 1;
    row.feesWaiting += Number(o.deliveryFee ?? 0);
    byVendor.set(v.id, row);
  }

  const stores = [...byVendor.values()].sort((a, b) => b.ready - a.ready || b.soon - a.soon);
  return {
    ready: stores.reduce((s, v) => s + v.ready, 0),
    soon: stores.reduce((s, v) => s + v.soon, 0),
    stores,
  };
}
