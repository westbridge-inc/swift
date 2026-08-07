import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertFounderAccess } from '../modules/admin/founder-access';

// Trial-integrity spec Part 0.2/9: the cross-tenant identity graph and the
// founder's enforcement controls are the one sanctioned tenant-isolation
// exception. Keep that law executable without a database so an auth regression
// fails before any sensitive route handler can run.

const source = readFileSync(resolve(__dirname, '../modules/admin/admin.routes.ts'), 'utf8');

const founderOnlyRoutes = [
  { method: 'post', path: '/integrity/backfill' },
  { method: 'get', path: '/integrity/identity/:userId' },
  { method: 'get', path: '/integrity/appeals' },
  { method: 'post', path: '/integrity/appeals/:id/resolve' },
  { method: 'post', path: '/integrity/exceptions' },
] as const;

const regexEscape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function founderRouteDeclaration(method: string, path: string): RegExp {
  return new RegExp(
    `app\\.${method}(?:<[^>]*>)?\\(\\s*['"]${regexEscape(path)}['"]\\s*,\\s*\\{\\s*preHandler:\\s*\\[founderGuard\\]\\s*\\}`,
  );
}

describe('trial-integrity founder-only route law', () => {
  it('admits SUPER_ADMIN and rejects every ordinary role', () => {
    expect(() => assertFounderAccess('SUPER_ADMIN')).not.toThrow();

    for (const role of ['ADMIN', 'CUSTOMER', 'VENDOR_OWNER', 'MOVER', 'DRIVER']) {
      expect(() => assertFounderAccess(role)).toThrowError(
        expect.objectContaining({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'Founder access required',
        }),
      );
    }
  });

  it('has a dedicated guard that admits only SUPER_ADMIN', () => {
    expect(source).toMatch(/const founderGuard\s*=\s*async/);
    expect(source).toMatch(/assertFounderAccess\(request\.user\.role\)/);
  });

  it.each(founderOnlyRoutes)('$method $path uses founderGuard', ({ method, path }) => {
    expect(source).toMatch(founderRouteDeclaration(method, path));
  });

  it('does not silently broaden the restriction to aggregate integrity KPIs', () => {
    expect(source).toMatch(
      /app\.get\(['"]\/integrity\/kpis['"]\s*,\s*\{\s*preHandler:\s*\[adminGuard\]\s*\}/,
    );
  });
});
