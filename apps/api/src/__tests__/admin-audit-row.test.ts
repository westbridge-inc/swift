import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { adminAuditRow, RESERVED_CHANGE_KEYS, verifyInlineRow, type AuditRequestLike } from '../modules/admin/audit-within';
import { ABSENT } from '../modules/admin/audit-change';

// ---------------------------------------------------------------------------
// [ADM-002] THE ROW BUILDER, ON ITS OWN.
//
// `extra` lets a route carry a NAMED fact the generic record cannot derive
// (a broadcast's recipient count). It was merged AFTER the canonical record,
// so `extra: { reason: '...' }` would have silently replaced the stated
// reason, and `extra: { after: '...' }` the digest — the trail rewritten by
// the route it was recording. No database is needed to prove the builder
// refuses that; this file is the one place the shape is pinned directly.
// ---------------------------------------------------------------------------

const request = (over: Partial<AuditRequestLike> = {}): AuditRequestLike => ({
  method: 'POST',
  url: '/api/v1/admin/notifications/broadcast',
  routeOptions: { url: '/api/v1/admin/notifications/broadcast' },
  params: {},
  body: { reason: 'Service notice, ticket GY-1' },
  ip: '127.0.0.1',
  headers: { 'user-agent': 'vitest' },
  user: { userId: 'u1' },
  ...over,
});

const base = { routeUrl: '/api/v1/admin/notifications/broadcast', reason: 'Service notice, ticket GY-1', before: ABSENT, after: ABSENT, entityDeclared: false };

describe('[ADM-002] adminAuditRow', () => {
  it('merges named extras into changes without touching the canonical record', () => {
    const row = adminAuditRow(request(), 'u1', { ...base, entityIdOverride: 'broadcast', extra: { recipientCount: 2, role: 'RIDER' } });
    const changes = row['changes'] as Record<string, unknown>;
    expect(changes['recipientCount']).toBe(2);
    expect(changes['role']).toBe('RIDER');
    expect(changes['reason']).toBe('Service notice, ticket GY-1');
    expect(changes['subject']).toBe('no-single-row');
    expect(row['entityId']).toBe('broadcast');
  });

  it.each([...RESERVED_CHANGE_KEYS])('refuses an extra that would redefine %s', (key) => {
    expect(() => adminAuditRow(request(), 'u1', { ...base, extra: { [key]: 'rewritten' } }))
      .toThrow(/may not redefine the canonical field/);
  });

  it('the stated reason survives even a colliding extra that slipped past the guard', () => {
    // Belt and braces: the spread order alone must keep the canonical field.
    const row = adminAuditRow(request(), 'u1', { ...base, extra: { recipientCount: 1 } });
    const changes = row['changes'] as Record<string, unknown>;
    expect(Object.keys(changes).indexOf('recipientCount')).toBeLessThan(Object.keys(changes).indexOf('reason'));
  });

  it('entity names the RESOURCE of the route template, never the mount prefix', () => {
    // Every admin row used to say `api` — the first segment of the MOUNTED
    // path. The trail's entity column named nothing.
    const row = adminAuditRow(request(), 'u1', { ...base, template: '/notifications/broadcast' });
    expect(row['entity']).toBe('notifications');
    const promo = adminAuditRow(request({ url: '/api/v1/admin/promos/p1', routeOptions: { url: '/api/v1/admin/promos/:id' } }), 'u1',
      { ...base, routeUrl: '/api/v1/admin/promos/:id', template: '/promos/:id', entityDeclared: true });
    expect(promo['entity']).toBe('promos');
    // [ADM-007] the audited READS still file under `integrity`
    const read = adminAuditRow(request(), 'u1', { ...base, template: '/integrity/appeals', entityOverride: 'integrity' });
    expect(read['entity']).toBe('integrity');
  });

  it('a declared entity takes its id from the params; an override is for creates only', () => {
    const row = adminAuditRow(request({ params: { id: 'zone-1' } }), 'u1', { ...base, entityDeclared: true });
    expect(row['entityId']).toBe('zone-1');
    const created = adminAuditRow(request(), 'u1', { ...base, entityIdOverride: 'zone-2' });
    expect(created['entityId']).toBe('zone-2');
  });
});

describe('[ADM-002] verifyInlineRow — the hook verifies before it trusts', () => {
  const fake = (impl: (id: string) => Promise<unknown>) =>
    ({ auditLog: { findUnique: (args: { where: { id: string } }) => impl(args.where.id) } }) as unknown as PrismaClient;
  const marked = (id?: string): AuditRequestLike => ({ ...request(), auditWrittenInline: true, auditInlineRowId: id });

  it('present when the row committed', async () => {
    expect(await verifyInlineRow(fake(async (id) => (id === 'row1' ? { id } : null)), marked('row1'))).toBe('present');
  });
  it('absent when the marker points at a row that never committed — the only verdict that writes', async () => {
    expect(await verifyInlineRow(fake(async () => null), marked('gone'))).toBe('absent');
  });
  it('unknown when the read itself fails — a failed read is not evidence, and must not double-write', async () => {
    expect(await verifyInlineRow(fake(async () => { throw new Error('db away'); }), marked('row1'))).toBe('unknown');
  });
  it('unknown when the marker carries no id', async () => {
    expect(await verifyInlineRow(fake(async () => null), marked(undefined))).toBe('unknown');
  });
});
