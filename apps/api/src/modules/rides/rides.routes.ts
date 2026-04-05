import type { FastifyInstance } from 'fastify';

/**
 * Module A: Rides — Uber-style ride-hailing
 *
 * Endpoints:
 * POST /rides/estimate     — Get fare estimate for pickup → dropoff
 * POST /rides/request      — Request a ride (creates order type=TAXI)
 * GET  /rides/:id          — Get ride details
 * POST /rides/:id/cancel   — Cancel ride (5-min free window)
 * GET  /rides/active       — Get active ride for customer
 * GET  /rides/history      — Past rides with pagination
 *
 * Car types: SwiftX, SwiftComfort, SwiftXL, SwiftPremium
 * Features: surge pricing, driver matching, PIN verification, live tracking
 */
export default async function ridesRoutes(app: FastifyInstance) {
  // TODO: Implement ride request flow
  // TODO: Implement fare estimation with surge
  // TODO: Implement driver matching algorithm
}
