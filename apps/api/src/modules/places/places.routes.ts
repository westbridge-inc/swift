import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getPlacesProvider, type PlacesProvider } from '../../providers/places/places-provider';
import { PLACES_UNAVAILABLE_CODE, PLACES_UNAVAILABLE_MESSAGE } from '../../providers/places/places-failure';
import {
  getPlacesHealth,
  observePlacesCall,
  placesProviderName,
  PLACES_PAGE_TITLE,
  type PlacesHealth,
  type PlacesObserver,
  type PlacesPager,
} from '../../providers/places/places-health';
import { pageOps, resolveOpsPage } from '../ops/ops-page';
import { NotificationService } from '../notification/notification.service';

// ---------------------------------------------------------------------------
// Places — the "Where to?" destination search behind the swappable
// PlacesProvider seam (hard rule 4). The Google key never leaves the server:
// the mobile app only ever calls these authenticated endpoints.
//
// [PLACES-LOUD 22 Oct 2026] A provider FAILURE is never an empty answer: it is
// 503 PLACES_UNAVAILABLE with a fixed message, logged, counted and (when it
// persists) paged (providers/places/places-health.ts). "No matches" is still
// 200 with [] / null, and so is a request Google refused as the caller's own bad
// input ('rejected'): that is counted and logged at warn but never pages and
// never changes the provider's health. What each store build shows for the 503: builds 9-11
// (no error state) fall back to their "No matches / set it on the map" empty
// state and, for a place that cannot be opened, stay on the list; build 12
// shows its "Search is not working right now ... or set the place on the map"
// state with Try again; the website's place boxes show their "isn't working /
// move the map" notices.
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

export interface PlacesRoutesOptions {
  /** Test seams. Production uses the configured provider, the shared tracker and the ops page. */
  provider?: PlacesProvider;
  health?: PlacesHealth;
  pager?: PlacesPager;
}

function unavailable(reply: FastifyReply) {
  return reply.status(503).send({
    success: false,
    error: { code: PLACES_UNAVAILABLE_CODE, message: PLACES_UNAVAILABLE_MESSAGE },
  });
}

export async function placesRoutes(app: FastifyInstance, opts: PlacesRoutesOptions = {}) {
  const auth = { preHandler: [app.authenticate] };
  const places = opts.provider ?? getPlacesProvider(app.prisma);
  const pager: PlacesPager = opts.pager ?? {
    page: (input) => pageOps({ prisma: app.prisma, redis: app.redis, notifications: new NotificationService(app.prisma, app.io) }, input),
    resolve: () => resolveOpsPage(app.prisma, PLACES_PAGE_TITLE, 'places-recovered'),
  };
  const observer = (log: PlacesObserver['log'], caller: string): PlacesObserver => ({
    provider: placesProviderName(),
    caller,
    health: opts.health ?? getPlacesHealth(),
    pager,
    log,
  });

  /** GET /autocomplete?q=&lat=&lng= — destination suggestions, proximity-biased. */
  app.get('/autocomplete', auth, async (request, reply) => {
    const { q, lat, lng } = autocompleteSchema.parse(request.query);
    const near = lat != null && lng != null ? { lat, lng } : undefined;
    const result = await observePlacesCall(observer(request.log, request.user.userId), 'autocomplete', { queryLength: q.length },
      () => places.autocomplete(q, { near, userId: request.user.userId }), (s) => s.length === 0, []);
    if (!result.ok) return unavailable(reply);
    return { success: true, data: result.value };
  });

  /** GET /details?placeId= — resolve a suggestion to a labelled coordinate. */
  app.get('/details', auth, async (request, reply) => {
    const { placeId } = detailsSchema.parse(request.query);
    // Scope saved-address (`addr:`) resolution to the caller — otherwise any
    // authenticated user could resolve another user's address id (IDOR).
    const result = await observePlacesCall(observer(request.log, request.user.userId), 'details', {},
      () => places.details(placeId, { userId: request.user.userId }), (d) => d === null, null);
    if (!result.ok) return unavailable(reply);
    return { success: true, data: result.value };
  });

  /** GET /reverse?lat=&lng= — a human address label for a coordinate [SWIFT-111].
   *  Wires the provider's reverseGeocode (implemented across all three adapters
   *  but previously unrouted) to "use my current location" address prefill. */
  app.get('/reverse', auth, async (request, reply) => {
    const { lat, lng } = reverseSchema.parse(request.query);
    const result = await observePlacesCall(observer(request.log, request.user.userId), 'reverse', {},
      () => places.reverseGeocode({ lat, lng }), (a) => a === null, null);
    if (!result.ok) return unavailable(reply);
    return { success: true, data: { address: result.value } };
  });
}
