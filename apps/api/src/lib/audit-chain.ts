/**
 * [DOC-1 §20.1 · P20-1] The tamper-evident audit chain — DOC-INV-35.
 *
 * Swift cannot rely on the ECT Act's secure-record presumption (§17.1), so
 * integrity is demonstrable from Swift's own evidence: every audit-bearing
 * write — an admin audit row, a review decision, a deletion receipt — is
 * chained BY THE DATABASE (AFTER INSERT triggers) into one append-only
 * sequence. Each entry carries a digest of the event body — never the body,
 * so the chain is not a second copy of the PII — and
 *   entry_hash = sha256(prev_hash || seq || occurred_at || payload_digest).
 * Appends are serialised by an advisory lock so prev_hash is never stale;
 * UPDATE, DELETE and TRUNCATE are refused by trigger. An hourly verifier
 * walks the chain and recomputes every link — a chain nobody verifies is
 * decoration — and a daily anchor writes the head hash to its own
 * append-only table and tells the admins (the external anchor under
 * different credentials is an infrastructure item, recorded as such).
 *
 * This file is the source of truth for the DDL; the migration mirrors it and
 * the suites install it, so a mutation here is what the tests grade.
 */
import crypto from 'node:crypto';
import type { AuditChainEntry, PrismaClient } from '@prisma/client';
import { log } from '../utils/logger';
import { auditChainGauge } from '../plugins/observability';
import { notifyAdmins, type NotificationService } from '../modules/notification/notification.service';

export const AUDIT_CHAIN_GENESIS: Buffer = Buffer.alloc(32, 0);
/** Advisory key serialising appends (transaction-scoped). */
export const AUDIT_CHAIN_LOCK_KEY = 7_741_990_020;
/** How occurred_at enters the hash — identical in SQL (to_char) and here (toISOString): millisecond UTC. */
export const AUDIT_CHAIN_TIME_FORMAT_SQL = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export function entryHashOf(prevHash: Uint8Array, seq: bigint, occurredAt: Date, payloadDigest: Uint8Array): Buffer {
  return crypto.createHash('sha256')
    .update(Buffer.from(prevHash))
    .update(Buffer.from(String(seq), 'utf8'))
    .update(Buffer.from(occurredAt.toISOString(), 'utf8'))
    .update(Buffer.from(payloadDigest))
    .digest();
}

export function auditChainDdl(): string[] {
  const refuse = `CREATE OR REPLACE FUNCTION audit_chain_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_chain is append-only — % refused [DOC-INV-35]', TG_OP USING ERRCODE = 'restrict_violation';
      END $$ LANGUAGE plpgsql`;
  const append = `CREATE OR REPLACE FUNCTION audit_chain_append(p_actor_id text, p_actor_role text, p_event_type text, p_subject_ref text, p_submission_ref text, p_payload_digest bytea) RETURNS bigint AS $$
      DECLARE v_prev bytea; v_seq bigint; v_at timestamptz; v_entry bytea;
      BEGIN
        PERFORM pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY});
        SELECT "entryHash" INTO v_prev FROM audit_chain ORDER BY seq DESC LIMIT 1;
        IF v_prev IS NULL THEN v_prev := decode(repeat('00', 32), 'hex'); END IF;
        v_seq := nextval('audit_chain_seq_seq');
        v_at := date_trunc('milliseconds', clock_timestamp());
        v_entry := sha256(v_prev || convert_to(v_seq::text, 'UTF8') || convert_to(to_char(v_at AT TIME ZONE 'UTC', ${AUDIT_CHAIN_TIME_FORMAT_SQL}), 'UTF8') || p_payload_digest);
        INSERT INTO audit_chain (seq, "occurredAt", "actorId", "actorRole", "eventType", "subjectRef", "submissionRef", "payloadDigest", "prevHash", "entryHash")
        VALUES (v_seq, v_at, p_actor_id, p_actor_role, p_event_type, p_subject_ref, p_submission_ref, p_payload_digest, v_prev, v_entry);
        RETURN v_seq;
      END $$ LANGUAGE plpgsql`;
  const fromAuditLogs = `CREATE OR REPLACE FUNCTION audit_chain_from_audit_logs() RETURNS trigger AS $$
      BEGIN
        PERFORM audit_chain_append(
          NEW."userId",
          CASE WHEN NEW.action LIKE 'KYC_AUTO%' OR NEW.action = 'VERIFICATION_SUBMIT' THEN 'SYSTEM' ELSE 'ADMIN' END,
          NEW.action,
          NEW."entityId",
          CASE WHEN NEW.entity = 'VerificationDocument' THEN NEW."entityId" ELSE NULL END,
          sha256(convert_to(row_to_json(NEW)::text, 'UTF8')));
        RETURN NEW;
      END $$ LANGUAGE plpgsql`;
  const fromDecisions = `CREATE OR REPLACE FUNCTION audit_chain_from_review_decision() RETURNS trigger AS $$
      BEGIN
        PERFORM audit_chain_append(
          NEW."reviewerId", 'REVIEWER', 'REVIEW_DECISION_' || NEW.outcome::text, NULL,
          (SELECT "submissionId" FROM review_case WHERE id = NEW."caseId"),
          sha256(convert_to(row_to_json(NEW)::text, 'UTF8')));
        RETURN NEW;
      END $$ LANGUAGE plpgsql`;
  const fromReceipts = `CREATE OR REPLACE FUNCTION audit_chain_from_deletion_receipt() RETURNS trigger AS $$
      BEGIN
        PERFORM audit_chain_append(
          NEW."deletedBy", 'REAPER', 'DELETION_RECEIPT', NEW."subjectId", NEW."submissionId",
          sha256(convert_to(row_to_json(NEW)::text, 'UTF8')));
        RETURN NEW;
      END $$ LANGUAGE plpgsql`;
  return [
    refuse, append, fromAuditLogs, fromDecisions, fromReceipts,
    `DROP TRIGGER IF EXISTS audit_chain_no_mutation ON audit_chain`,
    `CREATE TRIGGER audit_chain_no_mutation BEFORE UPDATE OR DELETE ON audit_chain FOR EACH ROW EXECUTE FUNCTION audit_chain_append_only()`,
    `DROP TRIGGER IF EXISTS audit_chain_no_truncate ON audit_chain`,
    `CREATE TRIGGER audit_chain_no_truncate BEFORE TRUNCATE ON audit_chain FOR EACH STATEMENT EXECUTE FUNCTION audit_chain_append_only()`,
    `DROP TRIGGER IF EXISTS audit_chain_anchor_no_mutation ON audit_chain_anchor`,
    `CREATE TRIGGER audit_chain_anchor_no_mutation BEFORE UPDATE OR DELETE ON audit_chain_anchor FOR EACH ROW EXECUTE FUNCTION audit_chain_append_only()`,
    `DROP TRIGGER IF EXISTS audit_logs_to_chain ON audit_logs`,
    `CREATE TRIGGER audit_logs_to_chain AFTER INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_chain_from_audit_logs()`,
    `DROP TRIGGER IF EXISTS review_decision_to_chain ON review_decision`,
    `CREATE TRIGGER review_decision_to_chain AFTER INSERT ON review_decision FOR EACH ROW EXECUTE FUNCTION audit_chain_from_review_decision()`,
    `DROP TRIGGER IF EXISTS deletion_receipt_to_chain ON deletion_receipt`,
    `CREATE TRIGGER deletion_receipt_to_chain AFTER INSERT ON deletion_receipt FOR EACH ROW EXECUTE FUNCTION audit_chain_from_deletion_receipt()`,
  ];
}

export interface ChainVerdict {
  ok: boolean;
  entries: number;
  headSeq: bigint | null;
  headHash: Buffer | null;
  breakAt: bigint | null;
  reason: 'LINK' | 'HASH' | null;
}

/** Walk the whole chain in seq order, recomputing every link. */
export async function verifyAuditChain(prisma: PrismaClient, batch = 5000): Promise<ChainVerdict> {
  let prev: Buffer = AUDIT_CHAIN_GENESIS;
  let entries = 0;
  let headSeq: bigint | null = null;
  let cursor: bigint | null = null;
  for (;;) {
    const rows: AuditChainEntry[] = await prisma.auditChainEntry.findMany({
      where: cursor === null ? {} : { seq: { gt: cursor } }, orderBy: { seq: 'asc' }, take: batch,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!Buffer.from(row.prevHash).equals(prev)) return { ok: false, entries, headSeq, headHash: prev.equals(AUDIT_CHAIN_GENESIS) ? null : prev, breakAt: row.seq, reason: 'LINK' };
      const expected = entryHashOf(prev, row.seq, row.occurredAt, row.payloadDigest);
      if (!expected.equals(Buffer.from(row.entryHash))) return { ok: false, entries, headSeq, headHash: prev.equals(AUDIT_CHAIN_GENESIS) ? null : prev, breakAt: row.seq, reason: 'HASH' };
      prev = Buffer.from(row.entryHash);
      headSeq = row.seq;
      entries += 1;
    }
    cursor = rows[rows.length - 1]!.seq;
    if (rows.length < batch) break;
  }
  return { ok: true, entries, headSeq, headHash: headSeq === null ? null : prev, breakAt: null, reason: null };
}

/** Hourly: verify, publish the state, and on a break tell every admin of the platform tenant — loudly. */
export async function verifyAuditChainAndAlarm(prisma: PrismaClient, notifications: NotificationService): Promise<ChainVerdict> {
  const verdict = await verifyAuditChain(prisma);
  auditChainGauge.labels('ok').set(verdict.ok ? 1 : 0);
  auditChainGauge.labels('broken').set(verdict.ok ? 0 : 1);
  auditChainGauge.labels('entries').set(verdict.entries);
  if (!verdict.ok) {
    log().error({ breakAt: String(verdict.breakAt), reason: verdict.reason, verified: verdict.entries }, 'AUDIT CHAIN BROKEN — a record has been altered or removed [DOC-INV-35]');
    await notifyAdmins(prisma, notifications, {
      tenantId: 'swift-default',
      title: 'Audit chain broken',
      body: `The tamper-evident audit chain fails verification at entry ${String(verdict.breakAt)} (${verdict.reason}). A record was altered or removed. Treat as an incident.`,
      data: { kind: 'audit_chain_broken', breakAt: String(verdict.breakAt), reason: verdict.reason },
    });
  }
  return verdict;
}

/** Daily: write the head to its own append-only table and tell the admins — the digest a later reader can compare against. */
export async function anchorAuditChain(prisma: PrismaClient, notifications: NotificationService) {
  const verdict = await verifyAuditChain(prisma);
  if (verdict.headSeq === null || verdict.headHash === null) return null;
  const anchor = await prisma.auditChainAnchor.create({ data: { headSeq: verdict.headSeq, headHash: new Uint8Array(verdict.headHash), verified: verdict.ok } });
  await notifyAdmins(prisma, notifications, {
    tenantId: 'swift-default',
    title: 'Audit chain anchor',
    body: `Head ${String(verdict.headSeq)}: ${verdict.headHash.toString('hex').slice(0, 16)}… (${verdict.entries} entries, ${verdict.ok ? 'verified' : 'BROKEN'}). Keep this digest outside Swift.`,
    data: { kind: 'audit_chain_anchor', headSeq: String(verdict.headSeq), headHash: verdict.headHash.toString('hex'), verified: verdict.ok },
  });
  return anchor;
}
