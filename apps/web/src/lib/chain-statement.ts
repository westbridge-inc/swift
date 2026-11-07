'use client';

import { apiFetch } from './auth';

// [ENTERPRISE E3 · owner 29 Oct 2026] The owner's fee statement for one month (GET /vendor/subscription/chain-statement):
// the server's rows as they are. The page renders them and never adds a figure the server did not send.

export interface ChainStatementBranch {
  vendorId: string;
  branchName: string;
  address: string;
  subscriptionStatus: string | null;
  weeklyFee: number | null;
  feeWaived: boolean;
  dealWeeklyRate: number | null;
  weeks: Array<{ periodStart: string; periodEnd: string; amount: number; paidAt: string | null }>;
  owedNow: { amount: number; dueSince: string } | null;
  receipts: Array<{ receiptNumber: string; issuedAt: string; amount: number; channel: string | null }>;
  weeksTotal: number;
  receiptsTotal: number;
}

export interface ChainStatement {
  month: string;
  from: string;
  to: string;
  issuer: { name: string; tradingAs: string; registrationNo: string; registeredOffice: string; tin: string | null };
  billedTo: { name: string; email: string | null; phone: string | null };
  currencyCode: string;
  deal: { weeklyRate: number; currencyCode: string } | null;
  branches: ChainStatementBranch[];
  totals: { weeksCharged: number; received: number; owedNow: number };
  vatNote: string;
  generatedAt: string;
}

export const getChainStatement = (month: string): Promise<ChainStatement> =>
  apiFetch(`/api/v1/vendor/subscription/chain-statement?month=${encodeURIComponent(month)}`).then((r) => r.data as ChainStatement);

/** A moment in Guyana, "29 Oct 2026, 3:05 pm". */
export const statementTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

/** This month in Guyana, "YYYY-MM" (the latest a statement may be asked for). */
export function thisGuyanaMonth(now: Date = new Date()): string {
  return new Date(now.getTime() - 4 * 3_600_000).toISOString().slice(0, 7);
}

/** A day in Guyana, "29 Oct 2026". */
export const statementDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'short', year: 'numeric' });

/** Last month in Guyana (UTC-4, no daylight saving), "YYYY-MM": the statement a business usually asks for. */
export function lastGuyanaMonth(now: Date = new Date()): string {
  const gy = new Date(now.getTime() - 4 * 3_600_000);
  return new Date(Date.UTC(gy.getUTCFullYear(), gy.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}
