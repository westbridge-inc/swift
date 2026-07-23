import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPlacesProvider } from '../../providers/places/places-provider';

// ---------------------------------------------------------------------------
// Places — the "Where to?" destination search behind the swappable
// PlacesProvider seam (hard rule 4). The Google key never leaves the server:
// the mobile app only ever calls these authenticated endpoints.
// ---------------------------------------------------------------------------

const autocompleteSchema = z.object({
  q: z.string().trim().min(1).max(120),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

const detailsSchema = z.object({
  placeId: z.string().trim().min(1).max(400),
});

const reverseSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

export async function placesRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const places = getPlacesProvider(app.prisma);

  /** GET /autocomplete?q=&lat=&lng= — destination suggestions, proximity-biased. */
  app.get('/autocomplete', auth, async (request) => {
    const { q, lat, lng } = autocompleteSchema.parse(request.query);
    const near = lat != null && lng != null ? { lat, lng } : undefined;
    const suggestions = await places.autocomplete(q, { near, userId: request.user.userId });
    return { success: true, data: suggestions };
  });

  /** GET /details?placeId= — resolve a suggestion to a labelled coordinate. */
  app.get('/details', auth, async (request) => {
    const { placeId } = detailsSchema.parse(request.query);
    // Scope saved-address (`addr:`) resolution to the caller — otherwise any
    // authenticated user could resolve another user's address id (IDOR).
    const detail = await places.details(placeId, { userId: request.user.userId });
    return { success: true, data: detail };
  });

  /** GET /reverse?lat=&lng= — a human address label for a coordinate [SWIFT-111].
   *  Wires the provider's reverseGeocode (implemented across all three adapters
   *  but previously unrouted) to "use my current location" address prefill. */
  app.get('/reverse', auth, async (request) => {
    const { lat, lng } = reverseSchema.parse(request.query);
    const address = await places.reverseGeocode({ lat, lng });
    return { success: true, data: { address } };
  });
}
