import { activeOverdueMs, currentDunningClock, FULL_FEE_GRACE_MS, lockBillingAuthority } from './dunning-clock';
import type { PrismaClient } from '@prisma/client';
import { log } from '../../utils/logger';
import { restoreBillingAccess } from './billing-access';

// Nightly invariants [san spec 24.2 mapped onto the real engine]. The DB
// testifies; any failure pages. The wrongful-suspension detector AUTO-HEALS:
// cutting off a paying vendor is the worst harm this system can produce, so
// the machine catches its own mistake before the vendor does [16.3].

export interface InvariantReport {
  walletsChecked: number;
  walletMismatches: { subscriptionId: string; ledger: number; balance: number }[];
  wrongfulSuspensions: string[]; // auto-healed subscription ids
  earlyBillingSuspensions: string[]; // historical timing evidence; never clears unrelated restrictions
  enforcementLeaks: string[]; // ACTIVE but unpaid past grace+6h — alert only
  /** Subscriptions whose payer or shared clock could not be read, so neither
   *  detector could judge them (ownership needs review) — alert only. One such
   *  row never stops the run: every later check, the S0 ledger ones included,
   *  still runs. */
  unjudgedSubscriptions: string[];
  receiptGaps: { tenantId: string; year: number; expected: number; actual: number }[];
  /** Σdebits ≠ Σcredits across the whole double-entry ledger — S0, the books are broken [tollgate 16.2]. */
  ledgerTrialImbalance: { debits: number; credits: number } | null;
  /** PrepaidBalance ≠ its WALLET_LIABILITY subledger — S0, a credit path bypassed the ledger [tollgate M-13]. */
  ledgerWalletMismatches: { subscriptionId: string; ledgerBalance: number; walletBalance: number }[];
  /** A refund set-aside whose REFUND_PAYABLE subledger disagrees with its
   *  events (set aside − paid − released): money owed back that the books
   *  and the record do not agree on. */
  refundPayableMismatches: { subscriptionId: string; ledgerBalance: number; openSetAside: number }[];
}

export async function runBillingInvariants(prisma: PrismaClient, now = new Date()): Promise<InvariantReport> {
  const report: InvariantReport = {
    walletsChecked: 0, walletMismatches: [], wrongfulSuspensions: [], earlyBillingSuspensions: [], enforcementLeaks: [], unjudgedSubscriptions: [], receiptGaps: [],
    ledgerTrialImbalance: null, ledgerWalletMismatches: [], refundPayableMismatches: [],
  };

  // 1. Balance provability: PrepaidBalance == Σ(PREPAID_TOPUP) − Σ(prepaid-settled charges)
  //    − Σ(credit set aside for a refund) + Σ(set-asides released back unpaid).
  //    A set-aside that is PAID leaves REFUND_PAYABLE, not the wallet (check 7).
  const wallets = await prisma.prepaidBalance.findMany({ select: { subscriptionId: true, balance: true } });
  for (const w of wallets) {
    report.walletsChecked += 1;
    const [topups, settles, setAside, released] = await Promise.all([
      prisma.billingEvent.aggregate({
        where: { subscriptionId: w.subscriptionId, type: 'PREPAID_TOPUP' },
        _sum: { amount: true },
      }),
      prisma.subscriptionPayment.aggregate({
        where: { subscriptionId: w.subscriptionId, status: 'CAPTURED', externalRef: 'prepaid' },
        _sum: { amount: true },
      }),
      prisma.billingEvent.aggregate({
        where: { subscriptionId: w.subscriptionId, type: 'PREPAID_REFUND_RESERVED' },
        _sum: { amount: true },
      }),
      prisma.billingEvent.aggregate({
        where: { subscriptionId: w.subscriptionId, type: 'PREPAID_REFUND_RELEASED' },
        _sum: { amount: true },
      }),
    ]);
    const ledger = Number(topups._sum.amount ?? 0) - Number(settles._sum.amount ?? 0)
      - Number(setAside._sum.amount ?? 0) + Number(released._sum.amount ?? 0);
    if (Math.abs(ledger - Number(w.balance)) > 0.009) {
      report.walletMismatches.push({ subscriptionId: w.subscriptionId, ledger, balance: Number(w.balance) });
    }
  }

  // 2. Wrongful suspension: SUSPENDED but paid through the future → HEAL + page.
  const wrongful = await prisma.subscription.findMany({
    where: { status: 'SUSPENDED', currentPeriodEnd: { gt: now } },
    select: { id: true },
  });
  const unjudged = (subscriptionId: string, err: unknown) => {
    if (!report.unjudgedSubscriptions.includes(subscriptionId)) report.unjudgedSubscriptions.push(subscriptionId);
    log().error({ err, subscriptionId }, '[billing invariants] subscription payer or clock unreadable; reported, the run continues');
  };
  for (const candidate of wrongful) {
    let healed = false;
    try {
      healed = await prisma.$transaction(async (tx) => {
        const authority = await lockBillingAuthority(tx, candidate.id);
        const sub = await tx.subscription.findUniqueOrThrow({ where: { id: candidate.id }, include: { vendor: true } });
        const recorded = await tx.billingEvent.findUnique({ where: { idempotencyKey: `suspended:${sub.id}:${sub.nextBillingDate.toISOString().slice(0, 10)}` } });
        if (sub.status !== 'SUSPENDED' || !sub.autoRenew || authority.userStatus !== 'ACTIVE'
          || sub.currentPeriodEnd <= now || sub.nextBillingDate < sub.currentPeriodEnd || !recorded
          || (sub.vendor && sub.vendor.suspensionSource !== 'BILLING')) return false;
        await tx.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', suspendedAt: null, failedAttempts: 0 } });
        // [SUSPENSION-HEAL · AUD-L8b-003 · owner ruling] The heal gives back
        // everything the billing suspension took, in this transaction: the
        // store's ACTIVE status AND its order intake (the same restore a real
        // payment runs, billing-access.ts). An admin/safety/moderation hold is
        // never a BILLING suspension and is refused above.
        if (sub.vendor) await restoreBillingAccess(tx, sub.vendor.id);
        await tx.billingEvent.create({ data: { subscriptionId: sub.id, type: 'REINSTATED',
          idempotencyKey: `wrongful-heal:${sub.id}:${now.toISOString().slice(0, 10)}`,
          note: 'wrongful-suspension detector: a recorded billing suspension conflicted with paid coverage; current billing authority and store access restored',
        } });
        return true;
      });
    } catch (err) {
      unjudged(candidate.id, err);
    }
    if (healed) report.wrongfulSuspensions.push(candidate.id);
  }

  // 3. The shared active-time clock also governs the detector. A confirmation
  // pause is not an enforcement leak, however many wall-clock days it lasts.
  const candidates = await prisma.subscription.findMany({
    where: { status: { in: ['ACTIVE', 'SUSPENDED'] }, autoSuspendEnabled: true, feeWaived: false },
    select: { id: true, status: true, suspendedAt: true },
  });
  for (const sub of candidates) {
    let clock: Awaited<ReturnType<typeof currentDunningClock>>;
    try {
      clock = await prisma.$transaction((tx) => currentDunningClock(tx, sub.id, now));
    } catch (err) {
      unjudged(sub.id, err);
      continue;
    }
    if (sub.status === 'ACTIVE' && !clock.pausedAt && activeOverdueMs(clock, now) > FULL_FEE_GRACE_MS + 6 * 3_600_000) {
      report.enforcementLeaks.push(sub.id);
    }
    if (sub.status === 'SUSPENDED' && sub.suspendedAt && sub.suspendedAt.getTime() < clock.dueAt.getTime() + FULL_FEE_GRACE_MS) {
      report.earlyBillingSuspensions.push(sub.id);
    }
  }

  // 4. Receipt gaplessness per tenant-year [scenario R].
  const counters = await prisma.receiptCounter.findMany();
  for (const c of counters) {
    const actual = await prisma.feeReceipt.count({
      where: { tenantId: c.tenantId, issuedAt: { gte: new Date(Date.UTC(c.year, 0, 1)), lt: new Date(Date.UTC(c.year + 1, 0, 1)) } },
    });
    if (actual !== c.seq) report.receiptGaps.push({ tenantId: c.tenantId, year: c.year, expected: c.seq, actual });
  }

  // 5. Ledger trial balance [tollgate 16.2, S0]: Σdebits == Σcredits, whole
  //    ledger. The deferred DB trigger makes an unbalanced COMMIT impossible;
  //    this catches what triggers can't (a bypassed environment, manual SQL).
  const [tb] = await prisma.$queryRaw<{ debits: number; credits: number }[]>`
    SELECT COALESCE(SUM(debit), 0)::float8 AS debits, COALESCE(SUM(credit), 0)::float8 AS credits
    FROM ledger_entries`;
  if (tb && Math.abs(tb.debits - tb.credits) > 0.009) {
    report.ledgerTrialImbalance = { debits: tb.debits, credits: tb.credits };
  }

  // 6. Wallet vs ledger [tollgate M-13, S0]: every prepaid balance must equal
  //    its WALLET_LIABILITY subledger (credits − debits). Legacy balances get
  //    opening postings in the ledger-foundation migration, so any mismatch —
  //    including a wallet with money but NO ledger rows — means a write path
  //    bypassed postLedger.
  const subledger = await prisma.$queryRaw<{ subscriptionId: string; bal: number }[]>`
    SELECT "subledgerId" AS "subscriptionId", COALESCE(SUM(credit - debit), 0)::float8 AS bal
    FROM ledger_entries
    WHERE "accountCode" = 'WALLET_LIABILITY' AND "subledgerId" IS NOT NULL
    GROUP BY "subledgerId"`;
  const ledgerBySub = new Map(subledger.map((r) => [r.subscriptionId, r.bal]));
  for (const w of wallets) {
    const ledgerBalance = ledgerBySub.get(w.subscriptionId) ?? 0;
    if (Math.abs(ledgerBalance - Number(w.balance)) > 0.009) {
      report.ledgerWalletMismatches.push({
        subscriptionId: w.subscriptionId,
        ledgerBalance,
        walletBalance: Number(w.balance),
      });
    }
  }

  // 7. Refund set-asides: the REFUND_PAYABLE subledger equals, per
  //    subscription, Σ(set aside) − Σ(paid back) − Σ(released) from the events.
  const payable = await prisma.$queryRaw<{ subscriptionId: string; bal: number }[]>`
    SELECT "subledgerId" AS "subscriptionId", COALESCE(SUM(credit - debit), 0)::float8 AS bal
    FROM ledger_entries
    WHERE "accountCode" = 'REFUND_PAYABLE' AND "subledgerId" IS NOT NULL
    GROUP BY "subledgerId"`;
  const refundEvents = await prisma.billingEvent.groupBy({
    by: ['subscriptionId', 'type'],
    where: { type: { in: ['PREPAID_REFUND_RESERVED', 'PREPAID_REFUND', 'PREPAID_REFUND_RELEASED'] } },
    _sum: { amount: true },
  });
  const openBySub = new Map<string, number>();
  for (const e of refundEvents) {
    const sign = e.type === 'PREPAID_REFUND_RESERVED' ? 1 : -1;
    openBySub.set(e.subscriptionId, (openBySub.get(e.subscriptionId) ?? 0) + sign * Number(e._sum.amount ?? 0));
  }
  const payableBySub = new Map(payable.map((r) => [r.subscriptionId, r.bal]));
  for (const subscriptionId of new Set([...openBySub.keys(), ...payableBySub.keys()])) {
    const ledgerBalance = payableBySub.get(subscriptionId) ?? 0;
    const openSetAside = openBySub.get(subscriptionId) ?? 0;
    if (Math.abs(ledgerBalance - openSetAside) > 0.009) {
      report.refundPayableMismatches.push({ subscriptionId, ledgerBalance, openSetAside });
    }
  }

  const broken =
    report.walletMismatches.length + report.wrongfulSuspensions.length + report.earlyBillingSuspensions.length + report.enforcementLeaks.length +
    report.receiptGaps.length + report.ledgerWalletMismatches.length + report.refundPayableMismatches.length + (report.ledgerTrialImbalance ? 1 : 0);
  if (broken > 0) {
    log().error({ report }, 'billing invariants: FAILURES detected (wrongful suspensions auto-healed)');
  }
  return report;
}
