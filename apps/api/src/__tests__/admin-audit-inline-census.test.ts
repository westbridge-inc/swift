import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_ROUTE_AUTHORITY, ADMIN_ROUTES_ON_BACKSTOP } from '../modules/admin/admin-authority';

// ---------------------------------------------------------------------------
// [ADM-002] THE CENSUS THAT CLOSES THE CLAUSE.
//
// Every C4 (money) and C5 (platform) route either writes its audit row inside
// its own transaction — its handler calls `auditWithin` — or is NAMED in
// `ADMIN_ROUTES_ON_BACKSTOP` with the reason it cannot (a fleet-wide run with
// no single transaction to join). A new money route is either migrated the
// day it ships or it fails this build. And the exception list cannot rot: a
// route listed there that has since migrated fails too.
// ---------------------------------------------------------------------------

const source = fs.readFileSync(path.resolve(__dirname, '../modules/admin/admin.routes.ts'), 'utf8');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function handlerOf(key: string): string | null {
  const [method, route] = key.split(' ') as [string, string];
  const m = source.match(new RegExp(`app\\.${method.toLowerCase()}(?:<[^>]*>)?\\('${escapeRe(route)}'`));
  if (!m || m.index === undefined) return null;
  const rest = source.slice(m.index + 10);
  const next = rest.search(/\n  app\.(get|post|put|patch|delete)(<[^>]*>)?\(/);
  return source.slice(m.index, next === -1 ? undefined : m.index + 10 + next);
}

const moneyAndPlatform = Object.entries(ADMIN_ROUTE_AUTHORITY).filter(([, a]) => a.cls === 'C4' || a.cls === 'C5').map(([key]) => key);

describe('[ADM-002] every C4/C5 route audits inside its transaction, or is named as a backstop exception', () => {
  it('finds a handler for every C4/C5 route', () => {
    expect(moneyAndPlatform.filter((key) => handlerOf(key) === null)).toEqual([]);
  });

  it('every handler not on the exception list calls auditWithin', () => {
    const missing = moneyAndPlatform.filter((key) => !(key in ADMIN_ROUTES_ON_BACKSTOP) && !/auditWithin\(/.test(handlerOf(key) ?? ''));
    expect(missing, 'C4/C5 routes still relying on the after-commit backstop').toEqual([]);
  });

  it('the exception list names only real C4/C5 routes that do NOT audit inline', () => {
    for (const key of Object.keys(ADMIN_ROUTES_ON_BACKSTOP)) {
      expect(ADMIN_ROUTE_AUTHORITY[key]?.cls, `${key} is a C4/C5 route`).toMatch(/^C[45]$/);
      expect(/auditWithin\(/.test(handlerOf(key) ?? ''), `${key} is listed as a backstop exception but already audits inline`).toBe(false);
      expect(ADMIN_ROUTES_ON_BACKSTOP[key]!.length, `${key} states a reason`).toBeGreaterThan(20);
    }
  });

  it('no legacy audit() call survives on a C4/C5 handler that audits inline (one row per action)', () => {
    const doubled = moneyAndPlatform.filter((key) => { const h = handlerOf(key) ?? ''; return /auditWithin\(/.test(h) && /await audit\(/.test(h); });
    expect(doubled).toEqual([]);
  });
});
