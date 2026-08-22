import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { SosService } from '../modules/safety/sos.service';
import { warRoomsFor, OPS_WAR_ROOM, tenantWarRoom } from '../modules/safety/war-room';

// ---------------------------------------------------------------------------
// [F-028-04] An SOS whose tenant cannot be resolved must say so.
//
// `SosAlert.tenantId` was NOT NULL defaulting to `swift-default`, and create()
// OMITTED the column when neither the actor nor an order named a tenant. The
// row therefore did not come out platform-neutral — it came out belonging to
// `swift-default`, a REAL tenant with REAL admins. fanOut then paged THOSE
// admins with the endangered person's order and location, while the tenant
// whose customer was actually in danger heard nothing. Two harms at once: a
// missed page and a disclosure.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } },
});
const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
let sos: SosService;
const userIds: string[] = [];
const alertIds: string[] = [];
let seq = 0;
const phone = () => `+${592_708_000_000 + Math.floor(Math.random() * 60_000_000) + (seq += 1)}`;

async function actor(tenantId: string | null) {
  const u = await prisma.user.create({
    data: {
      phone: phone(), firstName: 'Tenant', lastName: 'Routing',
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true,
      ...(tenantId ? { tenantId } : {}),
    },
  });
  userIds.push(u.id);
  return u;
}

beforeAll(() => { sos = new SosService(prisma, io); });

afterAll(async () => {
  if (alertIds.length) await prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('[F-028-04] SOS tenant routing', () => {
  it('an UNRESOLVABLE tenant is written NULL, not swift-default', async () => {
    // The review's exact scenario: "a transient actor lookup failure followed
    // by a successful insert". User.tenantId is itself non-null with the same
    // default, so a tenant-less USER is not reachable — the resolver failing
    // is. tenantOfUser swallows the error and returns null, create() logged
    // "falling back to the platform tenant", and then OMITTED the column, so
    // the schema default made it swift-default: a real tenant, real admins,
    // paged with this person's location while their own admins heard nothing.
    const u = await actor(null);
    const spy = vi.spyOn(prisma.user, 'findUnique').mockRejectedValueOnce(new Error('transient db error'));
    try {
      const alert = await sos.create({ actorUserId: u.id, actorRole: 'CUSTOMER', immediate: true });
      alertIds.push(alert.id);
      expect(alert.tenantId).toBeNull();
      expect(alert.tenantId).not.toBe('swift-default');
    } finally {
      spy.mockRestore();
    }
  });

  it('a NULL tenant routes to the platform war room ONLY — never a tenant room', async () => {
    // The routing side was already correct; nothing could ever reach it,
    // because the column default filled in a real tenant first.
    expect(warRoomsFor(null)).toEqual([OPS_WAR_ROOM]);
    expect(warRoomsFor(null)).not.toContain(tenantWarRoom('swift-default'));
  });

  it('still carries the actor’s real tenant when one CAN be resolved', async () => {
    // The fix must not make every alert platform-only — under-notifying every
    // tenant would be its own life-safety failure.
    const tenantId = 'swift-default';
    const u = await actor(tenantId);
    const alert = await sos.create({ actorUserId: u.id, actorRole: 'CUSTOMER', immediate: true });
    alertIds.push(alert.id);
    expect(alert.tenantId).toBe(tenantId);
    expect(warRoomsFor(alert.tenantId)).toEqual([tenantWarRoom(tenantId), OPS_WAR_ROOM]);
  });
});
