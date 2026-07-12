import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type HTTPMethods, type InjectOptions } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { authRoutes } from '../modules/auth/auth.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { loginWithOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// Authz matrix — the "single consistent security model" control.
//
// Walks the LIVE route table (collected via onRoute, so a new route is in the
// matrix the moment it ships) and fires every role-prefixed route with (a) no
// token and (b) a WRONG role's token. The only acceptable answers are 401/403.
// A 2xx is a missing gate; a 400/404/5xx means body parsing or lookups ran
// before authorization — an information oracle either way.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const routeTable: Array<{ method: string; url: string }> = [];

/** Wrong-role bearer tokens per protected prefix. */
const tokens: Record<string, string> = {};

async function buildTestApp() {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  server.addHook('onRoute', (route) => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]) as HTTPMethods[];
    for (const m of methods) {
      if (m === 'HEAD' || m === 'OPTIONS') continue;
      routeTable.push({ method: m, url: route.url });
    }
  });
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(customerRoutes, { prefix: '/api/v1/customer' });
  await server.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await server.register(riderRoutes, { prefix: '/api/v1/rider' });
  await server.register(driverRoutes, { prefix: '/api/v1/driver' });
  await server.register(adminRoutes, { prefix: '/api/v1/admin' });
  await server.ready();
  return server;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = await buildTestApp();

  const customer = await loginWithOtp(app, '+5926003000'); // CUSTOMER
  const vendor = await loginWithOtp(app, '+5926002000'); // VENDOR_OWNER
  const mover = await loginWithOtp(app, '+5926004000'); // MOVER (rider)
  tokens['customer'] = customer.json().data.tokens.accessToken;
  tokens['vendor'] = vendor.json().data.tokens.accessToken;
  tokens['mover'] = mover.json().data.tokens.accessToken;
});

afterAll(async () => {
  await app.close();
});

/** Fill path params with a syntactically-plausible id that matches nothing.
 *  Authorization must fire BEFORE any lookup, so "does not exist" never gets
 *  the chance to answer. */
function materialize(url: string): string {
  return url.replace(/:[a-zA-Z]+/g, 'cmq00000000000000000000000');
}

function fire(method: string, url: string, token?: string) {
  const opts: InjectOptions = {
    method: method as InjectOptions['method'],
    url: materialize(url),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
  if (method !== 'GET' && method !== 'DELETE') opts.payload = {};
  return app.inject(opts);
}

/** The gate must answer before anything else does. */
const REJECTED = [401, 403];

interface PrefixSpec {
  prefix: string;
  /** roles whose tokens must be rejected on every route under the prefix */
  wrongRoles: string[];
}

const MATRIX: PrefixSpec[] = [
  { prefix: '/api/v1/vendor/', wrongRoles: ['customer', 'mover'] },
  { prefix: '/api/v1/rider/', wrongRoles: ['customer', 'vendor'] },
  { prefix: '/api/v1/driver/', wrongRoles: ['customer', 'vendor'] },
  { prefix: '/api/v1/admin/', wrongRoles: ['customer', 'vendor', 'mover'] },
];

describe('authz matrix — every role-prefixed route rejects outsiders', () => {
  it('collected a non-trivial route table', () => {
    expect(routeTable.length).toBeGreaterThan(50);
  });

  for (const spec of MATRIX) {
    describe(spec.prefix + '*', () => {
      it('rejects unauthenticated requests on every route', async () => {
        const routes = routeTable.filter((r) => r.url.startsWith(spec.prefix));
        expect(routes.length).toBeGreaterThan(0);
        const offenders: string[] = [];
        for (const r of routes) {
          const res = await fire(r.method, r.url);
          if (!REJECTED.includes(res.statusCode)) {
            offenders.push(`${r.method} ${r.url} -> ${res.statusCode}`);
          }
        }
        expect(offenders, offenders.join('\n')).toEqual([]);
      });

      for (const role of spec.wrongRoles) {
        it(`rejects a ${role} token on every route`, async () => {
          const routes = routeTable.filter((r) => r.url.startsWith(spec.prefix));
          const offenders: string[] = [];
          for (const r of routes) {
            const res = await fire(r.method, r.url, tokens[role]);
            if (!REJECTED.includes(res.statusCode)) {
              offenders.push(`${r.method} ${r.url} -> ${res.statusCode}`);
            }
          }
          expect(offenders, offenders.join('\n')).toEqual([]);
        });
      }
    });
  }
});
