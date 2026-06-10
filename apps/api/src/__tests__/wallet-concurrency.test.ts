import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { WalletService } from '../modules/wallet/wallet.service';

// ---------------------------------------------------------------------------
// SEC-2 regression — concurrent debits must never overdraw a wallet.
// Before the fix, the balance check and the decrement ran outside a
// transaction, so two simultaneous debits could both pass the check.
// ---------------------------------------------------------------------------

const TEST_PHONE = '+5920000999';

const prisma = new PrismaClient();
const wallet = new WalletService(prisma);
let userId: string;

beforeAll(async () => {
  // Remove leftovers from a previous interrupted run
  await prisma.transaction.deleteMany({ where: { user: { phone: TEST_PHONE } } });
  await prisma.user.deleteMany({ where: { phone: TEST_PHONE } });

  const user = await prisma.user.create({
    data: {
      phone: TEST_PHONE,
      firstName: 'Wallet',
      lastName: 'Race',
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      walletBalance: 1000,
    },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.transaction.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('SEC-2 regression — wallet debit race condition', () => {
  it('never allows concurrent debits to overdraw the balance', async () => {
    // Balance covers exactly one of these five debits
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => wallet.debit(userId, 1000, 'ORDER_PAYMENT', 'race test')),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;

    // Serializable isolation: at most one debit can commit
    expect(succeeded).toBeLessThanOrEqual(1);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { walletBalance: true },
    });
    const balance = Number(user.walletBalance);

    // The invariant that was violated before the fix
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(balance).toBe(1000 - succeeded * 1000);

    // Ledger stays consistent: one transaction record per committed debit
    const txCount = await prisma.transaction.count({ where: { userId, direction: 'out' } });
    expect(txCount).toBe(succeeded);
  });

  it('rejects a single debit that exceeds the balance', async () => {
    await prisma.user.update({ where: { id: userId }, data: { walletBalance: 500 } });
    await expect(
      wallet.debit(userId, 600, 'ORDER_PAYMENT', 'overdraw test'),
    ).rejects.toThrowError(/insufficient/i);
  });
});
