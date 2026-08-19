import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertFounderAccess } from '../modules/admin/founder-access';

// Trial-integrity spec Part 0.2/9: the cross-tenant identity graph and the
// founder's enforcement controls are the one sanctioned tenant-isolation
// exception. They still belong exclusively to the canonical platform tenant:
// a SUPER_ADMIN inside another tenant is not a platform principal.

const source = readFileSync(resolve(__dirname, '../modules/admin/admin.routes.ts'), 'utf8');

const platformIdentityRoutes = [
  { method: 'post', path: '/integrity/backfill' },
  { method: 'get', path: '/integrity/identity/:userId' },
  { method: 'get', path: '/integrity/appeals' },
  { method: 'post', path: '/integrity/appeals/:id/resolve' },
  { method: 'post', path: '/integrity/exceptions' },
] as const;

const regexEscape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function platformRouteDeclaration(method: string, path: string): RegExp {
  return new RegExp(
    `app\\.${method}(?:<[^>]*>)?\\(\\s*['"]${regexEscape(path)}['"]\\s*,\\s*\\{\\s*preHandler:\\s*\\[platformControlGuard\\]\\s*\\}`,
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

  it.each(platformIdentityRoutes)('$method $path uses the default-tenant platform guard', ({ method, path }) => {
    expect(source).toMatch(platformRouteDeclaration(method, path));
  });

  it('keeps aggregate integrity KPIs on the default-tenant platform guard', () => {
    expect(source).toMatch(
      /app\.get\(['"]\/integrity\/kpis['"]\s*,\s*\{\s*preHandler:\s*\[platformControlGuard\]\s*\}/,
    );
  });

  it.each([
    { method: 'get', path: '/dlq' },
    { method: 'post', path: '/dlq/:queue/:id/requeue' },
    { method: 'delete', path: '/dlq/:queue/:id' },
  ])('$method $path keeps the shared queue control plane on the default tenant', ({ method, path }) => {
    expect(source).toMatch(platformRouteDeclaration(method, path));
  });

  it('requires the canonical tenant after applying the founder role check', () => {
    expect(source).toMatch(/const platformControlGuard\s*=\s*async/);
    expect(source).toMatch(/await founderGuard\(request, reply\)/);
    expect(source).toMatch(/requireTenantId\(\)\s*!==\s*['"]swift-default['"]/);
  });
});
