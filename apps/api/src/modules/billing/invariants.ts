import type { PrismaClient } from '@prisma/client';
import { log } from '../../utils/logger';

// Nightly invariants [san spec 24.2 mapped onto the real engine]. The DB
// testifies; any failure pages. The wrongful-suspension detector AUTO-HEALS:
// cutting off a paying vendor is the worst harm this system can produce, so
// the machine catches its own mistake before the vendor does [16.3].

export interface InvariantReport {
  walletsChecked: number;
  walletMismatches: { subscriptionId: string; ledger: number; balance: number }[];
  wrongfulSuspensions: string[]; // auto-healed subscription ids
  enforcementLeaks: string[]; // ACTIVE but unpaid past grace+6h — alert only
  receiptGaps: { tenantId: string; year: number; expected: number; actual: number }[];
}

export async function runBillingInvariants(prisma: PrismaClient, now = new Date()): Promise<InvariantReport> {
  const report: InvariantReport = {
    walletsChecked: 0, walletMismatches: [], wrongfulSuspensions: [], enforcementLeaks: [], receiptGaps: [],
  };

  // 1. Balance provability: PrepaidBalance == Σ(PREPAID_TOPUP) − Σ(prepaid-settled charges).
  const wallets = await prisma.prepaidBalance.findMany({ select: { subscriptionId: true, balance: true } });
  for (const w of wallets) {
    report.walletsChecked += 1;
    const [topups, settles] = await Promise.all([
      prisma.billingEvent.aggregate({
        where: { subscriptionId: w.subscriptionId, type: 'PREPAID_TOPUP' },
        _sum: { amount: true },
      }),
      prisma.subscriptionPayment.aggregate({
        where: { subscriptionId: w.subscriptionId, status: 'CAPTURED', externalRef: 'prepaid' },
        _sum: { amount: true },
      }),
    ]);
    const ledger = Number(topups._sum.amount ?? 0) - Number(settles._sum.amount ?? 0);
    if (Math.abs(ledger - Number(w.balance)) > 0.009) {
      report.walletMismatches.push({ subscriptionId: w.subscriptionId, ledger, balance: Number(w.balance) });
    }
  }

  // 2. Wrongful suspension: SUSPENDED but paid through the future → HEAL + page.
  const wrongful = await prisma.subscription.findMany({
    where: { status: 'SUSPENDED', currentPeriodEnd: { gt: now } },
    select: { id: true },
  });
  for (const sub of wrongful) {
    await prisma.$transaction([
      prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'ACTIVE', suspendedAt: null, failedAttempts: 0 },
      }),
      prisma.billingEvent.create({
        data: {
          subscriptionId: sub.id,
          type: 'REINSTATED',
          idempotencyKey: `wrongful-heal:${sub.id}:${now.toISOString().slice(0, 10)}`,
          note: 'wrongful-suspension detector: paid-through account was suspended — auto-reactivated',
        },
      }),
    ]).catch((e) => {
      // A same-day duplicate heal is fine; anything else must surface.
      if (!(e instanceof Error && e.message.includes('Unique constraint'))) throw e;
    });
    report.wrongfulSuspensions.push(sub.id);
  }

  // 3. Enforcement leak: ACTIVE but unpaid past grace + 6h (revenue leaking
  //    silently). Alert only — enforcement decisions belong to dunning.
  const graceHours = 48;
  const leakCutoff = new Date(now.getTime() - (graceHours + 6) * 3_600_000);
  const leaks = await prisma.subscription.findMany({
    where: { status: 'ACTIVE', autoSuspendEnabled: true, feeWaived: false, currentPeriodEnd: { lt: leakCutoff } },
    select: { id: true },
  });
  report.enforcementLeaks = leaks.map((l) => l.id);

  // 4. Receipt gaplessness per tenant-year [scenario R].
  const counters = await prisma.receiptCounter.findMany();
  for (const c of counters) {
    const actual = await prisma.feeReceipt.count({
      where: { tenantId: c.tenantId, issuedAt: { gte: new Date(Date.UTC(c.year, 0, 1)), lt: new Date(Date.UTC(c.year + 1, 0, 1)) } },
    });
    if (actual !== c.seq) report.receiptGaps.push({ tenantId: c.tenantId, year: c.year, expected: c.seq, actual });
  }

  const broken = report.walletMismatches.length + report.wrongfulSuspensions.length + report.enforcementLeaks.length + report.receiptGaps.length;
  if (broken > 0) {
    log().error({ report }, 'billing invariants: FAILURES detected (wrongful suspensions auto-healed)');
  }
  return report;
}
