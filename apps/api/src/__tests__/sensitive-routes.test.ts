import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MONEY_SURFACE_CALLS, SENSITIVE_MONEY_ROUTES } from '../modules/integrity/sensitive-routes';

// ---------------------------------------------------------------------------
// [R048-007] THE SENSITIVE-ROUTE CENSUS. A money surface that reaches the
// route tree without its controls is a test failure, not a gap: every
// registered route carries every registered control inside its own handler,
// and every money-surface call anywhere under src/modules sits inside a
// registered route. Adding a new payout entrance means adding it here, with
// its step-up and its velocity classification, or this test says so.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.routes.ts')) out.push(p);
  }
  return out;
}

/** The handler block of one route: from its registration line to the next `app.<method>(` at the same nesting, or EOF. */
function routeBlock(source: string, route: string): string {
  const start = source.indexOf(route);
  if (start < 0) return '';
  const rest = source.slice(start + route.length);
  const next = rest.search(/\n {2}app\.(get|post|put|patch|delete)\(/);
  return route + (next < 0 ? rest : rest.slice(0, next));
}

/** The registration line of the route enclosing a given offset. */
function enclosingRoute(source: string, offset: number): string | null {
  const before = source.slice(0, offset);
  const m = [...before.matchAll(/\n {2}app\.(get|post|put|patch|delete)\('([^']+)'/g)].pop();
  return m ? `app.${m[1]}('${m[2]}'` : null;
}

describe('[R048-007] every registered sensitive route carries its controls', () => {
  for (const r of SENSITIVE_MONEY_ROUTES) {
    it(`${r.file} ${r.route} → ${r.controls.length} controls present in the handler`, () => {
      const source = readFileSync(join(SRC, r.file), 'utf8');
      const block = routeBlock(source, r.route);
      expect(block, `route ${r.route} not found in ${r.file}`).not.toBe('');
      for (const control of r.controls) expect(block, `${r.route} lacks ${control}`).toContain(control);
    });
  }
});

describe('[R048-007] every money-surface call in the route tree sits inside a registered route', () => {
  it('no unregistered entrance moves money authority', () => {
    const registered = new Set(SENSITIVE_MONEY_ROUTES.map((r) => `${r.file}::${r.route}`));
    const unregistered: string[] = [];
    for (const file of walk(join(SRC, 'modules'))) {
      const rel = file.slice(SRC.length + 1);
      const source = readFileSync(file, 'utf8');
      for (const call of MONEY_SURFACE_CALLS) {
        let at = source.indexOf(call);
        while (at >= 0) {
          const route = enclosingRoute(source, at);
          if (!route || !registered.has(`${rel}::${route}`)) unregistered.push(`${rel}: ${call} inside ${route ?? '(no route)'}`);
          at = source.indexOf(call, at + call.length);
        }
      }
    }
    expect(unregistered).toEqual([]);
  });

  it('the registry classifies every entrance with a step-up or a velocity control, never neither', () => {
    for (const r of SENSITIVE_MONEY_ROUTES) {
      const hasStepUp = r.controls.some((c) => c.startsWith('requireStepUp('));
      const hasVelocity = r.controls.some((c) => c.startsWith('assertVelocity(') || c.startsWith('velocityGuard('));
      expect(hasStepUp || hasVelocity, `${r.route} has no control classification`).toBe(true);
      // every velocity action on a money surface fails closed by prefix
      for (const c of r.controls) {
        const m = /assertVelocity\(app, request, '([^']+)'\)/.exec(c);
        if (m) expect(m[1], `${m[1]} is not a money-surface action`).toMatch(/^(money|payout|mmg|identity|billing)\./);
      }
    }
  });
});
