import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockApi, type ApiRequest } from '@/test/test-utils';
import { REASONED_CALLERS } from '@/lib/reason-census';
import * as api from '@/lib/api';
import { REASON_MIN } from '@/lib/ask-reason';

// ---------------------------------------------------------------------------
// [DS110-14] EVERY MUTATING ADMIN CALL STATES WHY.
//
// The server refuses a C3/C4/C5 action without a reason of at least 12
// characters, and 26 console callers never sent one — every one of them 400'd
// at the gate. This census reads the SERVER's authority table (the same file
// the gate reads), names every route that demands a reason, and then grades
// every admin-console caller of such a route AT THE WIRE: the helper is
// invoked through the real api.ts transport and the captured request must
// carry a reason of the server's own minimum length. On the old client none of
// the 26 helpers took a reason at all, so this suite fails on main.
// ---------------------------------------------------------------------------

const AUTHORITY_SOURCE = readFileSync(
  join(process.cwd(), '..', 'api', 'src', 'modules', 'admin', 'admin-authority.ts'),
  'utf8',
);
const API_SOURCE = readFileSync(join(process.cwd(), 'src', 'lib', 'api.ts'), 'utf8');

/** The C3/C4/C5 mutating routes, exactly as the server's gate derives them. */
function routesRequiringReason(): Set<string> {
  const rows = [...AUTHORITY_SOURCE.matchAll(/^\s*'([^']+)':\s*c\('(C[0-5])'/gm)];
  return new Set(
    rows
      .filter(([, , cls]) => cls === 'C3' || cls === 'C4' || cls === 'C5')
      .map(([, route]) => route)
      .filter((route) => !route.startsWith('GET ')),
  );
}

/** Does api.ts contain a call to this route template (params → `[^/]+`)? */
function consoleCalls(route: string): boolean {
  const pattern = route
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  // anchor the tail: `/billing/agent-payments` must not "match" the console's
  // `/billing/agent-payments/:id/attach` caller and demand a caller that the
  // console does not have
  return new RegExp(`${pattern}(?!/)`).test(API_SOURCE);
}

const REASON = 'Reviewed the request against the bank statement and the price book';

describe('[DS110-14] the reason census', () => {
  it('names the server routes that demand a reason — the census is graded against the gate itself', () => {
    const required = routesRequiringReason();
    expect(required.size).toBeGreaterThan(60);
    for (const entry of REASONED_CALLERS) {
      expect(required.has(entry.route), `${entry.route} must require a reason to be in this list`).toBe(true);
    }
  });

  it('every console caller of a reasoned route is registered — nothing is quietly omitted', () => {
    const registered = new Set(REASONED_CALLERS.map((entry) => entry.route));
    for (const route of routesRequiringReason()) {
      if (consoleCalls(route)) {
        expect(registered.has(route), `admin console calls ${route} but no caller is registered`).toBe(true);
      }
    }
  });

  it('every registered caller sends a reason of at least the server floor — at the wire', async () => {
    for (const entry of REASONED_CALLERS) {
      let captured: ApiRequest | undefined;
      mockApi((request) => {
        captured = request;
        return { body: { success: true, data: {} } };
      });
      const helper = (api as unknown as Record<string, (..._args: unknown[]) => Promise<unknown>>)[entry.helper];
      expect(helper, `${entry.helper} is not exported from lib/api.ts`).toBeTypeOf('function');
      await helper(...entry.args, REASON);
      expect(captured, `${entry.helper} did not issue a request`).toBeDefined();

      // [DS110 rev D4] The route it hit, not just the reason it carried. The
      // route template's params are the helper's leading string arguments, in
      // template order — so the captured pathname must equal the template
      // filled with exactly those values.
      const [routeMethod, routeTemplate] = entry.route.split(' ');
      expect(captured!.method, `${entry.helper} used the wrong method`).toBe(routeMethod);
      let paramIndex = 0;
      const concretePath = `/${routeTemplate.split('/').slice(1).map((segment) => {
        if (!segment.startsWith(':')) return segment;
        const value = entry.args[paramIndex++];
        expect(value, `${entry.helper} has no argument for ${segment}`).toBeTypeOf('string');
        return encodeURIComponent(String(value));
      }).join('/')}`;
      expect(captured!.url.pathname, `${entry.helper} hit the wrong path`).toBe(`/api/v1/admin${concretePath}`);

      // [DS110 rev D4] The body the server's zod schema demands, key by key.
      // A helper that sent the reason in the right place but the domain field
      // under the wrong name (`{ reason }` where the schema says `note`) — or
      // left the required deposit evidence out entirely — fails HERE, not
      // vacuously at the reason header.
      if (entry.requiredBodyKeys?.length) {
        const body = JSON.parse(String(captured!.init?.body ?? '{}')) as Record<string, unknown>;
        for (const key of entry.requiredBodyKeys) {
          expect(body, `${entry.helper} body`).toHaveProperty(key);
          const value = body[key];
          if (typeof value === 'string') {
            expect(value.trim().length, `${entry.helper}.${key} is an empty string`).toBeGreaterThan(0);
          } else if (typeof value === 'number') {
            expect(Number.isFinite(value), `${entry.helper}.${key} is not a finite number`).toBe(true);
          }
        }
      }

      const headers = (captured!.init?.headers ?? {}) as Record<string, string>;
      const bodyText = captured!.init?.body;
      const stated =
        typeof headers['x-swift-reason'] === 'string' && headers['x-swift-reason'].trim()
          ? headers['x-swift-reason'].trim()
          : (() => {
              try {
                const parsed = JSON.parse(String(bodyText ?? '{}')) as Record<string, unknown>;
                return typeof parsed['reason'] === 'string' ? parsed['reason'] : '';
              } catch {
                return '';
              }
            })();
      expect(stated.length, `${entry.route} (${entry.helper}) sent no usable reason`).toBeGreaterThanOrEqual(REASON_MIN);
    }
  });
});
