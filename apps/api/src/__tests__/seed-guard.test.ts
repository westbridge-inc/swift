import { describe, expect, it, vi } from 'vitest';
import { assertSafeToSeedDemo, DEMO_IDENTITY_PHONES } from '../utils/seed-guard';

const confirmedEnv = {
  NODE_ENV: 'development',
  SEED_DEMO_CONFIRM: 'YES',
};

const db = (nonDemoUsers = 0, nonDemoVendors = 0, orders = 0) =>
  ({
    user: { count: vi.fn().mockResolvedValue(nonDemoUsers) },
    vendor: { count: vi.fn().mockResolvedValue(nonDemoVendors) },
    order: { count: vi.fn().mockResolvedValue(orders) },
  }) as unknown as Parameters<typeof assertSafeToSeedDemo>[0];

interface VendorCountArgs {
  where?: {
    owner?: {
      user?: {
        phone?: {
          not?: { startsWith?: string };
          notIn?: readonly string[];
        };
      };
    };
  };
}

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
    await expect(assertSafeToSeedDemo(db(0, 1, 0), confirmedEnv)).rejects.toThrow(
      /1 non-demo vendor\(s\)/,
    );
  });

  it('refuses a users-only non-demo database even when explicitly confirmed', async () => {
    await expect(assertSafeToSeedDemo(db(1, 0, 0), confirmedEnv)).rejects.toThrow(
      /1 non-demo user\(s\)/,
    );
  });

  it('does not classify a vendor as demo merely because its owner phone shares the prefix', async () => {
    const ownerPhone = '+5926009999';
    const target = {
      user: { count: vi.fn().mockResolvedValue(0) },
      vendor: {
        count: vi.fn().mockImplementation(async (args: VendorCountArgs) => {
          const phoneFilter = args.where?.owner?.user?.phone;

          if (phoneFilter?.not?.startsWith) {
            return ownerPhone.startsWith(phoneFilter.not.startsWith) ? 0 : 1;
          }

          if (phoneFilter?.notIn) {
            return phoneFilter.notIn.includes(ownerPhone) ? 0 : 1;
          }

          return 1;
        }),
      },
      order: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as Parameters<typeof assertSafeToSeedDemo>[0];

    await expect(assertSafeToSeedDemo(target, confirmedEnv)).rejects.toThrow(
      /1 non-demo vendor\(s\)/,
    );
  });

  it('refuses any order even when explicitly confirmed', async () => {
    await expect(assertSafeToSeedDemo(db(0, 0, 2), confirmedEnv)).rejects.toThrow(/2 order\(s\)/);
  });

  it('fails closed when inspecting the target database fails', async () => {
    const unavailable = {
      user: { count: vi.fn().mockResolvedValue(0) },
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

  it('classifies demo users and vendors only by exact seeded identity phones', async () => {
    const target = db();

    await assertSafeToSeedDemo(target, confirmedEnv);

    expect(target.user.count).toHaveBeenCalledWith({
      where: {
        phone: { notIn: [...DEMO_IDENTITY_PHONES] },
      },
    });
    expect(target.vendor.count).toHaveBeenCalledWith({
      where: {
        owner: {
          user: {
            phone: { notIn: [...DEMO_IDENTITY_PHONES] },
          },
        },
      },
    });
  });
});
