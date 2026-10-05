import type { OnAudit } from '../../lib/audit-writer';
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AgentCashService, IngestResult } from './agent-cash.service';
import { settlementImportsRejectedCounter, settlementBatchesUnbalancedGauge } from '../../plugins/observability';
import { bindTenantTransaction } from '../../plugins/prisma';
import { getTenantId, runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import { log } from '../../utils/logger';
import { publicationHeartbeatMs as heartbeatMs, publicationLeaseMs as leaseMs } from './settlement-publication-lease';

export { PUBLICATION_LEASE_MS } from './settlement-publication-lease';

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
//
// [G5-F6] PUBLICATION IS RESUMABLE. Before, a publication that died part-way
// (a dropped connection, a restart mid-file) stayed PUBLISHING for ever: the
// same file again answered "replayed, every row a duplicate" while a row was
// never credited, nothing else ever called the publisher, and the scan read
// only PUBLISHED and REJECTED imports. Now:
//   5. a publisher that fails part-way marks its import INTERRUPTED; one that
//      dies without a word (a killed process) leaves it PUBLISHING with a
//      heartbeat that stops. Either is resumed by ONE winner, a compare-and-set
//      on the import as it was read: by importing the same file again (two
//      people, like any upload), or by the repair pass of poll-mmg-billing. A
//      live publisher is never taken over, and the hold stops a resume too;
//   6. a resume runs every row again through the SAME ingest, whose
//      (channel, externalId) replay guard credits a row at most once. The rows
//      the import had already observed are its own outcomes and count as
//      such; an observation persisted but never judged (the process died
//      inside the ingest) is finished, never written off as a duplicate;
//   7. [AX314] ownership is FENCED: the import updatedAt, written in database
//      time, is its owner token. A takeover moves it strictly forward, and
//      every row credit transaction compares-and-sets it before COMMIT, as
//      does every heartbeat, INTERRUPTED and PUBLISHED write. A publisher
//      that lost the lease stops cleanly and marks nothing;
//   8. a lease is judged on the DATABASE clock only: no app server clock can
//      authorise a takeover or delay a recovery. [AX337] Every lease write
//      reads that clock INSIDE the one guarded statement that judges and
//      stamps it, never in an earlier one, so a publisher paused in between
//      cannot stamp an old heartbeat; one whose lease lapsed is refused;
//   9. the repair pass is FAIR: least recently attempted first, and an import
//      whose attempt just failed waits out a backoff, so imports that fail
//      every time cannot starve the rest.

// [G5-F6 · AX337 · AX352] The lease (5 min) and the heartbeat (15 s, timed on
// the publisher's own monotonic clock; the lease itself is database time) live
// in settlement-publication-lease.ts, with SETTLEMENT_PUBLICATION_LEASE_MS: a
// TEST AND DRILL override that production refuses at boot below the default.
/** [AX314-F3] The repair pass leaves an import whose attempt just failed alone
 *  this long, and always tries the least recently attempted first. */
export const PUBLICATION_RETRY_BACKOFF_MS = 5 * 60_000;

const publicationHeld = () => process.env['SETTLEMENT_PUBLISH_KILL'] === '1';

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

export type SettlementImportStatus = 'STAGED' | 'REJECTED' | 'PUBLISHING' | 'INTERRUPTED' | 'PUBLISHED' | 'HELD' | 'REPLAYED';

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
  return { cells: out, malformed: quoted };
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
  const headers = header.cells.map((h) => h.trim().toLowerCase());
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
    const cells = parsed.cells.map((s) => s.trim());
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
    // Keep the provider's raw spelling. Only SQL decides its equivalence to
    // another reference; the parser's exact duplicate check is a safe subset.
    const txnId = parsed.cells[idx.txnId] ?? '';
    const sanRaw = cells[idx.san] ?? '';
    const amountText = cells[idx.amount] ?? '';
    const amount = Number(amountText.replace(/[^0-9.-]/g, ''));
    if (!txnId.trim()) { rejections.push({ line: line + 1, reason: 'MISSING_TXN_ID' }); continue; }
    if (!sanRaw) { rejections.push({ line: line + 1, reason: 'MISSING_SAN' }); continue; }
    if (!amountText || !Number.isFinite(amount) || amount <= 0) { rejections.push({ line: line + 1, reason: 'AMOUNT_NOT_POSITIVE' }); continue; }
    const paidAtRaw = cells[idx.paidAt] ?? '';
    if (!paidAtRaw || Number.isNaN(Date.parse(paidAtRaw))) { rejections.push({ line: line + 1, reason: 'DATE_UNREADABLE' }); continue; }
    const key = txnId;
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
  //    [G5-F6] Unless its publication stopped part-way: then this upload
  //    finishes it. publishSettlementImport takes over only an INTERRUPTED
  //    import or one whose publisher went silent; a live one is answered.
  const prior = await prisma.settlementImport.findUnique({ where: { tenantId_fileHash: { tenantId, fileHash } } });
  if (prior && (prior.status === 'INTERRUPTED' || prior.status === 'PUBLISHING')) {
    if (publicationHeld()) {
      log().warn({ importId: prior.id, source: opts.source }, '[G5-F6] settlement publication is on hold — the unfinished import waits, nothing credited');
      return { ...reportFor(prior, true), status: 'HELD' };
    }
    return publishSettlementImport(prisma, svc, prior.id, onAudit);
  }
  if (prior && prior.status !== 'STAGED') return reportFor(prior, true);

  // 2. Parse and validate the whole file. Nothing below touches money until
  //    every check passed.
  const parsed = parseSettlementCsv(csvText, map);
  // [SX394] The file and the shared minter use exactly the same identity
  // relation. One batch query, before staging/publication; never JS case fold.
  const duplicateLines = await prisma.$queryRaw<Array<{ line: number; firstLine: number }>>`
    SELECT line, "firstLine" FROM (
      SELECT line, min(line) OVER (PARTITION BY mmg_txn_canon("txnId")) AS "firstLine"
      FROM jsonb_to_recordset(${JSON.stringify(parsed.rows)}::jsonb) AS row(line integer, "txnId" text)
    ) ranked WHERE line <> "firstLine" ORDER BY line`;
  for (const duplicate of duplicateLines) parsed.rejections.push({ line: duplicate.line, reason: `DUPLICATE_TXN_ID_IN_FILE: also on line ${duplicate.firstLine}` });
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
  if (publicationHeld()) {
    log().warn({ importId: staged.id, source: opts.source }, '[M-20] settlement publication is on hold — file staged and validated, nothing credited');
    return { ...reportFor(staged, false), status: 'HELD' };
  }
  return publishSettlementImport(prisma, svc, staged.id);
}

type RowResult = { line: number; txnId: string; status: IngestResult['status']; paymentId: string };

/** [AX314-F1] The ownership of one publication. The token is the import's
 *  updatedAt as its owner last wrote it, in database time; a takeover moves
 *  it strictly forward, so every write fenced on it fails for a publisher
 *  that has lost the lease. */
interface PublicationLease { importId: string; token: Date }

/** Thrown inside a row's credit transaction (rolling the credit back), or by
 *  a fenced write: this publisher no longer owns the import. */
class PublicationLeaseLost extends Error {
  constructor(importId: string) {
    super(`SETTLEMENT_PUBLICATION_LEASE_LOST: ${importId}`);
    this.name = 'PublicationLeaseLost';
  }
}

/** [AX314-F2] The ONE clock of the lease is the database clock: never an app
 *  server clock, which may run minutes ahead or behind. [AX337-F2] A lease
 *  WRITE reads it inside its own guarded statement (`DB_NOW`): a time sampled
 *  in one statement and written in a later one can be stale by the time it
 *  lands. `clock_timestamp()`, not `now()`, because inside a transaction now()
 *  is the time the transaction began. `updatedAt` is a timestamp(3) holding
 *  UTC, as Prisma writes it, so the clock is read as UTC in any session time
 *  zone. The repair pass and the scan only READ with `databaseNow`: the
 *  takeover's own statement decides. */
const DB_NOW = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;
const LEASE = () => Prisma.sql`(${leaseMs()} * interval '1 millisecond')`;
/** A JS instant as the UTC wall time the column holds. */
const asColumn = (at: Date) => Prisma.sql`(${at}::timestamptz AT TIME ZONE 'UTC')`;
async function databaseNow(db: Pick<PrismaClient, '$queryRaw'>): Promise<Date> {
  const [row] = await db.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
  return row!.now;
}

/** [AX337-F2 · TEN-03] One guarded statement on the import row, inside `tx`,
 *  bound to the tenant in context as a model query is (a raw statement
 *  bypasses the query extension, so it binds and scopes itself), answering
 *  the token it wrote: the new updatedAt. Null: the guard refused. */
type GuardedStatement = (tenantOnly: Prisma.Sql) => Prisma.Sql;
async function guardedImportWriteIn(tx: Prisma.TransactionClient, statement: GuardedStatement): Promise<Date | null> {
  const tenantId = getTenantId();
  await bindTenantTransaction(tx);
  const [row] = await tx.$queryRaw<Array<{ token: Date }>>(statement(tenantId ? Prisma.sql`AND "tenantId" = ${tenantId}` : Prisma.empty));
  return row?.token ?? null;
}
const guardedImportWrite = (prisma: PrismaClient, statement: GuardedStatement) =>
  prisma.$transaction((tx) => guardedImportWriteIn(tx, statement));

/** A write to the import that lands only while `lease` still owns it and the
 *  lease is alive, judged on the database clock in the same statement, and
 *  that renews the lease with a token strictly after the one it replaces.
 *  With `close`, it also writes the outcome: INTERRUPTED with the rows that
 *  landed, or PUBLISHED. False: the lease is gone (taken over, or lapsed). */
async function writeWhileOwned(prisma: PrismaClient, lease: PublicationLease, close?: { status: 'INTERRUPTED' | 'PUBLISHED'; results: RowResult[] }): Promise<boolean> {
  const outcome = close
    ? Prisma.sql`, "status" = ${close.status}, "results" = ${JSON.stringify(close.results)}::jsonb, "credited" = ${creditedIn(close.results)}${close.status === 'PUBLISHED' ? Prisma.sql`, "publishedAt" = ${DB_NOW}` : Prisma.empty}`
    : Prisma.empty;
  const token = await guardedImportWrite(prisma, (tenantOnly) => Prisma.sql`
    UPDATE "settlement_imports"
       SET "updatedAt" = GREATEST(${DB_NOW}, ${asColumn(lease.token)} + interval '1 millisecond')${outcome}
     WHERE "id" = ${lease.importId} ${tenantOnly}
       AND "status" = 'PUBLISHING' AND "updatedAt" = ${asColumn(lease.token)}
       AND "updatedAt" >= ${DB_NOW} - ${LEASE()}
    RETURNING "updatedAt" AS "token"`);
  if (!token) return false;
  lease.token = token;
  return true;
}

/** Publish a validated import: ONE winner (the compare-and-set), every row
 *  through the same ingest pipeline, every outcome written back, the
 *  credited total checked against the validated total of the file.
 *
 *  [G5-F6] The same call resumes a publication that stopped part-way, again
 *  by one winner; a person who resumes it is audited with the takeover.
 *  [AX314-F1] The publisher owns the import through a fenced lease, and stops
 *  cleanly the moment it has lost it. */
export async function publishSettlementImport(prisma: PrismaClient, svc: AgentCashService, importId: string, onAudit?: OnAudit): Promise<SettlementReport> {
  const lease = await claimPublication(prisma, importId, onAudit);
  const current = await prisma.settlementImport.findUniqueOrThrow({ where: { id: importId } });
  if (!lease) return reportFor(current, true); // another publisher owns it, or it is done
  const rows = current.rows as unknown as StagedRow[];
  const results: RowResult[] = [];
  // [AX314-F1] A row credit commits only while this publisher still owns
  // the import. The last statement of the credit transaction (its onAudit
  // hook runs inside it) is a same-value compare-and-set on the token, which
  // holds the import row lock until COMMIT: a takeover either lands first
  // (the fence fails, the credit rolls back) or waits for the credit to
  // commit under the old owner. The two never interleave.
  const fence: OnAudit = async (tx) => {
    const held = await (tx as unknown as Prisma.TransactionClient).settlementImport.updateMany({
      where: { id: importId, status: 'PUBLISHING', updatedAt: lease.token },
      data: { updatedAt: lease.token },
    });
    if (held.count !== 1) throw new PublicationLeaseLost(importId);
  };
  let lastBeat = performance.now();
  try {
    for (const row of rows) {
      results.push(await publishRow(prisma, svc, current, row, fence));
      if (performance.now() - lastBeat >= heartbeatMs()) {
        // [AX337-F2] Refused once the lease has lapsed, even if nobody has
        // taken the import over yet: a publisher that woke up late stops.
        if (!(await writeWhileOwned(prisma, lease))) throw new PublicationLeaseLost(importId);
        lastBeat = performance.now();
      }
    }
  } catch (err) {
    // [AX314-F1] A publisher that lost the lease stops here, cleanly: the
    // import belongs to another publisher now, and nothing this one could write about it
    // would be true. Only the owner says INTERRUPTED, with the rows that
    // landed, so the next upload of the file or the repair pass resumes it.
    // If even that write fails (the database is gone), the lease lapses.
    const owned = err instanceof PublicationLeaseLost
      ? false
      : await writeWhileOwned(prisma, lease, { status: 'INTERRUPTED', results }).catch(() => null);
    if (owned === false) {
      log().warn({ importId, landed: results.length }, '[G5-F6] settlement publisher lost its lease part-way — stopped; the owner finishes the file');
      return reportFor(await prisma.settlementImport.findUniqueOrThrow({ where: { id: importId } }), true);
    }
    log().error({ err, importId, source: current.source, landed: results.length, rows: rows.length }, '[G5-F6] settlement publication interrupted part-way — resumable, no row credits twice');
    throw err;
  }
  // Only the owner that ran every row closes the import.
  const closed = await writeWhileOwned(prisma, lease, { status: 'PUBLISHED', results });
  const published = await prisma.settlementImport.findUniqueOrThrow({ where: { id: importId } });
  return reportFor(published, !closed);
}

const creditedIn = (results: RowResult[]) => results.filter((r) => r.status === 'accepted').length;

/** [G5-F6] INTERRUPTED said so; PUBLISHING silent past the lease died without
 *  a word. Either may be taken over. As a query for the repair pass and the
 *  scan, which only READ: the takeover's own statement decides [AX337-F2].
 *  [AX314-F3] With a backoff, an import stays out of it for that long after
 *  its last attempt stopped. */
const stoppedPublicationWhere = (now: Date, retryBackoffMs = 0) => ({
  OR: [
    { status: 'INTERRUPTED', ...(retryBackoffMs > 0 ? { updatedAt: { lt: new Date(now.getTime() - retryBackoffMs) } } : {}) },
    { status: 'PUBLISHING', updatedAt: { lt: new Date(now.getTime() - leaseMs()) } },
  ],
});

/** ONE publisher at a time. A STAGED import is claimed fresh. [G5-F6] A
 *  stopped one is taken over by a compare-and-set on the exact version read,
 *  so of two resumers one runs and the other is answered; a live publisher
 *  is never taken over. [AX314] The takeover moves the token strictly
 *  forward: the old owner is fenced out of every later write. [AX337-F2]
 *  Each claim is judged and stamped in ONE statement on the database clock,
 *  and the token is what that statement wrote. */
async function claimPublication(prisma: PrismaClient, importId: string, onAudit?: OnAudit): Promise<PublicationLease | null> {
  const fresh = await guardedImportWrite(prisma, (tenantOnly) => Prisma.sql`
    UPDATE "settlement_imports" SET "status" = 'PUBLISHING', "updatedAt" = ${DB_NOW}
     WHERE "id" = ${importId} ${tenantOnly} AND "status" = 'STAGED'
    RETURNING "updatedAt" AS "token"`);
  if (fresh) return { importId, token: fresh };
  const seen = await prisma.settlementImport.findUnique({ where: { id: importId }, select: { status: true, updatedAt: true, fileHash: true } });
  if (!seen || (seen.status !== 'INTERRUPTED' && seen.status !== 'PUBLISHING')) return null;
  return prisma.$transaction(async (tx) => {
    // INTERRUPTED may be taken over at once; PUBLISHING only once its lease
    // has lapsed on the database clock, judged in this statement.
    const token = await guardedImportWriteIn(tx, (tenantOnly) => Prisma.sql`
      UPDATE "settlement_imports"
         SET "status" = 'PUBLISHING', "updatedAt" = GREATEST(${DB_NOW}, "updatedAt" + interval '1 millisecond')
       WHERE "id" = ${importId} ${tenantOnly}
         AND "status" = ${seen.status} AND "updatedAt" = ${asColumn(seen.updatedAt)}
         AND ("status" = 'INTERRUPTED' OR "updatedAt" < ${DB_NOW} - ${LEASE()})
      RETURNING "updatedAt" AS "token"`);
    if (!token) return null; // live, or another resumer took it first
    // [ADM-002] A person resuming the file is the admin action: its audit row
    // commits with the takeover and names the import.
    await onAudit?.(tx, { importId, fileHash: seen.fileHash, status: 'RESUMED', resumedFrom: seen.status });
    log().warn({ importId, resumedFrom: seen.status, lastHeartbeat: seen.updatedAt }, '[G5-F6] resuming a settlement publication that stopped part-way');
    return { importId, token };
  });
}

/** One row through the one ingest pipeline, its credit fenced on the lease.
 *  [G5-F6] On a resume the replay guard answers `duplicate` for every row
 *  this import observed before: those are its OWN outcomes (the observation
 *  names the import) and are reported as what they were, and one persisted
 *  but never judged is finished now. A duplicate of another import or
 *  channel stays one. */
async function publishRow(prisma: PrismaClient, svc: AgentCashService, imp: { id: string; source: string }, row: StagedRow, fence: OnAudit): Promise<RowResult> {
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
    raw: { source: imp.source, importId: imp.id, line: row.line },
  }, fence);
  const outcome = (status: IngestResult['status']): RowResult => ({ line: row.line, txnId: row.txnId, status, paymentId: res.paymentId });
  if (res.status !== 'duplicate') return outcome(res.status);
  const seen = await prisma.mmgAgentPayment.findUnique({ where: { id: res.paymentId }, select: { status: true, raw: true } });
  if (!seen || (seen.raw as { importId?: unknown } | null)?.importId !== imp.id) return outcome('duplicate');
  switch (seen.status) {
    case 'RECEIVED': return outcome((await svc.resumeReceived(res.paymentId, fence)).status);
    case 'MATCHED': return outcome('accepted');
    case 'RECONCILED': return outcome('reconciled');
    default: return outcome('received_unmatched'); // UNMATCHED, or RESOLVED since by a person
  }
}

function reportFor(row: { id: string; status: string; fileHash: string; rowCount: number; computedTotal: unknown; controlTotal: unknown; rejectReasons?: unknown; results?: unknown; credited: number }, replayed: boolean): SettlementReport {
  const results = (row.results as Array<{ status: string }> | null | undefined) ?? [];
  const count = (status: string) => results.filter((r) => r.status === status).length;
  const control = row.controlTotal == null ? null : Number(row.controlTotal);
  const rejections = ((row.rejectReasons as Array<{ line: number; reason: string }> | null | undefined) ?? []);
  // [G5-F6] A replay of an unfinished publication moved nothing, and none of
  // its rows is a duplicate of anything yet; only a finished import can say so.
  const finished = row.status === 'PUBLISHED' || row.status === 'REJECTED';
  return {
    importId: row.id,
    status: row.status as SettlementImportStatus,
    fileHash: row.fileHash,
    fileRows: row.rowCount,
    credited: replayed ? 0 : row.credited,
    reconciled: count('reconciled'),
    duplicates: replayed ? (finished ? row.rowCount : 0) : count('duplicate'),
    unmatched: count('received_unmatched'),
    rejectedRows: rejections,
    totalGyd: Number(row.computedTotal),
    trailerTotalGyd: control,
    trailerMismatch: rejections.some((r) => r.reason.startsWith('CONTROL_TOTAL_MISMATCH')),
    replayed,
  };
}

/** [G5-F6 · operations] The repair pass (poll-mmg-billing, every two minutes)
 *  resumes every publication that stopped part-way, one winner each. The
 *  file was validated whole and approved by two people before a row moved;
 *  finishing it is that approved act, each row still credits at most once,
 *  and the hold stops it like any publication. `importIds` narrows the pass
 *  (tests); the scan below names what the pass could not finish. */
export async function resumeInterruptedSettlementImports(
  prisma: PrismaClient,
  svc: AgentCashService,
  opts: { importIds?: string[]; limit?: number } = {},
): Promise<{ resumed: string[]; failed: string[] }> {
  const out = { resumed: [] as string[], failed: [] as string[] };
  if (publicationHeld()) return out;
  // [AX314-F3] Fair traversal: the least recently attempted first, and an
  // import whose last attempt failed waits out the backoff. Imports that fail
  // every time cannot hold every batch and starve the rest.
  const due = await runAsSystem('settlement-import-resume', async () => prisma.settlementImport.findMany({
    where: { ...stoppedPublicationWhere(await databaseNow(prisma), PUBLICATION_RETRY_BACKOFF_MS), ...(opts.importIds ? { id: { in: opts.importIds } } : {}) },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: Math.max(1, opts.limit ?? 20),
    select: { id: true, tenantId: true },
  }));
  for (const imp of due) {
    try {
      // Inside the tenant of the import, as its first publication ran.
      const report = await runWithTenant(imp.tenantId, () => publishSettlementImport(prisma, svc, imp.id));
      if (!report.replayed) out.resumed.push(imp.id);
    } catch (err) {
      out.failed.push(imp.id);
      log().error({ err, importId: imp.id }, '[G5-F6] resuming a settlement publication failed — it stays resumable');
    }
  }
  return out;
}

/** [M-20 · operations] Three things a person must see: a PUBLISHED import
 *  whose credited money disagrees with its validated total (a row failed after
 *  the batch was accepted — reconcile it), a REJECTED import any of whose
 *  provider ids nonetheless credited (through another channel, or through
 *  the pre-staging importer) — reverse only by hand against the statement —
 *  and [G5-F6] a publication still stopped part-way after the repair pass
 *  (the hold is on, or its resume keeps failing). */
export async function scanSettlementImports(prisma: PrismaClient): Promise<{ unbalanced: string[]; rejectedButCredited: string[]; stuck: string[] }> {
  const out = { unbalanced: [] as string[], rejectedButCredited: [] as string[], stuck: [] as string[] };
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
  const stuck = await prisma.settlementImport.findMany({ where: stoppedPublicationWhere(await databaseNow(prisma)), orderBy: { createdAt: 'desc' }, take: 200, select: { id: true } });
  out.stuck = stuck.map((s) => s.id);
  settlementBatchesUnbalancedGauge.labels('unbalanced').set(out.unbalanced.length);
  settlementBatchesUnbalancedGauge.labels('rejected_but_credited').set(out.rejectedButCredited.length);
  settlementBatchesUnbalancedGauge.labels('stuck_publication').set(out.stuck.length);
  if (out.unbalanced.length + out.rejectedButCredited.length + out.stuck.length > 0) {
    log().error(out, '[M-20] settlement imports needing a person: unbalanced publications, rejected files with credited rows, and publications stopped part-way');
  }
  return out;
}
