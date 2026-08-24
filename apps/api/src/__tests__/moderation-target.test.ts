import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveModerationTarget,
  type ModerationTargetType,
} from '../modules/moderation/moderation-target';

const input = (targetType: ModerationTargetType) => ({
  targetType,
  targetId: 'target',
  actorUserId: 'viewer',
  tenantId: 'tenant-a',
});

function mockApp(prisma: Record<string, unknown>): FastifyInstance {
  return { prisma } as unknown as FastifyInstance;
}

describe('moderation target resolver coverage', () => {
  const cases: Array<{
    targetType: ModerationTargetType;
    authorUserId: string;
    prisma: Record<string, unknown>;
  }> = [
    {
      targetType: 'USER',
      authorUserId: 'target',
      prisma: { user: { findFirst: vi.fn().mockResolvedValue({ id: 'target', firstName: 'Profile' }) } },
    },
    {
      targetType: 'VENDOR',
      authorUserId: 'owner',
      prisma: { vendor: { findFirst: vi.fn().mockResolvedValue({ id: 'target', name: 'Store', owner: { userId: 'owner' } }) } },
    },
    {
      targetType: 'ITEM',
      authorUserId: 'owner',
      prisma: { item: { findFirst: vi.fn().mockResolvedValue({ id: 'target', name: 'Item', vendor: { owner: { userId: 'owner' } } }) } },
    },
    {
      targetType: 'CATEGORY',
      authorUserId: 'owner',
      prisma: { category: { findFirst: vi.fn().mockResolvedValue({ id: 'target', name: 'Category', vendor: { owner: { userId: 'owner' } } }) } },
    },
    {
      targetType: 'PROMO_CODE',
      authorUserId: 'owner',
      prisma: { promoCode: { findFirst: vi.fn().mockResolvedValue({ id: 'target', code: 'SAVE', vendor: { owner: { userId: 'owner' } } }) } },
    },
    {
      targetType: 'RATING',
      authorUserId: 'reviewer',
      prisma: { rating: { findFirst: vi.fn().mockResolvedValue({ id: 'target', raterId: 'reviewer', score: 1, comment: 'Review' }) } },
    },
    {
      targetType: 'RATING_RESPONSE',
      authorUserId: 'manager',
      prisma: {
        rating: { findFirst: vi.fn().mockResolvedValue({ id: 'target', vendorId: 'vendor', response: 'Reply', respondedBy: 'manager' }) },
        vendor: { findFirst: vi.fn().mockResolvedValue({ id: 'vendor', name: 'Store', owner: { userId: 'owner' } }) },
        user: { findFirst: vi.fn().mockResolvedValue({ id: 'manager' }) },
      },
    },
    {
      targetType: 'CHAT_MESSAGE',
      authorUserId: 'sender',
      prisma: {
        chatMessage: { findFirst: vi.fn().mockResolvedValue({ id: 'target', senderId: 'sender', message: 'Message' }) },
        user: { findFirst: vi.fn().mockResolvedValue({ id: 'sender' }) },
      },
    },
    {
      targetType: 'SERVICE_PROVIDER',
      authorUserId: 'provider',
      prisma: { serviceProvider: { findFirst: vi.fn().mockResolvedValue({ id: 'target', userId: 'provider', bio: 'Bio' }) } },
    },
    {
      targetType: 'SERVICE_JOB',
      authorUserId: 'customer',
      prisma: { serviceJob: { findFirst: vi.fn().mockResolvedValue({ id: 'target', customerId: 'customer', description: 'Job' }) } },
    },
    {
      targetType: 'ORDER',
      authorUserId: 'driver',
      prisma: {
        order: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'target',
            customerId: 'viewer',
            driver: { userId: 'driver' },
            rider: null,
            vendor: null,
            deliveryInstructions: 'Instructions',
          }),
        },
      },
    },
    {
      targetType: 'AD_CREATIVE',
      authorUserId: 'advertiser',
      prisma: {
        adCreative: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'target',
            headline: 'Headline',
            campaign: { advertiser: { createdByUserId: 'advertiser' } },
          }),
        },
      },
    },
  ];

  for (const testCase of cases) {
    it(`resolves ${testCase.targetType} to its server-owned author and evidence`, async () => {
      const result = await resolveModerationTarget(mockApp(testCase.prisma), input(testCase.targetType));

      expect(result).toMatchObject({
        targetType: testCase.targetType,
        targetId: 'target',
        tenantId: 'tenant-a',
        authorUserId: testCase.authorUserId,
        snapshot: { id: 'target' },
      });
    });
  }

  it('keeps retained staff-authored reply evidence reportable without misdirecting a block', async () => {
    const app = mockApp({
      rating: { findFirst: vi.fn().mockResolvedValue({ id: 'target', vendorId: 'vendor', response: 'Reply', respondedBy: 'deleted-manager' }) },
      vendor: { findFirst: vi.fn().mockResolvedValue({ id: 'vendor', name: 'Store', owner: { userId: 'owner' } }) },
      user: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    await expect(resolveModerationTarget(app, input('RATING_RESPONSE'))).resolves.toMatchObject({
      authorUserId: null,
      snapshot: { id: 'target', response: 'Reply' },
    });
  });

  it('fails closed when the selected target is absent or inaccessible', async () => {
    const app = mockApp({ user: { findFirst: vi.fn().mockResolvedValue(null) } });
    await expect(resolveModerationTarget(app, input('USER'))).resolves.toBeNull();
  });
});
