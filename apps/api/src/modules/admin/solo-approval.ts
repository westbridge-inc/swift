import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { isProduction } from '../../utils/runtime-mode';
import { getChannels } from '../../providers/notifications/channels';
import { smtpConfigFromEnv } from '../../providers/notifications/smtp-email';
import type { AuditFacts, AuditLogWriter } from '../../lib/audit-writer';
import { capabilitiesOf, holdsCapability } from './admin-authority';

/**
 * [OWNER #13 · 13 Oct 2026] SOLO MODE — while the owner is the only admin.
 *
 * A money (C4) or platform (C5) action takes two people (ADM-005). The owner
 * has no second admin and will not for a while, so every such action could be
 * asked for and none could ever happen. The owner chose "solo mode with a
 * delay": until a second admin exists, the requester may approve their OWN
 * request, and only like this —
 *
 *   1. only the owner (SUPER_ADMIN), only while they are the ONE admin who
 *      could approve this action (counted live, in the decision transaction —
 *      never cached);
 *   2. only after a cooling-off wait (platform setting, default 12 h, never
 *      under 1 h), which the requester can cancel;
 *   3. only with a fresh sign-in code at the moment of decision (the existing
 *      step-up, spent by the decision — no new auth channel);
 *   4. with an audit row at the request, the cancel and the decision, and an
 *      email to the owner at the request and at the decision. No email, no solo
 *      mode: a solo approval nobody was told about is exactly the silent act
 *      this law exists to prevent.
 *
 * The moment a second admin who could approve it exists, solo mode is off —
 * for requests already waiting and for solo decisions not yet executed (no
 * grandfathering). The apply gate counts again (admin-approval.ts).
 *
 * RESIDUAL, stated: an admin created in the same milliseconds as a solo
 * decision is not serialised against it. The apply-time recount is the second
 * barrier: an action approved solo never executes once a second approver
 * exists.
 */

/** PlatformConfig key: the wait, in hours, between going solo and deciding. */
export const SOLO_COOLOFF_CONFIG_KEY = 'approvals.solo.cooloff_hours';
export const SOLO_COOLOFF_DEFAULT_HOURS = 12;
export const SOLO_COOLOFF_MIN_HOURS = 1;
/** A week: a longer wait would outlast any reason to have asked. */
export const SOLO_COOLOFF_MAX_HOURS = 168;

/** The only role that may ever go solo. */
export const SOLO_ROLE = 'SUPER_ADMIN';
/** The capability every approver needs, on top of the action's own. */
export const APPROVER_CAPABILITY = 'approvals.decide';

const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const;
/** Account states that can still sign in (auth refuses exactly these three). */
const LOCKED_OUT = ['SUSPENDED', 'BANNED', 'DEACTIVATED'] as const;

/** Hours, from a stored setting: default when unreadable, never under the floor, never over the cap. */
export function clampCoolOffHours(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return SOLO_COOLOFF_DEFAULT_HOURS;
  if (n < SOLO_COOLOFF_MIN_HOURS) return SOLO_COOLOFF_MIN_HOURS;
  if (n > SOLO_COOLOFF_MAX_HOURS) return SOLO_COOLOFF_MAX_HOURS;
  return n;
}

/** The configured wait. A failed read uses the default — never a shorter wait. */
export async function soloCoolOffHours(prisma: Pick<PrismaClient, 'platformConfig'>): Promise<number> {
  try {
    const row = await prisma.platformConfig.findUnique({ where: { key: SOLO_COOLOFF_CONFIG_KEY }, select: { value: true } });
    return clampCoolOffHours(row?.value);
  } catch (err) {
    log().warn({ err }, '[solo approval] cool-off setting unreadable — using the default');
    return SOLO_COOLOFF_DEFAULT_HOURS;
  }
}

export interface ApproverRosterEntry {
  readonly userId: string;
  readonly role: string;
  readonly held: readonly string[];
}

type RosterReader = Pick<PrismaClient, 'user'>;

/**
 * Everyone in this market who could sign an approval, read live. Over-counting
 * is the safe direction (solo mode switches off), so an account counts with
 * the HIGHEST admin role it holds, whichever role is active right now — a
 * second admin who is momentarily "being a customer" is still a second admin.
 */
export async function approverRoster(db: RosterReader): Promise<ApproverRosterEntry[]> {
  const users = await db.user.findMany({
    where: {
      status: { notIn: [...LOCKED_OUT] },
      OR: [{ activeRole: { in: [...ADMIN_ROLES] } }, { roles: { hasSome: [...ADMIN_ROLES] } }],
    },
    select: { id: true, activeRole: true, roles: true, admin: { select: { permissions: true } } },
  });
  return users.map((user) => {
    const roles = new Set<string>([user.activeRole, ...user.roles]);
    const role = roles.has('SUPER_ADMIN') ? 'SUPER_ADMIN' : 'ADMIN';
    return { userId: user.id, role, held: capabilitiesOf({ role, permissions: user.admin?.permissions ?? null }) };
  });
}

/** The admins who could decide an approval needing `capability`. */
export function approversFor(roster: readonly ApproverRosterEntry[], capability: string): ApproverRosterEntry[] {
  return roster.filter((entry) => holdsCapability(entry.held, APPROVER_CAPABILITY) && holdsCapability(entry.held, capability));
}

/** Is `userId` the ONE admin who could approve this capability, right now? */
export async function isSoleApprover(db: RosterReader, userId: string, capability: string): Promise<boolean> {
  const approvers = approversFor(await approverRoster(db), capability);
  return approvers.length === 1 && approvers[0]!.userId === userId;
}

export type SoloRefusal =
  | 'not-owner' | 'not-requester' | 'second-admin' | 'no-email' | 'email-unavailable'
  | 'not-pending' | 'expired' | 'already-started' | 'not-started' | 'cooling-off' | 'approve-only';

const REFUSAL: Record<SoloRefusal, { status: number; code: string; message: string }> = {
  'not-owner': { status: 403, code: 'SOLO_NOT_OWNER', message: 'Only the owner account (super admin) can approve its own request. Ask another admin to decide it.' },
  'not-requester': { status: 403, code: 'SOLO_NOT_REQUESTER', message: 'Only the admin who asked for this action can do that.' },
  'second-admin': { status: 403, code: 'SOLO_SECOND_ADMIN', message: 'Another admin who can approve this now exists, so it needs their approval. Solo approval is only for when you are the only one.' },
  'no-email': { status: 409, code: 'SOLO_NO_EMAIL', message: 'Solo approval emails you when you ask and when you decide. Add an email address to your admin account first. Nothing changed.' },
  'email-unavailable': { status: 503, code: 'SOLO_EMAIL_UNAVAILABLE', message: "Solo approval emails you when you ask and when you decide, and Swift's email is not working or not set up. Nothing changed." },
  'not-pending': { status: 409, code: 'SOLO_NOT_PENDING', message: 'This request is no longer waiting for a decision.' },
  expired: { status: 409, code: 'SOLO_EXPIRED', message: 'This request has expired. Ask for the action again.' },
  'already-started': { status: 409, code: 'SOLO_ALREADY_STARTED', message: 'The solo wait has already started for this request.' },
  'not-started': { status: 403, code: 'SOLO_NOT_STARTED', message: 'You raised this. A money or platform action needs a second person.' },
  'cooling-off': { status: 409, code: 'SOLO_COOLING_OFF', message: 'The waiting period has not ended yet.' },
  'approve-only': { status: 409, code: 'SOLO_APPROVE_ONLY', message: 'To withdraw your own request, cancel it instead.' },
};

export function soloRefusal(code: SoloRefusal, details?: Record<string, unknown>): AppError {
  const r = REFUSAL[code];
  return new AppError(r.status, r.code, r.message, details);
}

/** Guyana wall-clock, for the words a person reads. */
export function guyanaTime(at: Date): string {
  return `${at.toLocaleString('en-GB', { timeZone: 'America/Guyana', dateStyle: 'medium', timeStyle: 'short' })} (Guyana time)`;
}

/**
 * Send the owner's solo email, or refuse. A provider that is not configured,
 * a send that fails, or a store-review seal that suppresses it are all the
 * same answer here: the email did not go, so the step does not happen.
 */
export async function sendSoloEmail(to: string, subject: string, body: string): Promise<void> {
  let ref: string;
  try {
    ({ ref } = await getChannels().email.sendEmail(to, subject, body));
  } catch (err) {
    log().error({ err }, '[solo approval] email could not be sent — refusing the solo step');
    throw soloRefusal('email-unavailable');
  }
  if (!ref || ref === 'review-suppressed') throw soloRefusal('email-unavailable');
}

/**
 * Is an email channel set up that can actually send? A hint for the screen
 * and an early refusal; the SEND is still the authority (a configured mailbox
 * that fails refuses exactly the same way).
 */
export function emailChannelConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const provider = env['EMAIL_PROVIDER'] ?? 'dev';
  if (provider === 'smtp') {
    try { smtpConfigFromEnv(env); return true; } catch { return false; }
  }
  // DevEmail records instead of sending; production refuses it at the send.
  if (provider === 'dev') return !isProduction(env);
  return false;
}

/** After the wait, the request stays decidable for one approval window (APPROVAL_TTL_MS, 24 h). */
export const SOLO_DECISION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** An SMTP dialogue is capped at 8 s; the transaction outlives it. */
const SOLO_TX = { timeout: 30_000, maxWait: 10_000 } as const;

export interface SoloActor {
  readonly userId: string;
  readonly role: string;
}

interface SoloRow {
  id: string;
  action: string;
  capability: string;
  reason: string;
  status: string;
  requestedBy: string;
  expiresAt: Date;
  soloRequestedAt: Date | null;
  soloEligibleAt: Date | null;
}

type SoloTx = Prisma.TransactionClient & AuditLogWriter;
type SoloDb = PrismaClient;
type OnSoloAudit = (tx: SoloTx, facts: AuditFacts) => Promise<void>;

async function loadRow(db: SoloDb, id: string): Promise<SoloRow> {
  const row = (await db.privilegedApproval.findUnique({ where: { id } })) as unknown as SoloRow | null;
  if (!row) throw new NotFoundError('Approval', id);
  return row;
}

async function ownerEmail(db: SoloDb, userId: string): Promise<string | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  const email = user?.email?.trim();
  return email ? email : null;
}

/**
 * Start the solo wait on the requester's own PENDING request. Everything
 * commits together or not at all: the wait, its audit row and the owner's
 * email — the email is sent LAST inside the transaction, so a failed send
 * rolls the wait back and nothing starts unannounced.
 */
export async function startSoloApproval(
  db: SoloDb, approvalId: string, actor: SoloActor,
  deps: { onAudit: OnSoloAudit; now?: Date },
): Promise<{ id: string; soloRequestedAt: Date; soloEligibleAt: Date; expiresAt: Date; coolOffHours: number }> {
  const now = deps.now ?? new Date();
  const row = await loadRow(db, approvalId);
  if (row.requestedBy !== actor.userId) throw soloRefusal('not-requester');
  if (actor.role !== SOLO_ROLE) throw soloRefusal('not-owner');
  if (row.status !== 'PENDING') throw soloRefusal('not-pending');
  if (row.expiresAt.getTime() <= now.getTime()) throw soloRefusal('expired');
  if (row.soloRequestedAt) throw soloRefusal('already-started');
  if (!(await isSoleApprover(db, actor.userId, row.capability))) throw soloRefusal('second-admin');
  const to = await ownerEmail(db, actor.userId);
  if (!to) throw soloRefusal('no-email');
  if (!emailChannelConfigured()) throw soloRefusal('email-unavailable');

  const coolOffHours = await soloCoolOffHours(db);
  const soloEligibleAt = new Date(now.getTime() + coolOffHours * 3_600_000);
  const expiresAt = new Date(Math.max(row.expiresAt.getTime(), soloEligibleAt.getTime() + SOLO_DECISION_WINDOW_MS));

  await db.$transaction(async (tx) => {
    const moved = await tx.privilegedApproval.updateMany({
      where: { id: row.id, status: 'PENDING', requestedBy: actor.userId, soloRequestedAt: null, expiresAt: { gt: now } } as never,
      data: { soloRequestedAt: now, soloEligibleAt, expiresAt } as never,
    });
    if (moved.count !== 1) throw soloRefusal('not-pending');
    // Counted again inside the transaction that starts the wait.
    if (!(await isSoleApprover(tx, actor.userId, row.capability))) throw soloRefusal('second-admin');
    await deps.onAudit(tx as SoloTx, { solo: 'requested', soloEligibleAt: soloEligibleAt.toISOString(), coolOffHours });
    await sendSoloEmail(
      to,
      'Swift: you asked to approve your own admin request (solo approval)',
      [
        'Someone signed in as you asked to approve this request alone, because you are the only admin who can approve it:',
        '',
        `  Action: ${row.action}`,
        `  Reason given: ${row.reason}`,
        `  Request: ${row.id}`,
        '',
        `It can be approved after ${guyanaTime(soloEligibleAt)}, with a sign-in code sent to your phone.`,
        'Nothing happens until then, and nothing happens unless it is approved and then executed.',
        '',
        'If this was not you: open Approvals in the Swift admin console and cancel it now, then sign out of every device.',
      ].join('\n'),
    );
  }, SOLO_TX);
  log().warn({ approvalId: row.id, userId: actor.userId, soloEligibleAt }, '[solo approval] solo wait started');
  return { id: row.id, soloRequestedAt: now, soloEligibleAt, expiresAt, coolOffHours };
}

/** The requester withdraws their own PENDING request (solo or not). */
export async function cancelOwnApproval(
  db: SoloDb, approvalId: string, actor: SoloActor,
  deps: { onAudit: OnSoloAudit; now?: Date },
): Promise<{ id: string; status: 'CANCELLED' }> {
  const now = deps.now ?? new Date();
  const row = await loadRow(db, approvalId);
  if (row.requestedBy !== actor.userId) throw soloRefusal('not-requester');
  if (row.status !== 'PENDING') throw soloRefusal('not-pending');
  await db.$transaction(async (tx) => {
    const moved = await tx.privilegedApproval.updateMany({
      where: { id: row.id, status: 'PENDING', requestedBy: actor.userId },
      data: { status: 'CANCELLED', decidedAt: now, decisionNote: 'Withdrawn by the admin who asked for it' },
    });
    if (moved.count !== 1) throw soloRefusal('not-pending');
    await deps.onAudit(tx as SoloTx, { solo: row.soloRequestedAt ? 'cancelled' : null, cancelled: true });
  });
  return { id: row.id, status: 'CANCELLED' };
}

/**
 * The requester decides their own request, in solo mode. The caller has
 * established that the decider IS the requester and that the wait was
 * started; everything else is checked here, cheapest first, so a refusal that
 * needs no code never spends one. The sign-in code is spent before the
 * transaction (one code, one decision attempt); inside it the approvers are
 * counted again, the decision is a compare-and-set, the audit row is written
 * and the owner's email is sent last — a failed send rolls the decision back.
 */
export async function decideSoloApproval(
  db: SoloDb, approvalId: string, actor: SoloActor & { holds: (capability: string) => boolean },
  decision: { approve: boolean; note?: string | undefined },
  deps: { consumeStepUp: () => Promise<void>; onAudit: OnSoloAudit; now?: Date },
): Promise<{ id: string; status: 'APPROVED' }> {
  const now = deps.now ?? new Date();
  const row = await loadRow(db, approvalId);
  if (row.requestedBy !== actor.userId) throw soloRefusal('not-requester');
  if (!row.soloRequestedAt || !row.soloEligibleAt) throw soloRefusal('not-started');
  if (!decision.approve) throw soloRefusal('approve-only');
  if (actor.role !== SOLO_ROLE) throw soloRefusal('not-owner');
  if (row.status !== 'PENDING') throw soloRefusal('not-pending');
  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.privilegedApproval.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
    throw soloRefusal('expired');
  }
  if (!actor.holds(row.capability)) {
    throw new AppError(403, 'FORBIDDEN', 'Approving an action you could not perform yourself is a signature, not a check.');
  }
  if (now.getTime() < row.soloEligibleAt.getTime()) {
    throw soloRefusal('cooling-off', { availableAt: row.soloEligibleAt.toISOString(), availableAtText: guyanaTime(row.soloEligibleAt) });
  }
  if (!(await isSoleApprover(db, actor.userId, row.capability))) throw soloRefusal('second-admin');
  const to = await ownerEmail(db, actor.userId);
  if (!to) throw soloRefusal('no-email');
  if (!emailChannelConfigured()) throw soloRefusal('email-unavailable');

  await deps.consumeStepUp();

  await db.$transaction(async (tx) => {
    if (!(await isSoleApprover(tx, actor.userId, row.capability))) throw soloRefusal('second-admin');
    const decided = await tx.privilegedApproval.updateMany({
      where: {
        id: row.id, status: 'PENDING', requestedBy: actor.userId,
        soloEligibleAt: { lte: now }, expiresAt: { gt: now },
      } as never,
      data: {
        status: 'APPROVED', approvedBy: actor.userId, decidedSolo: true, decidedAt: now,
        decisionNote: decision.note ?? null,
      } as never,
    });
    if (decided.count !== 1) throw soloRefusal('not-pending');
    await deps.onAudit(tx as SoloTx, { solo: 'approved', approvers: 1 });
    await sendSoloEmail(
      to,
      'Swift: you approved your own admin request (solo approval)',
      [
        'Someone signed in as you, with a sign-in code sent to your phone, approved this request alone:',
        '',
        `  Action: ${row.action}`,
        `  Reason given: ${row.reason}`,
        `  Request: ${row.id}`,
        `  Approved: ${guyanaTime(now)}`,
        '',
        'It happens only when it is executed from Approvals. If this was not you: do not execute it, sign out of every device, and change your sign-in.',
      ].join('\n'),
    );
  }, SOLO_TX);
  log().warn({ approvalId: row.id, userId: actor.userId }, '[solo approval] approved in solo mode');
  return { id: row.id, status: 'APPROVED' };
}

export type SoloRowState =
  | { state: 'waiting'; availableAt: string }
  | { state: 'ready'; availableAt: string }
  | { state: 'available'; coolOffHours: number }
  | { state: 'unavailable'; why: SoloRefusal; message: string };

/** What the Approvals screen shows on the requester's own row. */
export function soloRowState(
  row: Pick<SoloRow, 'status' | 'capability' | 'soloRequestedAt' | 'soloEligibleAt'>,
  ctx: { userId: string; role: string; roster: readonly ApproverRosterEntry[]; hasEmail: boolean; emailReady: boolean; coolOffHours: number; now: Date },
): SoloRowState | null {
  if (row.status !== 'PENDING') return null;
  if (row.soloRequestedAt && row.soloEligibleAt) {
    const availableAt = row.soloEligibleAt.toISOString();
    return ctx.now.getTime() < row.soloEligibleAt.getTime() ? { state: 'waiting', availableAt } : { state: 'ready', availableAt };
  }
  const why: SoloRefusal | null =
    ctx.role !== SOLO_ROLE ? 'not-owner'
      : !(() => { const a = approversFor(ctx.roster, row.capability); return a.length === 1 && a[0]!.userId === ctx.userId; })() ? 'second-admin'
        : !ctx.hasEmail ? 'no-email'
          : !ctx.emailReady ? 'email-unavailable'
            : null;
  return why ? { state: 'unavailable', why, message: REFUSAL[why].message } : { state: 'available', coolOffHours: ctx.coolOffHours };
}
