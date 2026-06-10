import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';

type TransactionType =
  | 'ORDER_PAYMENT'
  | 'ORDER_REFUND'
  | 'WALLET_TOPUP'
  | 'WALLET_WITHDRAWAL'
  | 'SUBSCRIPTION_PAYMENT'
  | 'EARNING_PAYOUT'
  | 'TIP_RECEIVED'
  | 'PROMO_CREDIT'
  | 'ADJUSTMENT';

export class WalletService {
  constructor(private prisma: PrismaClient) {}

  async getBalance(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { walletBalance: true },
    });
    return user ? Number(user.walletBalance) : 0;
  }

  async credit(userId: string, amount: number, type: TransactionType, description: string, reference?: string): Promise<number> {
    if (amount <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be positive');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { walletBalance: { increment: amount } },
      });
      const newBalance = Number(updated.walletBalance);
      await tx.transaction.create({
        data: { userId, type, amount, direction: 'in', description, reference, balanceAfter: newBalance },
      });
      return newBalance;
    });
  }

  async debit(userId: string, amount: number, type: TransactionType, description: string, reference?: string): Promise<number> {
    if (amount <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be positive');

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { walletBalance: true } });
      const current = user ? Number(user.walletBalance) : 0;
      if (current < amount) {
        throw new AppError(400, 'INSUFFICIENT_BALANCE', `Insufficient wallet balance. Available: ${current.toLocaleString()} GYD`);
      }
      const updated = await tx.user.update({
        where: { id: userId },
        data: { walletBalance: { decrement: amount } },
      });
      const newBalance = Number(updated.walletBalance);
      await tx.transaction.create({
        data: { userId, type, amount, direction: 'out', description, reference, balanceAfter: newBalance },
      });
      return newBalance;
    }, { isolationLevel: 'Serializable' });
  }

  async topUp(userId: string, amount: number, paymentMethod: string, externalRef?: string): Promise<number> {
    return this.credit(userId, amount, 'WALLET_TOPUP', `Wallet top-up via ${paymentMethod}`, externalRef);
  }

  async withdraw(userId: string, amount: number, method: string, destination: Record<string, unknown>): Promise<{ requestId: string; newBalance: number }> {
    const balance = await this.getBalance(userId);
    if (balance < amount) {
      throw new AppError(400, 'INSUFFICIENT_BALANCE', `Insufficient balance. Available: $${balance.toLocaleString()} GYD`);
    }

    const fee = this.calculateWithdrawalFee(amount, method);
    const netAmount = amount - fee;

    const payout = await this.prisma.payoutRequest.create({
      data: {
        userId,
        amount,
        method: method as 'WALLET' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'CASH_PICKUP',
        destination: destination as any,
        fee,
        netAmount,
        status: 'PENDING',
      },
    });

    const newBalance = await this.debit(userId, amount, 'WALLET_WITHDRAWAL', `Withdrawal via ${method}`, payout.id);

    return { requestId: payout.id, newBalance };
  }

  async processEarningPayout(userId: string, earningId: string, amount: number): Promise<number> {
    return this.credit(userId, amount, 'EARNING_PAYOUT', 'Delivery earning payout', earningId);
  }

  async refund(userId: string, amount: number, orderId: string): Promise<number> {
    return this.credit(userId, amount, 'ORDER_REFUND', `Refund for order`, orderId);
  }

  async getTransactions(userId: string, options?: { type?: string; limit?: number; offset?: number }) {
    const where: Record<string, unknown> = { userId };
    if (options?.type) where['type'] = options.type;

    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: options?.limit || 20,
        skip: options?.offset || 0,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return { transactions, total };
  }

  private calculateWithdrawalFee(amount: number, method: string): number {
    switch (method) {
      case 'MOBILE_MONEY':
        return Math.ceil(amount * 0.015); // 1.5%
      case 'BANK_TRANSFER':
        return 500; // flat $500 GYD
      case 'CASH_PICKUP':
        return 200; // flat $200 GYD
      default:
        return 0;
    }
  }
}
