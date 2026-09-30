import type { FastifyInstance } from 'fastify';
import { publicServiceCatalog } from './service-catalog';

/** No provider/account data: this global taxonomy is identical for all callers. */
export async function serviceCatalogRoutes(app: FastifyInstance) {
  app.get('/catalog', { schema: { querystring: { type: 'object', additionalProperties: false } } }, async () => ({
    success: true,
    data: publicServiceCatalog(),
  }));
}
