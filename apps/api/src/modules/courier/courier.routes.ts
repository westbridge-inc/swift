import type { FastifyInstance } from 'fastify';

/**
 * Module C: Courier — Parcel pickup/drop-off
 *
 * Endpoints:
 * POST /courier/estimate       — Price quote (size + distance + speed)
 * POST /courier/order          — Create courier order
 * GET  /courier/order/:id      — Order details
 * POST /courier/order/:id/cancel — Cancel courier order
 * GET  /courier/orders         — Order history
 * GET  /courier/order/:id/track — Live tracking
 *
 * Pricing:
 *   base (1000 GYD)
 *   + distance * 300/km
 *   + size surcharge (S:0, M:500, L:1000, XL:2000)
 *   × speed multiplier (standard:1.0, express:1.5, rush:2.0)
 *
 * Revenue: 100% of courier fee goes to rider
 * Platform earns from rider's weekly subscription ($10K GYD)
 */
export default async function courierRoutes(_app: FastifyInstance) {
  // TODO: Implement courier-specific endpoints
  // Builds on existing rider assignment and order tracking infrastructure
}
