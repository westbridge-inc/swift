/**
 * [F-027-16 / F-027-18] The ops war room — who is in it, and whose alerts
 * reach them.
 *
 * Until this module existed, `ops:war-room` had SEVEN emit producers across
 * SOS, incidents, liveness and mover revocation, and **no join anywhere in the
 * codebase**. Every live ops event went into a black hole, and the SOS
 * delivery receipt recorded `socket: true` because emitting into an empty room
 * does not throw. The real-time ops surface did not exist and the evidence
 * said it did.
 *
 * Two rooms, because there are two kinds of operator:
 *
 *   ops:war-room            — the PLATFORM room. SUPER_ADMIN only. Sees every
 *                             tenant's events, because that is the job.
 *   ops:war-room:<tenantId> — one per tenant. A tenant's ADMIN joins only
 *                             their own.
 *
 * A tenant admin must never be handed another tenant's emergency: it carries
 * the actor's role, the order id and the coordinates. That is exactly the leak
 * closed on the PUSH channel by F-026-15, and a shared socket room would have
 * reopened it on the socket channel the moment anyone actually subscribed.
 */

/** The platform-wide room. SUPER_ADMIN only — never a tenant's admin. */
export const OPS_WAR_ROOM = 'ops:war-room';

/** One tenant's room. */
export const tenantWarRoom = (tenantId: string) => `${OPS_WAR_ROOM}:${tenantId}`;

/**
 * Where a tenant-owned ops event must be published: that tenant's room, plus
 * the platform room so SUPER_ADMINs see it too.
 */
export function warRoomsFor(tenantId: string | null | undefined): string[] {
  return tenantId ? [tenantWarRoom(tenantId), OPS_WAR_ROOM] : [OPS_WAR_ROOM];
}

/**
 * Which rooms a connecting socket may join, by role. Everyone else gets none —
 * the war room carries live emergencies and is not a general ops feed.
 */
export function warRoomsForSocket(role: string | undefined, tenantId: string | null | undefined): string[] {
  if (role === 'SUPER_ADMIN') return tenantId ? [OPS_WAR_ROOM, tenantWarRoom(tenantId)] : [OPS_WAR_ROOM];
  if (role === 'ADMIN') return tenantId ? [tenantWarRoom(tenantId)] : [];
  return [];
}
