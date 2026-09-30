import type { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../../plugins/tenant-context';

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
 */
export async function isStoreRoomMember(prisma: PrismaClient, vendorId: string, userId: string, tenantId: string): Promise<boolean> {
  const vendor = await runWithTenant(tenantId, () => prisma.vendor.findFirst({
    where: {
      id: vendorId,
      tenantId,
      OR: [
        { owner: { userId, user: { tenantId } } },
        { staff: { some: { userId, user: { tenantId, status: 'ACTIVE' } } } },
      ],
    },
    select: { id: true },
  }));
  return vendor !== null;
}
