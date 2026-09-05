import { describe, it, expect } from 'vitest';
import { adminAuditRow, RESERVED_CHANGE_KEYS, type AuditRequestLike } from '../modules/admin/audit-within';
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

  it('a declared entity takes its id from the params; an override is for creates only', () => {
    const row = adminAuditRow(request({ params: { id: 'zone-1' } }), 'u1', { ...base, entityDeclared: true });
    expect(row['entityId']).toBe('zone-1');
    const created = adminAuditRow(request(), 'u1', { ...base, entityIdOverride: 'zone-2' });
    expect(created['entityId']).toBe('zone-2');
  });
});
