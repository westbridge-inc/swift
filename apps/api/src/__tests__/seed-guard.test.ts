import { describe, expect, it, vi } from 'vitest';
import { assertSafeToSeedDemo, DEMO_PHONE_PREFIX } from '../utils/seed-guard';

const confirmedEnv = {
  NODE_ENV: 'development',
  SEED_DEMO_CONFIRM: 'YES',
};

const db = (nonDemoVendors = 0, orders = 0) =>
  ({
    vendor: { count: vi.fn().mockResolvedValue(nonDemoVendors) },
    order: { count: vi.fn().mockResolvedValue(orders) },
  }) as unknown as Parameters<typeof assertSafeToSeedDemo>[0];

describe('[F-0001] demo seed safety gate', () => {
  it('refuses production with no override', async () => {
    await expect(
      assertSafeToSeedDemo(db(), {
        NODE_ENV: 'production',
        SEED_DEMO_CONFIRM: 'YES',
      }),
    ).rejects.toThrow(/NODE_ENV=production/);
  });

  it.each([undefined, 'staging', 'preview'])('refuses NODE_ENV=%s', async (nodeEnv) => {
    await expect(
      assertSafeToSeedDemo(db(), {
        NODE_ENV: nodeEnv,
        SEED_DEMO_CONFIRM: 'YES',
      }),
    ).rejects.toThrow(/NODE_ENV must be development or test/);
  });

  it.each([undefined, '', 'yes', 'true'])('requires exact confirmation (got %s)', async (confirmation) => {
    await expect(
      assertSafeToSeedDemo(db(), {
        NODE_ENV: 'development',
        SEED_DEMO_CONFIRM: confirmation,
      }),
    ).rejects.toThrow(/SEED_DEMO_CONFIRM=YES/);
  });

  it('refuses a non-demo vendor even when explicitly confirmed', async () => {
    await expect(assertSafeToSeedDemo(db(1, 0), confirmedEnv)).rejects.toThrow(
      /1 non-demo vendor\(s\)/,
    );
  });

  it('refuses any order even when explicitly confirmed', async () => {
    await expect(assertSafeToSeedDemo(db(0, 2), confirmedEnv)).rejects.toThrow(/2 order\(s\)/);
  });

  it('fails closed when inspecting the target database fails', async () => {
    const unavailable = {
      vendor: { count: vi.fn().mockRejectedValue(new Error('database unavailable')) },
      order: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as Parameters<typeof assertSafeToSeedDemo>[0];

    await expect(assertSafeToSeedDemo(unavailable, confirmedEnv)).rejects.toThrow(
      /database unavailable/,
    );
  });

  it.each(['development', 'test'])('allows an empty %s database after explicit confirmation', async (nodeEnv) => {
    await expect(
      assertSafeToSeedDemo(db(), {
        NODE_ENV: nodeEnv,
        SEED_DEMO_CONFIRM: 'YES',
      }),
    ).resolves.toBeUndefined();
  });

  it('classifies demo vendors by their seeded owner phone range', async () => {
    const target = db();

    await assertSafeToSeedDemo(target, confirmedEnv);

    expect(target.vendor.count).toHaveBeenCalledWith({
      where: {
        owner: {
          user: {
            phone: { not: { startsWith: DEMO_PHONE_PREFIX } },
          },
        },
      },
    });
  });
});
