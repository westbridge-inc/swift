import type { PrismaClient, SosStatus, IncidentStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import crypto from 'node:crypto';
import { log } from '../../utils/logger';
import { getKeyProvider, generateDek, encryptBuffer, decryptBuffer } from '../../providers/storage/envelope';

/**
 * [AG-XF-013] Erasure and a live emergency, at the same time.
 *
 * The deletion preflight gated on nonterminal Orders and ServiceJobs and
 * nothing else — measured on main, the whole of `account.service.ts` mentions
 * safety exactly twice, both inside one comment claiming that "case-bound
 * safety evidence lives elsewhere under its own hold rules". Half of that is
 * true: a SEALED evidence bundle holds snapshots, so its contents survive.
 * The half that is not true is the half that matters during an emergency:
 *
 *   • `emergencyContact` rows are deleted outright. They are the people the
 *     SOS fan-out already texted "someone you know triggered an emergency".
 *   • `fanOutResolved` re-reads those rows to send the all-clear. After the
 *     purge it finds zero contacts and returns silently — the people it
 *     alarmed are never told it ended.
 *   • The User row becomes "Deleted User" with phone `deleted:<id>`, and
 *     `SosAlert` carries no name or number of its own. The ops desk holding a
 *     LIVE alert can no longer identify or call the person it is about.
 *   • `livenessCheck` rows are deleted, and `EvidenceService` reads them LIVE
 *     at bundle-open — so a case opened after the deletion opens without the
 *     identity evidence, and nothing records that it ever existed.
 *
 * Neither extreme is acceptable. Refusing the deletion until the case closes
 * gives an abuser a reason to keep an account alive and a malicious reporter a
 * way to block someone's erasure forever. Deleting regardless abandons someone
 * mid-emergency. The spec's invariant is the third path, and it is the one
 * built here: a deletion request immediately ends commerce, sessions and
 * public exposure, but it cannot erase the minimum response authority needed
 * to resolve an active emergency or a lawful hold — and final erasure resumes
 * automatically when that hold releases.
 *
 * So the deletion runs in FULL. Every purge step happens; the person is
 * de-identified exactly as before. Only the minimum is copied out first, into
 * an encrypted escrow that declares its own purpose, fields, owner, review
 * date and automatic purge deadline. Safety resolution then reads the
 * snapshot rather than the rows erasure just took.
 *
 * This module deliberately mirrors `legal-hold.ts`: holds are TYPED, they are
 * enumerated under the User row lock, and release is idempotent and
 * conditional so a race resolves to exactly one final purge.
 */

// ── The typed holds ────────────────────────────────────────────────────────

export const SAFETY_HOLD_REASONS = ['ACTIVE_SOS', 'OPEN_INCIDENT', 'EVIDENCE_LEGAL_HOLD'] as const;
export type SafetyHoldReason = (typeof SAFETY_HOLD_REASONS)[number];

/**
 * The ONE live-alert predicate, re-exported from the SOS state machine rather
 * than restated. It was already declared twice on main — `LIVE_STATUSES` in
 * `sos.service.ts` and an identical `OPEN_STATUSES` in `safety.routes.ts`,
 * neither importing the other — and a third copy here is how a list like this
 * drifts into disagreeing with itself about whether someone is in danger.
 */
export { LIVE_SOS_STATUSES } from './sos.service';
import { LIVE_SOS_STATUSES } from './sos.service';

/** An incident that still binds. DECIDED still owes the reporter an outcome. */
export const OPEN_INCIDENT_STATUSES: IncidentStatus[] = ['OPEN', 'TRIAGED', 'INVESTIGATING', 'DECIDED'];

export interface HoldRefs {
  sosAlertIds: string[];
  caseIds: string[];
  bundleIds: string[];
}

export interface EnumeratedHolds {
  reasons: SafetyHoldReason[];
  refs: HoldRefs;
}

/**
 * Every safety obligation this person is currently inside. MUST run in the
 * caller's transaction, after the `SELECT ... FOR UPDATE` on the user row, so
 * an alert raised concurrently with a deletion is either seen here or blocked
 * behind the lock — never interleaved.
 *
 * A person is held both as the ACTOR of an alert (they asked for help) and as
 * its COUNTERPARTY (the alert is about them, and the evidence bundle names
 * them as its subject). Both sides need the response authority preserved.
 */
export async function enumerateSafetyHolds(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<EnumeratedHolds> {
  const [alerts, cases, bundles] = await Promise.all([
    tx.sosAlert.findMany({
      where: {
        status: { in: LIVE_SOS_STATUSES as SosStatus[] },
        OR: [{ actorUserId: userId }, { counterpartyUserId: userId }],
      },
      select: { id: true },
    }),
    tx.incidentCase.findMany({
      where: {
        status: { in: OPEN_INCIDENT_STATUSES },
        OR: [{ subjectUserId: userId }, { reporterUserId: userId }],
      },
      select: { id: true },
    }),
    // A legal hold binds regardless of case status: it is the lawful basis
    // that outlives the case, and `legal-hold.ts` already treats it as the
    // authority that freezes deletion everywhere else.
    tx.evidenceBundle.findMany({
      where: { legalHold: true, subjectUserId: userId },
      select: { id: true },
    }),
  ]);

  const reasons: SafetyHoldReason[] = [];
  if (alerts.length > 0) reasons.push('ACTIVE_SOS');
  if (cases.length > 0) reasons.push('OPEN_INCIDENT');
  if (bundles.length > 0) reasons.push('EVIDENCE_LEGAL_HOLD');

  return {
    reasons,
    refs: {
      sosAlertIds: alerts.map((a) => a.id),
      caseIds: cases.map((c) => c.id),
      bundleIds: bundles.map((b) => b.id),
    },
  };
}

// ── The escrow ─────────────────────────────────────────────────────────────

/**
 * The declared minimum. Every field here has to answer "what breaks in a live
 * emergency without it?" — nothing is escrowed because it might be useful.
 *
 *   firstName          the all-clear text names the person; without it the
 *                      contacts get "the person you were alerted about"
 *   phone              the ops desk calls the person the alert is about
 *   emergencyContacts  the verified numbers already told an emergency was
 *                      happening, and owed the message saying it ended
 */
export const ESCROW_FIELDS = ['firstName', 'phone', 'emergencyContacts'] as const;
export const ESCROW_PURPOSE =
  'Resolve an emergency or lawful safety hold that was already open when the account was deleted.';
/** Who may decrypt. Not "admin" — the narrowest role that can work a case. */
export const ESCROW_OWNER_ROLE = 'SAFETY_OPS';
/** A human looks at any escrow still standing after this long. */
export const ESCROW_REVIEW_DAYS = 30;
/** The outer bound. A hold that never releases still dies here. */
export const ESCROW_PURGE_DAYS = 180;

export interface EscrowContact {
  id: string;
  phoneE164: string;
  name: string | null;
  priority: number;
}

export interface EscrowPayload {
  firstName: string | null;
  phone: string | null;
  emergencyContacts: EscrowContact[];
  capturedAt: string;
}

export function escrowDeadlines(now = new Date()): { reviewBy: Date; purgeBy: Date } {
  const day = 24 * 60 * 60 * 1000;
  return {
    reviewBy: new Date(now.getTime() + ESCROW_REVIEW_DAYS * day),
    purgeBy: new Date(now.getTime() + ESCROW_PURGE_DAYS * day),
  };
}

/** Snapshot the minimum, in the caller's transaction, BEFORE the purge runs. */
export async function captureEscrow(
  tx: Prisma.TransactionClient,
  userId: string,
  now = new Date(),
): Promise<EscrowPayload> {
  const [user, contacts] = await Promise.all([
    tx.user.findUnique({ where: { id: userId }, select: { firstName: true, phone: true } }),
    tx.emergencyContact.findMany({
      where: { userId, verifiedAt: { not: null } },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      take: 10,
      select: { id: true, phoneE164: true, name: true, priority: true },
    }),
  ]);
  return {
    firstName: user?.firstName ?? null,
    phone: user?.phone ?? null,
    emergencyContacts: contacts.map((c) => ({
      id: c.id,
      phoneE164: c.phoneE164,
      name: c.name ?? null,
      priority: c.priority,
    })),
    capturedAt: now.toISOString(),
  };
}

interface SealedEscrow {
  /** `Uint8Array<ArrayBuffer>`, not Buffer and not a bare `Uint8Array` — a
   *  bare one defaults to ArrayBufferLike, which Prisma's Bytes column
   *  rejects because it admits SharedArrayBuffer. */
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
  dek: Uint8Array<ArrayBuffer>;
  dekWrapped: boolean;
}

/**
 * AES-256-GCM under a fresh data key, and the data key itself wrapped by the
 * master KEK when one is configured.
 *
 * When no KEK is configured the payload is STILL encrypted and the data key is
 * stored beside it, unwrapped — which `dekWrapped: false` records explicitly
 * rather than leaving a reader to infer it. That is weaker against a database
 * dump and it is deliberately not a reason to skip the escrow: the failure it
 * would cause instead is a live emergency with no way to reach anybody. Either
 * way the shred is the same act — null the key column — so erasure works on a
 * pilot deployment exactly as it does on a keyed one.
 */
export async function sealEscrow(payload: EscrowPayload): Promise<SealedEscrow> {
  const dek = generateDek();
  const { ciphertext, iv, authTag } = encryptBuffer(Buffer.from(JSON.stringify(payload), 'utf8'), dek);
  const provider = getKeyProvider();
  // `Uint8Array.from` (not `new Uint8Array(buf)`) copies into a plain
  // ArrayBuffer, which is the exact shape Prisma's Bytes columns accept.
  const bytes = { ciphertext: Uint8Array.from(ciphertext), iv: Uint8Array.from(iv), authTag: Uint8Array.from(authTag) };
  if (!provider) return { ...bytes, dek: Uint8Array.from(dek), dekWrapped: false };
  return { ...bytes, dek: Uint8Array.from(await provider.wrapDek(dek)), dekWrapped: true };
}

export interface EscrowRow {
  ciphertext: Buffer | Uint8Array | null;
  iv: Buffer | Uint8Array | null;
  authTag: Buffer | Uint8Array | null;
  dek: Buffer | Uint8Array | null;
  dekWrapped: boolean;
}

/**
 * Decrypt an escrow. Returns null once shredded — the caller must treat that
 * as "this is gone forever", never as a transient miss to retry.
 */
export async function openEscrow(row: EscrowRow): Promise<EscrowPayload | null> {
  if (!row.ciphertext || !row.iv || !row.authTag || !row.dek) return null;
  const toBuf = (b: Buffer | Uint8Array) => (Buffer.isBuffer(b) ? b : Buffer.from(b));
  let dek = toBuf(row.dek);
  if (row.dekWrapped) {
    const provider = getKeyProvider();
    if (!provider) {
      log().error({}, '[AG-XF-013] escrow key is wrapped but no key provider is configured — cannot resolve');
      return null;
    }
    dek = await provider.unwrapDek(dek);
  }
  try {
    const plain = decryptBuffer(toBuf(row.ciphertext), dek, toBuf(row.iv), toBuf(row.authTag));
    return JSON.parse(plain.toString('utf8')) as EscrowPayload;
  } catch (err) {
    log().error({ err }, '[AG-XF-013] escrow decrypt failed');
    return null;
  }
}

// ── Opening the hold ───────────────────────────────────────────────────────

export interface OpenedHold {
  holdId: string;
  reasons: SafetyHoldReason[];
}

/**
 * Stage the escrow inside the deletion's own transaction. Idempotent on
 * `userId`: a re-requested deletion REFRESHES the reasons (a new alert may
 * have opened since) without minting a second copy of the same PII, and never
 * resurrects a row that has already been shredded.
 */
export async function openSafetyDeletionHold(
  tx: Prisma.TransactionClient,
  userId: string,
  holds: EnumeratedHolds,
  now = new Date(),
): Promise<OpenedHold> {
  const existing = await tx.safetyDeletionHold.findUnique({ where: { userId } });
  if (existing && existing.status === 'PURGED') {
    // The key is already destroyed; re-staging would re-capture PII that the
    // person's erasure has already completed for.
    log().warn({ userId, holdId: existing.id }, '[AG-XF-013] safety hold already purged — not re-staging');
    return { holdId: existing.id, reasons: holds.reasons };
  }
  if (existing) {
    const updated = await tx.safetyDeletionHold.update({
      where: { userId },
      data: { status: 'PENDING', reasons: holds.reasons, holdRefs: holds.refs as never, releasedAt: null },
    });
    return { holdId: updated.id, reasons: holds.reasons };
  }

  const sealed = await sealEscrow(await captureEscrow(tx, userId, now));
  const { reviewBy, purgeBy } = escrowDeadlines(now);
  const row = await tx.safetyDeletionHold.create({
    data: {
      userId,
      status: 'PENDING',
      reasons: holds.reasons,
      holdRefs: holds.refs as never,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
      dek: sealed.dek,
      dekWrapped: sealed.dekWrapped,
      purpose: ESCROW_PURPOSE,
      fields: [...ESCROW_FIELDS],
      ownerRole: ESCROW_OWNER_ROLE,
      reviewBy,
      purgeBy,
      requestedAt: now,
    },
  });
  log().info(
    { userId, holdId: row.id, reasons: holds.reasons, purgeBy },
    '[AG-XF-013] account deleted under safety hold — minimum response authority escrowed',
  );
  return { holdId: row.id, reasons: holds.reasons };
}

// ── Reading it back during an emergency ────────────────────────────────────

/**
 * The response authority for a person whose account is gone. Safety code calls
 * this INSTEAD of re-reading User and EmergencyContact, because after an
 * erasure those rows are either absent or tombstones. Returns null when the
 * person was never deleted (the ordinary case) or when the escrow has been
 * shredded.
 */
export async function escrowedResponseAuthority(
  prisma: PrismaClient,
  userId: string,
): Promise<EscrowPayload | null> {
  const row = await prisma.safetyDeletionHold.findUnique({
    where: { userId },
    select: { ciphertext: true, iv: true, authTag: true, dek: true, dekWrapped: true, status: true },
  });
  if (!row || row.status === 'PURGED') return null;
  return openEscrow(row);
}

// ── Release and the final purge ────────────────────────────────────────────

export interface ReleaseOutcome {
  /** No hold row for this person — the overwhelmingly common case. */
  noHold: boolean;
  /** Holds remain open; the escrow stands. */
  stillHeld: boolean;
  reasons: SafetyHoldReason[];
  /** This call performed the shred. Exactly one caller ever sees true. */
  purged: boolean;
}

const NO_HOLD: ReleaseOutcome = { noHold: true, stillHeld: false, reasons: [], purged: false };

/**
 * Re-enumerate this person's holds and, if none remain, run the final purge.
 *
 * Called from every place a hold can end — SOS resolve, incident close, legal
 * hold lift — rather than from a timer, so erasure completes at the moment the
 * obligation does. It RE-ENUMERATES instead of trusting the caller's reason:
 * a person can be inside two obligations at once, and closing one of them is
 * not permission to shred the authority the other still needs.
 */
export async function releaseSafetyDeletionHold(
  prisma: PrismaClient,
  userId: string,
): Promise<ReleaseOutcome> {
  const row = await prisma.safetyDeletionHold.findUnique({ where: { userId } });
  if (!row || row.status === 'PURGED') return NO_HOLD;

  const holds = await enumerateSafetyHolds(prisma as unknown as Prisma.TransactionClient, userId);
  if (holds.reasons.length > 0) {
    await prisma.safetyDeletionHold.update({
      where: { userId },
      data: { reasons: holds.reasons, holdRefs: holds.refs as never },
    });
    return { noHold: false, stillHeld: true, reasons: holds.reasons, purged: false };
  }

  const purged = await finalPurge(prisma, row.id, 'hold-released');
  return { noHold: false, stillHeld: false, reasons: [], purged };
}

/**
 * Destroy the key. Conditional on the row still being unshredded, so a release
 * and the retention sweep racing on the same escrow produce exactly ONE purge
 * generation: whichever `updateMany` matches first flips the status, and the
 * loser matches zero rows and reports that it did not purge.
 */
export async function finalPurge(
  prisma: PrismaClient,
  holdId: string,
  cause: 'hold-released' | 'retention-expiry',
  now = new Date(),
): Promise<boolean> {
  const res = await prisma.safetyDeletionHold.updateMany({
    where: { id: holdId, status: { in: ['PENDING', 'RELEASED'] }, shreddedAt: null },
    data: {
      status: 'PURGED',
      // The shred itself: without the key the ciphertext is unrecoverable even
      // from a backup. The ciphertext is dropped too — there is no reason to
      // keep bytes nobody can ever read.
      dek: null,
      ciphertext: null,
      iv: null,
      authTag: null,
      shreddedAt: now,
      purgedAt: now,
      releasedAt: now,
      purgeGeneration: { increment: 1 },
    },
  });
  if (res.count === 0) return false;
  log().info({ holdId, cause }, '[AG-XF-013] safety escrow crypto-shredded — erasure complete');
  return true;
}

/**
 * The outer bound. An escrow whose hold never releases — a case nobody ever
 * closes — is still erased at `purgeBy`. Indefinite retention is the other
 * way this defect fails, and it is a privacy breach rather than a safety one,
 * which makes it no less a breach.
 */
export async function shredExpiredSafetyHolds(
  prisma: PrismaClient,
  now = new Date(),
): Promise<{ shredded: number }> {
  const due = await prisma.safetyDeletionHold.findMany({
    where: { status: { in: ['PENDING', 'RELEASED'] }, purgeBy: { lte: now } },
    select: { id: true },
    take: 500,
  });
  let shredded = 0;
  for (const row of due) {
    if (await finalPurge(prisma, row.id, 'retention-expiry', now)) shredded += 1;
  }
  if (shredded > 0) log().warn({ shredded }, '[AG-XF-013] safety escrows shredded at their retention deadline');
  return { shredded };
}

/** Escrows a privacy owner should look at — past review, not yet purged. */
export async function safetyHoldsDueForReview(prisma: PrismaClient, now = new Date()) {
  return prisma.safetyDeletionHold.findMany({
    where: { status: { in: ['PENDING', 'RELEASED'] }, reviewBy: { lte: now } },
    select: { id: true, userId: true, reasons: true, purpose: true, ownerRole: true, requestedAt: true, reviewBy: true, purgeBy: true },
    orderBy: { reviewBy: 'asc' },
    take: 200,
  });
}

/** Stable digest of what was escrowed, for the deletion receipt. Never the PII. */
export function escrowProof(payload: EscrowPayload): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ── The one resolver every safety path uses ────────────────────────────────

/**
 * Who to name, and who to text, for an alert whose subject may have been
 * erased. Three separate paths on main read the live rows and each fails
 * differently once erasure has run:
 *
 *   • `sos-escalation.ts` CONTACT_SMS looks the contact up by id and, finding
 *     nothing, returns SKIPPED with the receipt `contact-unverified-or-gone`.
 *     The emergency page is never sent, and the outbox records it as handled.
 *   • the same handler reads the actor's `firstName` and falls back to
 *     "Someone you know".
 *   • `fanOutResolved` finds zero contacts and returns silently, so the people
 *     it already alarmed are never told the emergency ended.
 *
 * Live rows always win — this is a fallback for the erased case, never a
 * second source of truth. `deleted:` on the phone is the tombstone the
 * deletion path itself writes, so it is the authoritative signal that the
 * absence is an erasure rather than a person who simply has no contacts.
 */
export interface ResponseAuthority {
  who: string | null;
  contacts: EscrowContact[];
  fromEscrow: boolean;
}

export async function responseAuthorityFor(
  prisma: PrismaClient,
  userId: string,
): Promise<ResponseAuthority> {
  const [user, live] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, phone: true } }),
    prisma.emergencyContact.findMany({
      where: { userId, verifiedAt: { not: null } },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      take: 10,
      select: { id: true, phoneE164: true, name: true, priority: true },
    }),
  ]);

  const erased = !user || user.phone.startsWith('deleted:');
  const liveContacts: EscrowContact[] = live.map((c) => ({
    id: c.id,
    phoneE164: c.phoneE164,
    name: c.name ?? null,
    priority: c.priority,
  }));
  if (!erased) return { who: user.firstName?.trim() || null, contacts: liveContacts, fromEscrow: false };

  const escrow = await escrowedResponseAuthority(prisma, userId);
  if (!escrow) return { who: null, contacts: liveContacts, fromEscrow: false };
  return {
    who: escrow.firstName?.trim() || null,
    contacts: liveContacts.length > 0 ? liveContacts : escrow.emergencyContacts,
    fromEscrow: true,
  };
}
