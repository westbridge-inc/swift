import type { PrismaClient } from '@prisma/client';
import type { NotificationService } from '../notification/notification.service';

// The ONE "tell the advertiser's owners" implementation (§16). Every ads
// surface that talks to an advertiser routes through here: OWNER members get
// the notification; failures are swallowed per the notification law (a notify
// hiccup never breaks the money path that triggered it).

export async function notifyAdvertiserOwners(
  prisma: PrismaClient,
  notifications: NotificationService,
  advertiserId: string,
  payload: { title: string; body: string; kind: string; data?: Record<string, unknown> },
): Promise<void> {
  const owners = await prisma.advertiserMember.findMany({ where: { advertiserId, role: 'OWNER' }, select: { userId: true } });
  for (const o of owners) {
    await notifications
      .send({
        userId: o.userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: payload.title,
        body: payload.body,
        data: { kind: payload.kind, ...(payload.data ?? {}) },
      })
      .catch(() => {});
  }
}
