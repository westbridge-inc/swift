import type { FastifyInstance } from 'fastify';

/**
 * Module B: Eats — Food & grocery delivery
 *
 * Customer-facing endpoints (refactored from customer.routes.ts):
 * GET  /eats/home             — Home feed (featured, nearby, categories)
 * GET  /eats/vendors           — Browse vendors with filters
 * GET  /eats/vendors/:id       — Vendor detail with full menu
 * GET  /eats/vendors/:id/reviews — Vendor reviews
 * GET  /eats/search            — Full-text search (Meilisearch)
 * POST /eats/cart/items         — Add item to cart
 * PUT  /eats/cart/items/:id     — Update cart item
 * DELETE /eats/cart/items/:id   — Remove from cart
 * POST /eats/checkout           — Place order
 * GET  /eats/orders/:id/track   — Live order tracking
 * POST /eats/orders/:id/reorder — One-tap reorder
 *
 * Revenue model: 5% invisible markup on all item prices
 */
export default async function eatsRoutes(app: FastifyInstance) {
  // TODO: Refactor from existing customer.routes.ts
  // The endpoints already exist — this module provides cleaner separation
}
