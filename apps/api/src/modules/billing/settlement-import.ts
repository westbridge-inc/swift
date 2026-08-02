import type { PrismaClient } from '@prisma/client';
import type { AgentCashService } from './agent-cash.service';
import { log } from '../../utils/logger';

// Channel B — settlement-file import [san spec 4.3]. Tolerant CSV parser with
// a configurable header map (MMG's real format lands via PlatformConfig, no
// redeploy). Every row rides the SAME ingest pipeline; the file's txn id is
// both externalId (idempotency: re-importing the file is a no-op) and
// mmgTxnId (cross-channel dedupe: a webhook-credited payment reconciles).
// The recon report is the founder's proof the file and the ledger agree.

export interface SettlementHeaderMap {
  txnId: string;
  san: string;
  amount: string;
  paidAt: string;
  payerMsisdn?: string;
  agentRef?: string;
}

export const DEFAULT_HEADER_MAP: SettlementHeaderMap = {
  txnId: 'transaction_id',
  san: 'account_number',
  amount: 'amount',
  paidAt: 'paid_at',
  payerMsisdn: 'payer_msisdn',
  agentRef: 'agent_id',
};

export interface SettlementReport {
  fileRows: number;
  credited: number;
  reconciled: number;
  duplicates: number;
  unmatched: number;
  rejectedRows: { line: number; reason: string }[];
  totalGyd: number;
  trailerTotalGyd: number | null;
  trailerMismatch: boolean;
}

/** Minimal CSV split honoring quoted fields — MMG files are simple, but a
 *  vendor name with a comma must not shear the row. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export async function importSettlementCsv(
  prisma: PrismaClient,
  svc: AgentCashService,
  csvText: string,
  opts: { source: string; headerMap?: Partial<SettlementHeaderMap> } ,
): Promise<SettlementReport> {
  const configured = await prisma.platformConfig.findUnique({ where: { key: 'billing.mmg_agent.settlement_headers' } });
  const map: SettlementHeaderMap = {
    ...DEFAULT_HEADER_MAP,
    ...((configured?.value as Partial<SettlementHeaderMap> | null) ?? {}),
    ...(opts.headerMap ?? {}),
  };

  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('EMPTY_FILE');
  const headers = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const col = (name: string) => headers.indexOf(name.toLowerCase());
  const idx = {
    txnId: col(map.txnId),
    san: col(map.san),
    amount: col(map.amount),
    paidAt: col(map.paidAt),
    payerMsisdn: map.payerMsisdn ? col(map.payerMsisdn) : -1,
    agentRef: map.agentRef ? col(map.agentRef) : -1,
  };
  if (idx.txnId < 0 || idx.san < 0 || idx.amount < 0) {
    throw new Error(`HEADERS_UNRECOGNIZED: need ${map.txnId}, ${map.san}, ${map.amount} — got [${headers.join(', ')}]`);
  }

  const report: SettlementReport = {
    fileRows: 0, credited: 0, reconciled: 0, duplicates: 0, unmatched: 0,
    rejectedRows: [], totalGyd: 0, trailerTotalGyd: null, trailerMismatch: false,
  };

  for (let line = 1; line < lines.length; line += 1) {
    const cells = splitCsvLine(lines[line]!);
    const first = (cells[0] ?? '').toUpperCase();
    // Trailer row: "TOTAL,<sum>" or similar — the file's own claimed total.
    if (first === 'TOTAL' || first === 'TRAILER') {
      const claimed = Number((cells[1] ?? '').replace(/[^0-9.]/g, ''));
      if (Number.isFinite(claimed)) report.trailerTotalGyd = claimed;
      continue;
    }
    report.fileRows += 1;
    const txnId = cells[idx.txnId] ?? '';
    const sanRaw = cells[idx.san] ?? '';
    const amount = Number((cells[idx.amount] ?? '').replace(/[^0-9.-]/g, ''));
    if (!txnId || !sanRaw || !Number.isFinite(amount) || amount <= 0) {
      report.rejectedRows.push({ line: line + 1, reason: 'missing txn id / SAN / positive amount' });
      continue;
    }
    const paidAtRaw = idx.paidAt >= 0 ? cells[idx.paidAt] : undefined;
    const paidAt = paidAtRaw && !Number.isNaN(Date.parse(paidAtRaw)) ? new Date(paidAtRaw) : new Date();

    const res = await svc.ingest({
      externalId: txnId,
      channel: 'MMG_SETTLEMENT_FILE',
      mmgTxnId: txnId,
      sanRaw,
      amount,
      currencyCode: 'GYD',
      paidAt,
      payerMsisdn: idx.payerMsisdn >= 0 ? cells[idx.payerMsisdn] || undefined : undefined,
      agentRef: idx.agentRef >= 0 ? cells[idx.agentRef] || undefined : undefined,
      raw: { source: opts.source, line: line + 1, cells },
    });
    report.totalGyd += amount;
    if (res.status === 'accepted') report.credited += 1;
    else if (res.status === 'reconciled') report.reconciled += 1;
    else if (res.status === 'duplicate') report.duplicates += 1;
    else report.unmatched += 1;
  }

  if (report.trailerTotalGyd !== null && Math.abs(report.trailerTotalGyd - report.totalGyd) > 0.009) {
    report.trailerMismatch = true; // caller alerts — a file that disagrees with itself is a fatal-five
    log().error({ claimed: report.trailerTotalGyd, summed: report.totalGyd, source: opts.source }, 'settlement trailer mismatch');
  }
  return report;
}
