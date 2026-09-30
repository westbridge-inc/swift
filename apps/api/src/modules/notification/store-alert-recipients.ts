import type { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../../plugins/tenant-context';
import { storeRoomMemberKey, type StoreRoomPair } from './store-room';

/**
 * [Q10 loud alerts 2/4] Who hears a store's new-order alert: the store's
 * owner and every member of THAT store's team (VendorStaff, whatever their
 * role), read from the database each time an alert or a rung goes out. Until
 * this, only the owner was alerted, so a kitchen run by its staff heard
 * nothing unless the owner's phone was in the room.
 *
 * Read at send time, never carried in a job: a member removed from the store
 * stops hearing its orders at the very next rung. A member is skipped when
 * their account is not ACTIVE, or when it belongs to another tenant than the
 * store (a team row pointing across tenants must never carry one tenant's
 * orders to another tenant's people). Owner first, then the team in the
 * order they were added; no one twice.
 */
export async function storeAlertRecipients(prisma: PrismaClient, vendorId: string): Promise<string[]> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: {
      tenantId: true,
      owner: { select: { userId: true } },
      staff: {
        orderBy: { createdAt: 'asc' },
        select: { userId: true, user: { select: { status: true, tenantId: true } } },
      },
    },
  });
  if (!vendor) return [];
  const recipients = [vendor.owner.userId];
  for (const member of vendor.staff) {
    if (member.user.status !== 'ACTIVE' || member.user.tenantId !== vendor.tenantId) continue;
    if (!recipients.includes(member.userId)) recipients.push(member.userId);
  }
  return recipients;
}

/**
 * [Q10 loud alerts 2/4 · AX291 F02] May this signed-in user hear the store's
 * live room (`vendor:<id>`: every new order, every status change)? Only the
 * store's owner or an ACTIVE member of its team, and only inside the caller's
 * own tenant: the store must be in that tenant and so must the account. It is
 * the same rule storeAlertRecipients applies to pushes, so a team row pointing
 * across tenants admits nobody. The lookup runs with the tenant bound, so the
 * tenant wall scopes it as well as the explicit predicate.
 *
 * [AX317 F03] ONE rule for a subscription and for the socket plugin's
 * re-validation of everyone already in a store room: this is
 * storeRoomMemberships asked about one pair.
 */
export async function isStoreRoomMember(prisma: PrismaClient, vendorId: string, userId: string, tenantId: string): Promise<boolean> {
  const pair = { vendorId, userId, tenantId };
  return (await storeRoomMemberships(prisma, [pair])).has(storeRoomMemberKey(pair));
}

/**
 * [AX317 F03] The store-room rule for many (store, person, tenant) pairs at
 * once: one read per tenant, each with that tenant bound. Returns the keys
 * (storeRoomMemberKey) of the pairs that are members now: the store is in the
 * tenant, and the person is its owner with an account in that tenant, or an
 * ACTIVE member of its team with an account in that tenant.
 */
export async function storeRoomMemberships(prisma: PrismaClient, pairs: readonly StoreRoomPair[]): Promise<Set<string>> {
  const byTenant = new Map<string, StoreRoomPair[]>();
  for (const pair of pairs) {
    const group = byTenant.get(pair.tenantId);
    if (group) group.push(pair);
    else byTenant.set(pair.tenantId, [pair]);
  }
  const members = new Set<string>();
  for (const [tenantId, group] of byTenant) {
    const vendorIds = [...new Set(group.map((pair) => pair.vendorId))];
    const userIds = [...new Set(group.map((pair) => pair.userId))];
    // Every condition is a filter, as in the one-pair rule it replaced: no
    // row of another tenant is ever selected, so a hidden row cannot fail
    // the read for the whole tenant.
    const [owned, staffed] = await runWithTenant(tenantId, () => Promise.all([
      prisma.vendor.findMany({
        where: { id: { in: vendorIds }, tenantId, owner: { userId: { in: userIds }, user: { tenantId } } },
        select: { id: true, owner: { select: { userId: true } } },
      }),
      prisma.vendorStaff.findMany({
        where: {
          vendorId: { in: vendorIds },
          userId: { in: userIds },
          vendor: { tenantId },
          user: { tenantId, status: 'ACTIVE' },
        },
        select: { vendorId: true, userId: true },
      }),
    ]));
    const admitted = new Set<string>();
    for (const vendor of owned) admitted.add(JSON.stringify([vendor.id, vendor.owner.userId]));
    for (const member of staffed) admitted.add(JSON.stringify([member.vendorId, member.userId]));
    for (const pair of group) {
      if (admitted.has(JSON.stringify([pair.vendorId, pair.userId]))) members.add(storeRoomMemberKey(pair));
    }
  }
  return members;
}
