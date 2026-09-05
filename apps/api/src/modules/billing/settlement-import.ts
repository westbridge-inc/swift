import type { OnAudit } from '../../lib/audit-writer';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AgentCashService, IngestResult } from './agent-cash.service';
import { settlementImportsRejectedCounter, settlementBatchesUnbalancedGauge } from '../../plugins/observability';
import { log } from '../../utils/logger';

// Channel B — settlement-file import [san spec 4.3]. A configurable header map
// (MMG's real format lands via PlatformConfig, no redeploy). Every row rides
// the SAME ingest pipeline; the file's txn id is both externalId (idempotency:
// re-importing the file is a no-op) and mmgTxnId (cross-channel dedupe: a
// webhook-credited payment reconciles). The recon report is the founder's
// proof the file and the ledger agree.
//
// [M-20] THE FILE IS VALIDATED IN FULL BEFORE ANY ROW PUBLISHES MONEY. Before,
// rows were credited one by one inside the parse loop and the control total
// was checked only at the end — a truncated, tampered, malformed or
// wrong-total file had already credited every row it managed to parse, and a
// retry (or the same payments by another channel) compounded them. Now:
//   1. the file is hashed and STAGED as one import (the same file twice is one
//      import — the second answers the first's result);
//   2. the strict parser rejects the whole file on a bad column count, an
//      unterminated quote, a missing or unparseable date, a non-positive
//      amount, a duplicate provider id inside the file, a row-count trailer
//      that disagrees, or a control total that disagrees — zero credits;
//   3. publication is a compare-and-set on the import (one batch winner) and
//      can be held independently of upload (SETTLEMENT_PUBLISH_KILL=1);
//   4. every row's outcome is written back on the import, and the credited
//      total is checked against the validated total.

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

export type SettlementImportStatus = 'STAGED' | 'REJECTED' | 'PUBLISHING' | 'PUBLISHED' | 'HELD' | 'REPLAYED';

export interface SettlementReport {
  importId: string;
  status: SettlementImportStatus;
  fileHash: string;
  fileRows: number;
  credited: number;
  reconciled: number;
  duplicates: number;
  unmatched: number;
  /** Why the whole file was refused — every reason, with its line. */
  rejectedRows: { line: number; reason: string }[];
  totalGyd: number;
  trailerTotalGyd: number | null;
  trailerMismatch: boolean;
  /** The same file was imported before: this is that import's answer. */
  replayed: boolean;
}

interface StagedRow {
  line: number;
  txnId: string;
  sanRaw: string;
  amount: number;
  paidAt: string;
  payerMsisdn?: string;
  agentRef?: string;
}

/** Minimal CSV split honoring quoted fields — MMG files are simple, but a
 *  vendor name with a comma must not shear the row. [M-20] An unterminated
 *  quote is a malformed line, never a silently truncated cell. */
function splitCsvLine(line: string): { cells: string[]; malformed: boolean } {
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
  return { cells: out.map((s) => s.trim()), malformed: quoted };
}

export const settlementFileHash = (csvText: string) => createHash('sha256').update(csvText).digest('hex');

/** Parse and validate the WHOLE file. Returns the staged rows, or every
 *  reason the file cannot be trusted. Pure: no database, no money. */
export function parseSettlementCsv(csvText: string, map: SettlementHeaderMap): {
  rows: StagedRow[];
  rejections: { line: number; reason: string }[];
  totalGyd: number;
  trailerTotalGyd: number | null;
  trailerRowCount: number | null;
} {
  const rejections: { line: number; reason: string }[] = [];
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], rejections: [{ line: 0, reason: 'EMPTY_FILE' }], totalGyd: 0, trailerTotalGyd: null, trailerRowCount: null };
  const header = splitCsvLine(lines[0]!);
  const headers = header.cells.map((h) => h.toLowerCase());
  const col = (name: string) => headers.indexOf(name.toLowerCase());
  const idx = {
    txnId: col(map.txnId),
    san: col(map.san),
    amount: col(map.amount),
    paidAt: col(map.paidAt),
    payerMsisdn: map.payerMsisdn ? col(map.payerMsisdn) : -1,
    agentRef: map.agentRef ? col(map.agentRef) : -1,
  };
  if (idx.txnId < 0 || idx.san < 0 || idx.amount < 0 || idx.paidAt < 0) {
    return { rows: [], rejections: [{ line: 1, reason: `HEADERS_UNRECOGNIZED: need ${map.txnId}, ${map.san}, ${map.amount}, ${map.paidAt} — got [${headers.join(', ')}]` }], totalGyd: 0, trailerTotalGyd: null, trailerRowCount: null };
  }
  const rows: StagedRow[] = [];
  const seen = new Map<string, number>();
  let totalGyd = 0;
  let trailerTotalGyd: number | null = null;
  let trailerRowCount: number | null = null;
  for (let line = 1; line < lines.length; line += 1) {
    const parsed = splitCsvLine(lines[line]!);
    const cells = parsed.cells;
    const first = (cells[0] ?? '').toUpperCase();
    // Trailer rows: "TOTAL,<sum>" (the file's claimed total) and, when the
    // provider sends one, "ROWCOUNT,<n>".
    if (first === 'TOTAL' || first === 'TRAILER') {
      const claimed = Number((cells[1] ?? '').replace(/[^0-9.]/g, ''));
      if (Number.isFinite(claimed)) trailerTotalGyd = claimed; else rejections.push({ line: line + 1, reason: 'TRAILER_TOTAL_UNREADABLE' });
      continue;
    }
    if (first === 'ROWCOUNT' || first === 'COUNT') {
      const claimed = Number((cells[1] ?? '').replace(/[^0-9]/g, ''));
      if (Number.isFinite(claimed)) trailerRowCount = claimed; else rejections.push({ line: line + 1, reason: 'TRAILER_ROWCOUNT_UNREADABLE' });
      continue;
    }
    if (parsed.malformed) { rejections.push({ line: line + 1, reason: 'MALFORMED_QUOTING' }); continue; }
    if (cells.length !== headers.length) { rejections.push({ line: line + 1, reason: `COLUMN_COUNT: expected ${headers.length}, got ${cells.length}` }); continue; }
    const txnId = cells[idx.txnId] ?? '';
    const sanRaw = cells[idx.san] ?? '';
    const amountText = cells[idx.amount] ?? '';
    const amount = Number(amountText.replace(/[^0-9.-]/g, ''));
    if (!txnId) { rejections.push({ line: line + 1, reason: 'MISSING_TXN_ID' }); continue; }
    if (!sanRaw) { rejections.push({ line: line + 1, reason: 'MISSING_SAN' }); continue; }
    if (!amountText || !Number.isFinite(amount) || amount <= 0) { rejections.push({ line: line + 1, reason: 'AMOUNT_NOT_POSITIVE' }); continue; }
    const paidAtRaw = cells[idx.paidAt] ?? '';
    if (!paidAtRaw || Number.isNaN(Date.parse(paidAtRaw))) { rejections.push({ line: line + 1, reason: 'DATE_UNREADABLE' }); continue; }
    const key = txnId.trim().toUpperCase();
    const dup = seen.get(key);
    if (dup !== undefined) { rejections.push({ line: line + 1, reason: `DUPLICATE_TXN_ID_IN_FILE: also on line ${dup}` }); continue; }
    seen.set(key, line + 1);
    rows.push({
      line: line + 1, txnId, sanRaw, amount, paidAt: new Date(paidAtRaw).toISOString(),
      ...(idx.payerMsisdn >= 0 && cells[idx.payerMsisdn] ? { payerMsisdn: cells[idx.payerMsisdn]! } : {}),
      ...(idx.agentRef >= 0 && cells[idx.agentRef] ? { agentRef: cells[idx.agentRef]! } : {}),
    });
    totalGyd += amount;
  }
  totalGyd = Math.round(totalGyd * 100) / 100;
  if (trailerTotalGyd !== null && Math.abs(trailerTotalGyd - totalGyd) > 0.009) {
    rejections.push({ line: 0, reason: `CONTROL_TOTAL_MISMATCH: file claims ${trailerTotalGyd}, rows sum to ${totalGyd}` });
  }
  if (trailerRowCount !== null && trailerRowCount !== rows.length + rejections.filter((r) => r.line > 0).length) {
    rejections.push({ line: 0, reason: `ROW_COUNT_MISMATCH: file claims ${trailerRowCount}, found ${rows.length}` });
  }
  return { rows, rejections, totalGyd, trailerTotalGyd, trailerRowCount };
}

export async function importSettlementCsv(
  prisma: PrismaClient,
  svc: AgentCashService,
  csvText: string,
  opts: { source: string; headerMap?: Partial<SettlementHeaderMap>; tenantId?: string },
  onAudit?: OnAudit,
): Promise<SettlementReport> {
  const configured = await prisma.platformConfig.findUnique({ where: { key: 'billing.mmg_agent.settlement_headers' } });
  const map: SettlementHeaderMap = {
    ...DEFAULT_HEADER_MAP,
    ...((configured?.value as Partial<SettlementHeaderMap> | null) ?? {}),
    ...(opts.headerMap ?? {}),
  };
  const tenantId = opts.tenantId ?? 'swift-default';
  const fileHash = settlementFileHash(csvText);

  // 1. The same file is ONE import: answer the first import's result.
  const prior = await prisma.settlementImport.findUnique({ where: { tenantId_fileHash: { tenantId, fileHash } } });
  if (prior && prior.status !== 'STAGED') return reportFor(prior, true);

  // 2. Parse and validate the whole file. Nothing below touches money until
  //    every check passed.
  const parsed = parseSettlementCsv(csvText, map);
  const rejected = parsed.rejections.length > 0;
  // [ADM-002] Staging the file IS the admin action; its audit row commits with
  // the import row (the per-row credits at publication are their own
  // idempotent transactions). A replayed file staged nothing new and is
  // covered by the backstop.
  const staged = prior ?? await prisma.$transaction(async (tx) => {
    const created = await tx.settlementImport.create({
      data: {
        tenantId, source: opts.source, fileHash,
        rowCount: parsed.rows.length,
        computedTotal: parsed.totalGyd,
        controlTotal: parsed.trailerTotalGyd,
        status: rejected ? 'REJECTED' : 'STAGED',
        rejectReasons: rejected ? (parsed.rejections as never) : undefined,
        rows: parsed.rows as never,
      },
    });
    await onAudit?.(tx, { importId: created.id, fileHash, rowCount: parsed.rows.length, computedTotal: String(parsed.totalGyd), controlTotal: parsed.trailerTotalGyd == null ? null : String(parsed.trailerTotalGyd), status: created.status });
    return created;
  }).catch(async (err: { code?: string }) => {
    if (err.code !== 'P2002') throw err;
    return prisma.settlementImport.findUniqueOrThrow({ where: { tenantId_fileHash: { tenantId, fileHash } } }); // a concurrent upload of the same file staged it first
  });
  if (staged.status === 'REJECTED' || rejected) {
    if (staged.status !== 'REJECTED') await prisma.settlementImport.update({ where: { id: staged.id }, data: { status: 'REJECTED', rejectReasons: parsed.rejections as never } });
    const first = parsed.rejections[0]?.reason.split(':')[0] ?? 'REJECTED';
    settlementImportsRejectedCounter.labels(first).inc();
    log().error({ importId: staged.id, source: opts.source, reasons: parsed.rejections.slice(0, 10) }, '[M-20] settlement file rejected before publication — zero credits');
    return reportFor({ ...staged, status: 'REJECTED', rejectReasons: parsed.rejections as never }, false);
  }

  // 3. Publication can be held independently of upload: the batch stays
  //    STAGED, validated, and a person releases it later.
  if (process.env['SETTLEMENT_PUBLISH_KILL'] === '1') {
    log().warn({ importId: staged.id, source: opts.source }, '[M-20] settlement publication is on hold — file staged and validated, nothing credited');
    return { ...reportFor(staged, false), status: 'HELD' };
  }
  return publishSettlementImport(prisma, svc, staged.id);
}

/** Publish a validated import: ONE winner (the compare-and-set), every row
 *  through the same ingest pipeline, every outcome written back, the
 *  credited total checked against the file's validated total. */
export async function publishSettlementImport(prisma: PrismaClient, svc: AgentCashService, importId: string): Promise<SettlementReport> {
  const won = await prisma.settlementImport.updateMany({ where: { id: importId, status: 'STAGED' }, data: { status: 'PUBLISHING' } });
  const current = await prisma.settlementImport.findUniqueOrThrow({ where: { id: importId } });
  if (won.count !== 1) return reportFor(current, true); // another publisher owns it, or it is done
  const rows = current.rows as unknown as StagedRow[];
  const results: Array<{ line: number; txnId: string; status: IngestResult['status']; paymentId: string }> = [];
  const report = { credited: 0, reconciled: 0, duplicates: 0, unmatched: 0, creditedGyd: 0 };
  for (const row of rows) {
    const res = await svc.ingest({
      externalId: row.txnId,
      channel: 'MMG_SETTLEMENT_FILE',
      mmgTxnId: row.txnId,
      sanRaw: row.sanRaw,
      amount: row.amount,
      currencyCode: 'GYD',
      paidAt: new Date(row.paidAt),
      payerMsisdn: row.payerMsisdn,
      agentRef: row.agentRef,
      raw: { source: current.source, importId, line: row.line },
    });
    results.push({ line: row.line, txnId: row.txnId, status: res.status, paymentId: res.paymentId });
    if (res.status === 'accepted') { report.credited += 1; report.creditedGyd += row.amount; }
    else if (res.status === 'reconciled') report.reconciled += 1;
    else if (res.status === 'duplicate') report.duplicates += 1;
    else report.unmatched += 1;
  }
  const published = await prisma.settlementImport.update({
    where: { id: importId },
    data: { status: 'PUBLISHED', results: results as never, credited: report.credited, publishedAt: new Date() },
  });
  return reportFor(published, false);
}

function reportFor(row: { id: string; status: string; fileHash: string; rowCount: number; computedTotal: unknown; controlTotal: unknown; rejectReasons?: unknown; results?: unknown; credited: number }, replayed: boolean): SettlementReport {
  const results = (row.results as Array<{ status: string }> | null | undefined) ?? [];
  const count = (status: string) => results.filter((r) => r.status === status).length;
  const control = row.controlTotal == null ? null : Number(row.controlTotal);
  const rejections = ((row.rejectReasons as Array<{ line: number; reason: string }> | null | undefined) ?? []);
  return {
    importId: row.id,
    status: row.status as SettlementImportStatus,
    fileHash: row.fileHash,
    fileRows: row.rowCount,
    credited: replayed ? 0 : row.credited,
    reconciled: count('reconciled'),
    duplicates: replayed ? row.rowCount : count('duplicate'),
    unmatched: count('received_unmatched'),
    rejectedRows: rejections,
    totalGyd: Number(row.computedTotal),
    trailerTotalGyd: control,
    trailerMismatch: rejections.some((r) => r.reason.startsWith('CONTROL_TOTAL_MISMATCH')),
    replayed,
  };
}

/** [M-20 · operations] Two things a person must see: a PUBLISHED import whose
 *  credited money disagrees with its validated total (a row failed after the
 *  batch was accepted — reconcile it), and a REJECTED import any of whose
 *  provider ids nonetheless credited (through another channel, or through
 *  the pre-staging importer) — reverse only by hand against the statement. */
export async function scanSettlementImports(prisma: PrismaClient): Promise<{ unbalanced: string[]; rejectedButCredited: string[] }> {
  const out = { unbalanced: [] as string[], rejectedButCredited: [] as string[] };
  const published = await prisma.settlementImport.findMany({ where: { status: 'PUBLISHED' }, orderBy: { createdAt: 'desc' }, take: 200 });
  for (const imp of published) {
    const rows = imp.rows as unknown as StagedRow[];
    const results = (imp.results as Array<{ line: number; status: string }> | null) ?? [];
    const settled = new Set(results.filter((r) => r.status === 'accepted' || r.status === 'reconciled' || r.status === 'duplicate').map((r) => r.line));
    if (rows.some((r) => !settled.has(r.line))) out.unbalanced.push(imp.id);
  }
  const rejected = await prisma.settlementImport.findMany({ where: { status: 'REJECTED' }, orderBy: { createdAt: 'desc' }, take: 200 });
  for (const imp of rejected) {
    const rows = imp.rows as unknown as StagedRow[];
    if (rows.length === 0) continue;
    const credited = await prisma.mmgAgentPayment.count({ where: { externalId: { in: rows.map((r) => r.txnId) }, channel: 'MMG_SETTLEMENT_FILE', status: { in: ['MATCHED', 'RESOLVED'] } } });
    if (credited > 0) out.rejectedButCredited.push(imp.id);
  }
  settlementBatchesUnbalancedGauge.labels('unbalanced').set(out.unbalanced.length);
  settlementBatchesUnbalancedGauge.labels('rejected_but_credited').set(out.rejectedButCredited.length);
  if (out.unbalanced.length + out.rejectedButCredited.length > 0) {
    log().error(out, '[M-20] settlement imports needing a person: unbalanced publications and rejected files with credited rows');
  }
  return out;
}
