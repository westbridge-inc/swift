import type { PrismaClient } from '@prisma/client';

/** Explicit GO fixture precondition: a phone has registered for push. */
export async function registerMoverPush(db: PrismaClient, userId: string): Promise<void> {
  const token = `ExpoPushToken[fixture-${userId}]`;
  await db.deviceToken.upsert({ where: { token },
    create: { userId, token, platform: 'ios', isActive: true },
    update: { isActive: true },
  });
}
