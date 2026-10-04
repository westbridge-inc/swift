import { Prisma, type PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { vi } from 'vitest';

/** A run owns successful inserts on its client, never a before/after census.
 * RETURNING excludes skipDuplicates losers; failure never records an ID.
 * Explicit single IDs also work when the production caller selects no id. */
export function trackMessageInserts(prisma: PrismaClient) {
  const alertIds = new Set<string>();
  const notificationIds = new Set<string>();
  const alerts = prisma.alertDelivery;
  const createAlert = alerts.create.bind(alerts);
  const insertAlerts = alerts.createManyAndReturn.bind(alerts);
  const singleAlert = vi.spyOn(alerts, 'create').mockImplementation((async (args: Prisma.AlertDeliveryCreateArgs) => {
    const id = args.data.id ?? `fixture-alert-${nanoid(16)}`;
    const result = await createAlert({ ...args, data: { ...args.data, id } });
    alertIds.add(id);
    return result;
  }) as unknown as typeof createAlert);
  const bulkAlert = vi.spyOn(alerts, 'createMany').mockImplementation((async (args: Prisma.AlertDeliveryCreateManyArgs) => {
    const rows = await insertAlerts({ ...args, select: { id: true } });
    for (const row of rows) alertIds.add(row.id);
    return { count: rows.length };
  }) as unknown as typeof alerts.createMany);
  const notices = prisma.notification;
  const createNotice = notices.create.bind(notices);
  const insertNotices = notices.createManyAndReturn.bind(notices);
  const singleNotice = vi.spyOn(notices, 'create').mockImplementation((async (args: Prisma.NotificationCreateArgs) => {
    const id = args.data.id ?? `fixture-notification-${nanoid(16)}`;
    const result = await createNotice({ ...args, data: { ...args.data, id } });
    notificationIds.add(id);
    return result;
  }) as unknown as typeof createNotice);
  const bulkNotice = vi.spyOn(notices, 'createMany').mockImplementation((async (args: Prisma.NotificationCreateManyArgs) => {
    const rows = await insertNotices({ ...args, select: { id: true } });
    for (const row of rows) notificationIds.add(row.id);
    return { count: rows.length };
  }) as unknown as typeof notices.createMany);
  return { alertIds, notificationIds, restore: () => {
    singleAlert.mockRestore(); bulkAlert.mockRestore(); singleNotice.mockRestore(); bulkNotice.mockRestore();
  } };
}
