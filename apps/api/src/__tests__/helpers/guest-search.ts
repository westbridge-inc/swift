import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { vi } from 'vitest';
import { authPlugin } from '../../plugins/auth';
import { beginRequestTenantContext, getTenantId } from '../../plugins/tenant-context';
import { registerErrorHandler } from '../../middleware/error-handler';
import { rateLimitKey } from '../../utils/rate-limit-key';
import { marketRoutes } from '../../modules/market/market.routes';
import { searchRoutes } from '../../modules/search/search.routes';

// Only the external search client and unused auth mutations are replaced.
// The HTTP router, auth/session verifier, visibility and listing gates are real.
vi.mock('../../plugins/prisma', async () => import('../../plugins/tenant-context'));
vi.mock('../../modules/auth/auth.service', () => ({ AuthService: class {} }));
const engine = vi.hoisted(() => ({
  ready: false,
  vendors: vi.fn(async () => ({ hits: [{ entityId: 'indexed-vendor', name: 'Indexed store', vendorType: 'RESTAURANT' }], estimatedTotalHits: 1, processingTimeMs: 1 })),
  items: vi.fn(async () => ({ hits: [{ entityId: 'indexed-item', name: 'Indexed dish', vendorId: 'indexed-vendor' }], estimatedTotalHits: 1, processingTimeMs: 1 })),
  syncVendors: vi.fn(async () => 1), syncItems: vi.fn(async () => 1),
}));
vi.mock('../../modules/search/search.service', () => ({ SearchService: class {
  async initialize() { if (!engine.ready) throw new Error('test engine unavailable'); }
  syncAllVendors = engine.syncVendors;
  syncAllItems = engine.syncItems;
  searchVendors = engine.vendors;
  searchItems = engine.items;
} }));

export { engine };

type Row = Record<string, any>;
// Small, strict query double: evaluate the route's predicates, never pre-filter
// the fixtures into the expected answer. Unsupported operators fail the test.
export function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((w: Row) => matches(row, w));
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((w: Row) => matches(row, w));
    const actual = row[key];
    if (value === null || typeof value !== 'object') return actual === value;
    if ('isNot' in value) return actual == null || !matches(actual, value.isNot);
    if ('notIn' in value) return !value.notIn.includes(actual);
    if ('lt' in value) return actual != null && actual < value.lt;
    if ('gte' in value) return actual != null && actual >= value.gte;
    if ('some' in value) return actual.some((r: Row) => matches(r, value.some));
    if ('in' in value) return value.in.includes(actual);
    if ('contains' in value) return typeof actual === 'string' && actual.toLowerCase().includes(value.contains.toLowerCase());
    if ('hasSome' in value) return actual.some((s: string) => value.hasSome.includes(s));
    if ('has' in value) return actual.includes(value.has);
    if ('gt' in value) return actual > value.gt;
    if ('lte' in value) return actual <= value.lte;
    if (actual && typeof actual === 'object') return matches(actual, value);
    throw new Error(`Unsupported test predicate: ${key}`);
  });
}
function select(row: Row, fields?: Row): Row {
  if (!fields) return row;
  return Object.fromEntries(Object.entries(fields).map(([key, spec]) => [key,
    spec === true ? row[key] : row[key] == null ? null : select(row[key], spec.select),
  ]));
}

export async function guestSearchApp(max = 200) {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('JWT_SECRET', 'guest-search-test-signing-value');
  vi.stubEnv('PUBLIC_TENANT_ID', 'public');
  const tenants: Row[] = [
    { id: 'public', isActive: true, kind: 'PRODUCTION' },
    { id: 'other', isActive: true, kind: 'PRODUCTION' },
    { id: 'review', isActive: true, kind: 'REVIEW' },
    { id: 'dead', isActive: false, kind: 'PRODUCTION' },
  ];
  const vendors: Row[] = [
    ['public', 'public', 'ACTIVE', true], ['other', 'other', 'ACTIVE', true],
    ['review', 'review', 'ACTIVE', true], ['dead', 'dead', 'ACTIVE', true],
    ['suspended', 'public', 'SUSPENDED', true], ['unverified', 'public', 'ACTIVE', false],
    ['unpublished', 'public', 'PENDING_APPROVAL', true],
  ].map(([id, tenantId, status, verified]) => ({
    id, tenantId, status, subscription: null, isVerified: verified, tenant: tenants.find((t) => t['id'] === tenantId),
    name: `Pepper ${id}`, slug: id, vendorType: 'RESTAURANT', isCurrentlyOpen: true,
    latitude: 6.8, longitude: -58.15, city: 'Georgetown', addressLine1: 'Public shop address',
    cuisineTypes: ['Creole'], tags: [], description: 'Pepper dishes', estimatedPrepTime: 15,
    logoUrl: null, coverImageUrl: null, averageRating: 4, totalRatings: 12,
    ownerId: 'private-owner', phone: 'private-contact', mmgPayLink: 'private-payment',
    owner: { user: { id: 'owner', countryCode: 'GY' } },
  }));
  const items: Row[] = vendors.map((vendor) => ({
    id: `item-${vendor['id']}`, tenantId: vendor['tenantId'], vendorId: vendor['id'], vendor,
    name: `Pepper dish ${vendor['id']}`, description: 'Pepper', isAvailable: true, basePrice: 1200,
    imageUrl: null, createdAt: new Date(0), category: { name: 'Meals' }, totalOrdered: 50,
    sku: 'private-sku', stockQuantity: 100,
  }));
  items.push({ ...items[0], id: 'hidden-item', name: 'Pepper hidden', isAvailable: false });
  items.push({ ...items[0], id: 'gated-item', name: 'Pepper gated' });
  for (const vendor of vendors) vendor['items'] = items.filter((i) => i['vendorId'] === vendor['id']);
  const categories: Row[] = [{ id: 'licensed', tenantId: 'public', status: 'ACTIVE', slug: 'licensed', kind: 'PRODUCT' }];
  const tags: Row[] = [{ tenantId: 'public', itemId: 'gated-item', categoryId: 'licensed' }];
  const sessions = new Map<string, Row>();
  function delegate(rows: Row[]) {
    const findMany = vi.fn(async (args: Row = {}) => {
      const tenantId = getTenantId();
      const filtered = rows.filter((r) => (!tenantId || !r['tenantId'] || r['tenantId'] === tenantId) && matches(r, args['where']));
      return filtered.slice(0, args['take'] ?? filtered.length).map((r) => select(r, args['select']));
    });
    return { findMany, findUnique: vi.fn(async (args: Row) => (await findMany(args))[0] ?? null), count: vi.fn(async (args: Row) => (await findMany(args)).length) };
  }
  const db = {
    tenant: delegate(tenants), vendor: delegate(vendors), item: delegate(items),
    actorRatingStat: { findMany: vi.fn(async () => []) },
    session: { findUnique: vi.fn(async ({ where }: Row) => sessions.get(where.token) ?? null) },
    discoveryCategory: delegate(categories),
    categoryDocumentGate: { findMany: vi.fn(async () => [{ code: 'licence', categorySlug: 'licensed', categoryKind: null, enforcement: 'BLOCK_LISTING', requiredDocType: { legacyCode: 'LICENCE', displayName: 'Licence' } }]) },
    verificationDocument: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    itemDiscoveryCategory: delegate(tags),
  };
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('onRequest', (_request, _reply, done) => { beginRequestTenantContext(); done(); });
  app.decorate('prisma', db as never);
  await app.register(rateLimit, { max, timeWindow: '1 minute', keyGenerator: rateLimitKey });
  await app.register(authPlugin);
  await app.register(searchRoutes, { prefix: '/api/v1' });
  await app.register(marketRoutes, { prefix: '/api/v1/market' });
  await app.ready();
  function token(tenantId = 'other', role = 'CUSTOMER') {
    const value = app.jwt.sign({ userId: 'test-user', role, jti: `${tenantId}-${role}` });
    sessions.set(value, { id: 'test-session', expiresAt: new Date(Date.now() + 60_000), authMethod: 'OTP', user: {
      id: 'test-user', tenantId, tenant: { kind: 'PRODUCTION' }, status: 'ACTIVE', roles: [role], activeRole: role,
    } });
    return value;
  }
  return { app, db, tenants, vendors, items, categories, tags, token, sessions };
}
