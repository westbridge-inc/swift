import { describe, it, expect } from 'vitest';
import {
  OPS_WAR_ROOM,
  tenantWarRoom,
  warRoomsFor,
  warRoomsForSocket,
} from '../modules/safety/war-room';

// ---------------------------------------------------------------------------
// [F-027-16 / F-027-18] The ops war room.
//
// Before this module, `ops:war-room` had SEVEN emit producers across SOS,
// incidents, liveness and mover revocation, and NO join anywhere in the
// codebase — not in the API, not in the admin app (which carries
// socket.io-client as a dependency and never uses it). Every live ops event
// went into a black hole, and because emitting into an empty room does not
// throw, the SOS delivery receipt recorded `socket: true` and the safety
// baseline accepted that as proof help was coming.
//
// The routing policy is the security boundary, so it is tested directly: a
// war-room payload carries another person's role, order id and COORDINATES,
// and one shared room would have reopened on the socket channel exactly the
// cross-tenant leak F-026-15 closed on the push channel.
// ---------------------------------------------------------------------------

describe('war-room publication targets', () => {
  it('a tenant-owned event goes to that tenant\'s room AND the platform room', () => {
    expect(warRoomsFor('tenant-a')).toEqual(['ops:war-room:tenant-a', OPS_WAR_ROOM]);
  });

  it('an event with no tenant goes to the platform room only — never broadcast to every tenant', () => {
    expect(warRoomsFor(null)).toEqual([OPS_WAR_ROOM]);
    expect(warRoomsFor(undefined)).toEqual([OPS_WAR_ROOM]);
  });

  it('one tenant\'s room is never another tenant\'s room', () => {
    expect(tenantWarRoom('a')).not.toBe(tenantWarRoom('b'));
    expect(warRoomsFor('tenant-a')).not.toContain(tenantWarRoom('tenant-b'));
  });
});

describe('who may join the war room', () => {
  it('a SUPER_ADMIN joins the platform room — that is the job', () => {
    expect(warRoomsForSocket('SUPER_ADMIN', 'tenant-a')).toContain(OPS_WAR_ROOM);
  });

  it('a tenant ADMIN joins ONLY their own room, never the platform room', () => {
    const rooms = warRoomsForSocket('ADMIN', 'tenant-a');
    expect(rooms).toEqual([tenantWarRoom('tenant-a')]);
    expect(rooms).not.toContain(OPS_WAR_ROOM);
  });

  it('a tenant ADMIN can never reach another tenant\'s room', () => {
    expect(warRoomsForSocket('ADMIN', 'tenant-a')).not.toContain(tenantWarRoom('tenant-b'));
  });

  it('everyone else joins NOTHING — the war room is live emergencies, not an ops feed', () => {
    for (const role of ['CUSTOMER', 'MOVER', 'VENDOR_OWNER', 'RIDER', 'DRIVER', '', undefined]) {
      expect(warRoomsForSocket(role, 'tenant-a'), String(role)).toEqual([]);
    }
  });

  it('an ADMIN with no resolved tenant joins nothing rather than falling back to the platform room', () => {
    // Failing OPEN here would hand a tenant admin every tenant's emergencies.
    expect(warRoomsForSocket('ADMIN', null)).toEqual([]);
    expect(warRoomsForSocket('ADMIN', undefined)).toEqual([]);
  });

  it('a tenant admin who joins their room is reached by their own tenant\'s events, and by no others', () => {
    const joined = new Set(warRoomsForSocket('ADMIN', 'tenant-a'));
    const mine = warRoomsFor('tenant-a');
    const theirs = warRoomsFor('tenant-b');
    expect(mine.some((r) => joined.has(r))).toBe(true);
    expect(theirs.some((r) => joined.has(r))).toBe(false);
  });
});
