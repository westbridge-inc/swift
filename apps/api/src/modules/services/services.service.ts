import { isNeverAcceptedDocType, OPTIONAL_LIST_SUFFIX, TRADE_LICENCE_DOC_TYPES } from '../verification/doc-registry';
import { DEFAULT_DOCUMENT_CHECKLISTS, SERVICE_TRADE_LAUNCH_FLOOR } from '../ops/platform-config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { approvedEvidenceFor } from '../verification/evidence';
import { AppError, NotFoundError } from '../../utils/errors';
import { assertUsersMayContact } from '../moderation/user-block.service';
import { formatGuyanaTime } from '../../utils/guyana-day';
import { ownerWallSystem } from '../../lib/owner-rls';

/** The verification projection is used both on the root client and inside
 * profile-save transactions. Keep the contract narrow enough that the same
 * canonical checklist can run before the transaction commits. */
type ProviderVerificationDb = PrismaClient | Prisma.TransactionClient;

import {
  canonicalServiceTrade,
  isServiceCategoryOperational,
  profileOffersDroneWork,
  type ServiceTradeId,
} from './service-catalog';
export {
  SERVICE_TRADE_CATALOG,
  canonicalServiceTrade,
  requireCanonicalServiceTrade,
  serviceTradeLabel,
  tradeRiskTier,
  riskGuidance,
  qualificationTypeMatchesTrade,
  type ServiceTradeId,
} from './service-catalog';
/** The once-per-booking-per-person key (Notification's per-user dedupe key):
 * the unique index refuses a second reminder for the same booking to the same
 * person, even from a retried or overlapping sweep. */
export function appointmentReminderDedupeKey(bookingId: string): string {
  return `appointment-reminder:${bookingId}`;
}

/** A reminder handed to the delivery seam. `audience` and `dedupeKey` ride
 * into NotificationService.send unchanged (the booking-reminders worker spreads
 * this object into it). */
export type BookingReminder = {
  userId: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  audience?: 'customer' | 'business';
  dedupeKey?: string;
};

/**
 * Booking reminders (master plan §4.3): both sides get ONE nudge in the 24h
 * before a confirmed slot. Covers service jobs (provider-confirmed) and
 * appointment bookings. Dedupe rides on the notification log (same pattern as
 * the verification expiry reminders) — no schema flags to keep in sync.
 */
export async function sendBookingReminders(
  prisma: PrismaClient,
  notify: (n: BookingReminder) => Promise<unknown>,
): Promise<number> {
  const now = new Date();
  const soon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  let sent = 0;

  /** Has this person already had a reminder naming this id, as any of the
   *  kinds in `sentAs` (each names the id under its own field)? */
  const alreadyReminded = async (userId: string, sentAs: Array<{ kind: string; idKey: string }>, id: string) => {
    // [item 20] A customer's or provider's reminder, looked up by the reminder job: the named capability under the owner wall.
    const existing = await ownerWallSystem('services:already-reminded', () => prisma.notification.findFirst({
      where: {
        userId,
        OR: sentAs.map(({ kind, idKey }) => ({
          AND: [
            { data: { path: ['kind'], equals: kind } },
            { data: { path: [idKey], equals: id } },
          ],
        })),
      },
      select: { id: true },
    }));
    return existing !== null;
  };

  // Service jobs: SCHEDULED + provider-confirmed, starting within 24h.
  const jobs = await prisma.serviceJob.findMany({
    where: {
      status: 'SCHEDULED',
      providerConfirmedAt: { not: null },
      scheduledFor: { gt: now, lte: soon },
    },
    include: { provider: { select: { userId: true, trade: true } } },
  });
  for (const job of jobs) {
    const when = formatGuyanaTime(job.scheduledFor!, { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }, 'en-US');
    for (const [userId, body] of [
      [job.customerId, `Your ${job.provider.trade.toLowerCase()} is booked for ${when}. Cash on completion.`],
      [job.provider.userId, `You have a job booked for ${when}. Check the details in your jobs list.`],
    ] as Array<[string, string]>) {
      if (await alreadyReminded(userId, [{ kind: 'booking_reminder', idKey: 'refId' }], job.id)) continue;
      await notify({
        userId,
        title: 'Booking tomorrow',
        body,
        data: { kind: 'booking_reminder', refId: job.id },
      });
      sent += 1;
    }
  }

  // Appointment bookings (goods/services listings with slots): confirmed ones
  // starting within 24h remind the customer and the store owner.
  // [S4 · BOOK-MEASURE R5] Sent as appointment_reminder, NOT a `booking_`
  // kind: every phone build (9, 11, 12) routes the whole `booking_` prefix to
  // ServiceJobs, the marketplace jobs list, which never shows a store booking.
  // Each copy names the booking's order and whose copy it is, so those same
  // frozen builds land it through the order branches they already have: the
  // business on its order desk (audience business + orderId), the customer on
  // the booking's own order screen (orderId). A booking reminded before this
  // kind existed (booking_reminder + refId = the booking) is not reminded
  // again, and one person is reminded once per booking whichever side they are.
  const bookings = await prisma.booking.findMany({
    where: { status: 'CONFIRMED', slotStart: { gt: now, lte: soon } },
    include: { item: { select: { name: true, vendor: { select: { name: true, owner: { select: { userId: true } } } } } } },
  });
  for (const b of bookings) {
    const when = formatGuyanaTime(b.slotStart, { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }, 'en-US');
    for (const [userId, audience, body] of [
      [b.customerId, 'customer', `${b.item.name} at ${b.item.vendor.name} is booked for ${when}.`],
      [b.item.vendor.owner.userId, 'business', `${b.item.name} appointment coming up ${when}.`],
    ] as Array<[string, 'customer' | 'business', string]>) {
      // A person who is both sides finds the copy just sent under the same booking and is skipped.
      if (await alreadyReminded(userId, [
        { kind: 'appointment_reminder', idKey: 'bookingId' },
        { kind: 'booking_reminder', idKey: 'refId' },
      ], b.id)) continue;
      await notify({
        userId,
        title: 'Appointment tomorrow',
        body,
        audience,
        dedupeKey: appointmentReminderDedupeKey(b.id),
        data: { kind: 'appointment_reminder', bookingId: b.id, ...(b.orderId ? { orderId: b.orderId } : {}) },
      });
      sent += 1;
    }
  }

  return sent;
}

/** Checklist key for a canonical trade ID ("electrician" → …_ELECTRICIAN). */
function tradeChecklistKey(trade: ServiceTradeId): string {
  return `SERVICE_PROVIDER_TRADE_${trade.toUpperCase()}`;
}

/**
 * The provider's country checklists: the code defaults under the stored JSON,
 * as every other checklist reader merges them (a list added in code exists on a
 * deployed row before any reseed; an edited stored list still wins). No country
 * row means no checklist — never another market's defaults.
 */
async function providerLists(prisma: ProviderVerificationDb, userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { countryCode: true } });
  if (!user) return null;
  const config = await prisma.countryConfig.findUnique({ where: { code: user.countryCode } });
  if (!config) return null;
  const lists: Record<string, string[]> = { ...DEFAULT_DOCUMENT_CHECKLISTS, ...((config.documentChecklists as Record<string, string[]>) ?? {}) };
  const provider = await prisma.serviceProvider.findUnique({ where: { userId }, select: { trade: true, bio: true } });
  const trade = provider?.trade ? canonicalServiceTrade(provider.trade) : null;
  if (!trade || !isServiceCategoryOperational(trade)) return null;
  // [R15 · research A9] Drone and aerial work is held: a stored profile that offers it (saved before
  // the profile check, or by any other writer) has no checklist, so it is never verified or listed.
  if (profileOffersDroneWork(provider?.bio ?? null)) return null;
  return { lists, trade };
}

/**
 * The full document checklist a provider must satisfy: the SERVICE_PROVIDER
 * base (identity + character) PLUS any trade-mandated extension from
 * CountryConfig (onboarding spec §3.5 — requirements are data, not code).
 * Electrical work is illegal without a GEI Electrical Contractor Licence, so
 * electricians carry `gei_electrical_licence` as a GATE. [ROLE-DOCS · PR 3] Once a
 * person has approved it, it is also the licence line ("Licence on file, checked
 * on [date]", requiredLicenceCheckedOn) — never a badge of its own.
 *
 * [TRADES · owner 13 Oct 2026] A trade opened at launch also carries its legal
 * floor (identity, police clearance and its own licences), which no stored
 * edit can remove. A profile that offers drone or aerial work has no
 * checklist at all (held, R15). The provider gate reads the lists and the floor
 * here, never the DOC-1 registry facade (registryChecklist); a change that
 * moves providers onto the registry must carry SERVICE_TRADE_LAUNCH_FLOOR too.
 */
export async function providerChecklist(prisma: ProviderVerificationDb, userId: string): Promise<string[]> {
  const found = await providerLists(prisma, userId);
  if (!found) return [];
  const { lists, trade } = found;
  const base = lists['SERVICE_PROVIDER'] ?? [];
  const extra = lists[tradeChecklistKey(trade)] ?? [];
  const floor = SERVICE_TRADE_LAUNCH_FLOOR[trade] ?? [];
  return [...new Set([...base, ...extra, ...floor])].filter((docType) => !isNeverAcceptedDocType(docType));
}

/**
 * [TRADES] Documents a provider MAY add — the base `SERVICE_PROVIDER_OPTIONAL`
 * list and their trade's `_OPTIONAL` list — never one their checklist already
 * requires. Display and upload only: no gate reads it.
 */
export async function providerOptionalDocuments(
  prisma: ProviderVerificationDb,
  userId: string,
  required: readonly string[],
): Promise<string[]> {
  const found = await providerLists(prisma, userId);
  if (!found) return [];
  const { lists, trade } = found;
  const optional = [
    ...(lists[`SERVICE_PROVIDER${OPTIONAL_LIST_SUFFIX}`] ?? []),
    ...(lists[`${tradeChecklistKey(trade)}${OPTIONAL_LIST_SUFFIX}`] ?? []),
  ];
  return [...new Set(optional)].filter((docType) => !required.includes(docType) && !isNeverAcceptedDocType(docType));
}

/**
 * A provider may operate live only when their FULL checklist is approved and
 * unexpired — base identity/character plus the trade's legal gate (§3.5).
 * Mirrors the verification gate without coupling to the vendor-oriented
 * ChecklistRole type.
 */
export async function isProviderVerified(
  prisma: ProviderVerificationDb,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  if (!user || user.status !== 'ACTIVE') return false;

  const checklist = await providerChecklist(prisma, userId);
  if (checklist.length === 0) return false;

  // [DOC-1 P4-2] One evidence rule for every projection: records, not image rows.
  const approved = await approvedEvidenceFor(prisma, userId, checklist, now);
  const have = new Set(approved.map((d) => d.docType));
  return checklist.every((docType) => have.has(docType));
}

/** [ROLE-DOCS · PR 3] The trade licences (a registry fact, DOC-INV-2: verification/doc-registry). */
export { TRADE_LICENCE_DOC_TYPES };

/** The licences among a checklist, in checklist order. */
export function tradeLicencesOf(checklist: readonly string[]): string[] {
  return checklist.filter((docType) => TRADE_LICENCE_DOC_TYPES.has(docType));
}

/**
 * [ROLE-DOCS · PR 3 · R7 · GUARDRAILS §7(4)] "Licence on file, checked on [date]" from the licence the provider's trade
 * REQUIRES: the latest day a PERSON approved one, or null. Fail closed: every licence the checklist names must be
 * approved and current under THE evidence rule, each by a person — the approver must be a user of Swift, never an
 * engine marker ('system', 'kyc:auto', 'auto:…'). An engine's approval still lets the provider work (the gate reads the
 * record) but is never shown as a licence a person checked.
 */
export async function requiredLicenceCheckedOn(prisma: ProviderVerificationDb, userId: string, now = new Date()): Promise<Date | null> {
  return (await requiredLicenceStatus(prisma, userId, now)).checkedOn;
}

/**
 * [ROLE-DOCS · PR 3 · REVIEW-F #2053 S4-2] Whether the provider's trade REQUIRES a licence, and the day a person checked
 * it (requiredLicenceCheckedOn). A trade that requires a licence is never "self-skilled": with no person's check the
 * line reads "No trade credential shown", never "Self-skilled".
 */
export async function requiredLicenceStatus(
  prisma: ProviderVerificationDb, userId: string, now = new Date(),
): Promise<{ required: boolean; checkedOn: Date | null }> {
  const licences = tradeLicencesOf(await providerChecklist(prisma, userId));
  if (licences.length === 0) return { required: false, checkedOn: null };
  return { required: true, checkedOn: await personCheckedOn(prisma, userId, licences, now) };
}

async function personCheckedOn(prisma: ProviderVerificationDb, userId: string, licences: string[], now: Date): Promise<Date | null> {
  const rows = (await approvedEvidenceFor(prisma, userId, licences, now)).filter((row) => row.userId === userId);
  const approvers = [...new Set(rows.map((row) => row.approvedBy).filter((by) => !/^(system$|kyc:|auto:|engine:)/.test(by)))];
  const people = approvers.length === 0
    ? new Set<string>()
    : new Set((await prisma.user.findMany({ where: { id: { in: approvers } }, select: { id: true } })).map((u) => u.id));
  let latest: Date | null = null;
  for (const docType of licences) {
    const checked = rows.filter((row) => row.docType === docType && people.has(row.approvedBy));
    if (checked.length === 0) return null;
    for (const row of checked) if (!latest || row.approvedAt > latest) latest = row.approvedAt;
  }
  return latest;
}

/** Optional observation seam for deterministic concurrency certification.
 * Production callers omit it; it never changes the transaction's decisions. */
export interface ProviderVerificationRefreshObserver {
  afterSnapshot?: (snapshot: Readonly<{
    providerId: string;
    persisted: boolean;
    recomputed: boolean;
  }>) => Promise<void>;
}

/** Caller must hold the canonical User authority lock. This form is shared by
 * document transitions and profile writes so they do not open nested
 * transactions or compute from an unlocked trade/document snapshot. */
export async function projectProviderVerificationLocked(
  tx: Prisma.TransactionClient,
  userId: string,
  observer?: ProviderVerificationRefreshObserver,
): Promise<boolean> {
  const provider = await tx.serviceProvider.findUnique({
    where: { userId },
    select: { id: true, trade: true, isVerified: true, selfSkilled: true },
  });
  if (!provider) return false;

  const trade = canonicalServiceTrade(provider.trade);
  const verified = trade ? await isProviderVerified(tx, userId) : false;
  const matchingQualificationCount = trade
    ? await tx.serviceQualification.count({
        where: {
          providerId: provider.id,
          trade,
          status: 'VERIFIED',
          verifiedAt: { not: null },
          // [ROLE-DOCS · owner 21 Oct 2026] a GEI_LICENCE qualification counts for no trade (qualificationTypeMatchesTrade)
          type: { not: 'GEI_LICENCE' },
        },
      })
    : 0;
  // [ROLE-DOCS · PR 3 · REVIEW-F #2053 S4-2] A trade that requires a licence is never "self-skilled".
  const selfSkilled = matchingQualificationCount === 0 && !(await requiredLicenceStatus(tx, userId)).required;

  await observer?.afterSnapshot?.({
    providerId: provider.id,
    persisted: provider.isVerified,
    recomputed: verified,
  });
  if (verified !== provider.isVerified || selfSkilled !== provider.selfSkilled) {
    await tx.serviceProvider.update({
      where: { id: provider.id },
      data: { isVerified: verified, selfSkilled },
    });
  }
  return verified;
}

/**
 * Recompute + persist a provider's live flag after any document event
 * (approval, rejection, expiry). Providers previously refreshed only when
 * they re-saved their profile — a lapsed GEI licence must pull an
 * electrician off the marketplace the moment the sweep sees it.
 */
export async function refreshProviderVerification(
  prisma: PrismaClient,
  userId: string,
  observer?: ProviderVerificationRefreshObserver,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // The profile route uses this same canonical User row as its authority
    // lock. Therefore a trade change and a verification refresh are ordered:
    // neither can persist a checklist decision based on the other's old trade.
    const users = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "users"
      WHERE "id" = ${userId}
      FOR UPDATE /* service-provider-verification-authority */
    `;
    if (!users[0]) return;

    await projectProviderVerificationLocked(tx, userId, observer);
  });
}

/**
 * Replay/reconciliation path for a process crash between a document-state
 * commit and its provider projection. The cursor keeps memory bounded; each
 * provider still uses the same short User-row transaction as the live path.
 */
export async function reconcileProviderVerifications(
  prisma: PrismaClient,
  batchSize = 100,
): Promise<number> {
  const take = Math.max(1, Math.min(batchSize, 500));
  let cursor: string | undefined;
  let reconciled = 0;

  for (;;) {
    const providers = await prisma.serviceProvider.findMany({
      ...(cursor ? { where: { id: { gt: cursor } } } : {}),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, userId: true },
    });
    if (providers.length === 0) return reconciled;

    for (const provider of providers) {
      await refreshProviderVerification(prisma, provider.userId);
      reconciled += 1;
    }
    cursor = providers[providers.length - 1]!.id;
  }
}

interface ProviderCursorClaims {
  v: 1;
  tenantId: string;
  trade: ServiceTradeId;
  afterId: string;
}

function providerCursorSecret(): string {
  const secret = process.env['SERVICE_PROVIDER_CURSOR_SECRET'] ?? process.env['JWT_SECRET'];
  if (!secret) throw new Error('SERVICE_PROVIDER_CURSOR_SECRET or JWT_SECRET is required');
  return secret;
}

function signProviderCursor(payload: string): Buffer {
  return createHmac('sha256', providerCursorSecret()).update(payload).digest();
}

/** Deterministic, tenant/trade-bound cursor. The row ID and scope are not
 * exposed as query parameters and tampering fails before any database query. */
export function encodeProviderCursor(claims: Omit<ProviderCursorClaims, 'v'>): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...claims } satisfies ProviderCursorClaims)).toString('base64url');
  return `${payload}.${signProviderCursor(payload).toString('base64url')}`;
}

export function decodeProviderCursor(
  cursor: string,
  scope: { tenantId: string; trade: ServiceTradeId },
): string {
  const parts = cursor.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError(400, 'INVALID_CURSOR', 'The provider page cursor is invalid.');
  }
  const [payload, signatureText] = parts as [string, string];
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signatureText, 'base64url');
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'The provider page cursor is invalid.');
  }
  // Buffer's base64url decoder is intentionally permissive: padded and some
  // otherwise non-canonical strings can decode to the same bytes. Cursor
  // signatures are protocol values, so accept exactly one textual encoding.
  // This keeps byte-equivalent spelling changes observable as tampering.
  if (supplied.toString('base64url') !== signatureText) {
    throw new AppError(400, 'INVALID_CURSOR', 'The provider page cursor is invalid.');
  }
  const expected = signProviderCursor(payload);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new AppError(400, 'INVALID_CURSOR', 'The provider page cursor is invalid.');
  }

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'The provider page cursor is invalid.');
  }
  if (
    !claims
    || typeof claims !== 'object'
    || (claims as Partial<ProviderCursorClaims>).v !== 1
    || (claims as Partial<ProviderCursorClaims>).tenantId !== scope.tenantId
    || (claims as Partial<ProviderCursorClaims>).trade !== scope.trade
    || typeof (claims as Partial<ProviderCursorClaims>).afterId !== 'string'
    || !(claims as Partial<ProviderCursorClaims>).afterId
  ) {
    throw new AppError(400, 'INVALID_CURSOR', 'The provider page cursor does not match this marketplace query.');
  }
  return (claims as ProviderCursorClaims).afterId;
}

/** How long an unanswered request counts as "the same request" when the
 *  customer sends it again (a lost response, a second tap). Longer than any
 *  client timeout plus a re-tap; far shorter than a real second ask. */
export const SERVICE_JOB_RETRY_WINDOW_MS = 10 * 60 * 1000;

export interface ServiceJobAuthorityObserver {
  /** Test-only observation seam. Production does not provide an observer. */
  afterAuthorityChecked?: (snapshot: Readonly<{
    providerId: string;
    providerUserId: string;
    trade: ServiceTradeId;
  }>) => Promise<void>;
}

/**
 * The request + chat creation boundary. Customer and provider User rows are
 * locked in stable order, then tenant, account status, canonical trade and the
 * live unexpired document checklist are re-read inside that same transaction.
 * Profile changes, document decisions/expiry and self-deletion use the same
 * User lock, making hire authority linearizable rather than cache-dependent.
 */
export async function createServiceJobWithLiveAuthority(
  prisma: PrismaClient,
  input: {
    customerId: string;
    tenantId: string;
    providerId: string;
    description: string;
    photos: string[];
  },
  observer?: ServiceJobAuthorityObserver,
) {
  const candidate = await prisma.serviceProvider.findUnique({
    where: { id: input.providerId },
    select: { userId: true },
  });
  if (!candidate) throw new NotFoundError('ServiceProvider', input.providerId);

  return prisma.$transaction(async (tx) => {
    const authorityIds = [...new Set([input.customerId, candidate.userId])].sort();
    const lockedUsers = await tx.$queryRaw<Array<{ id: string; status: string; tenantId: string }>>(
      Prisma.sql`
        SELECT "id", "status"::text, "tenantId"
        FROM "users"
        WHERE "id" IN (${Prisma.join(authorityIds)})
        ORDER BY "id"
        FOR UPDATE /* service-job-live-authority */
      `,
    );
    const users = new Map(lockedUsers.map((user) => [user.id, user]));
    const customer = users.get(input.customerId);
    if (!customer || customer.status !== 'ACTIVE' || customer.tenantId !== input.tenantId) {
      throw new AppError(403, 'CUSTOMER_NOT_ACTIVE', 'Your account cannot request a service job right now.');
    }

    const provider = await tx.serviceProvider.findUnique({
      where: { id: input.providerId },
      select: { id: true, userId: true, trade: true, isVerified: true },
    });
    if (!provider || provider.userId !== candidate.userId) {
      throw new NotFoundError('ServiceProvider', input.providerId);
    }
    const providerUser = users.get(provider.userId);
    if (!providerUser || providerUser.tenantId !== input.tenantId) {
      // Cross-tenant IDs are indistinguishable from nonexistent IDs.
      throw new NotFoundError('ServiceProvider', input.providerId);
    }
    if (provider.userId === input.customerId) {
      throw new AppError(400, 'SELF_JOB', 'You cannot hire yourself');
    }
    // [SEC-TRUST F2] A block in EITHER direction ends contact (user-block.service): no job, no chat room and
    // no notice across it. Read after both User rows are locked — a block takes the same two locks — so a
    // block that committed first is seen here. One neutral answer whichever side blocked.
    await assertUsersMayContact(tx, input.tenantId, input.customerId, provider.userId);

    const trade = canonicalServiceTrade(provider.trade);
    const verified = providerUser.status === 'ACTIVE' && trade
      ? await isProviderVerified(tx, provider.userId)
      : false;
    if (!verified || !trade) {
      throw new AppError(403, 'PROVIDER_NOT_VERIFIED', 'This provider is not currently verified to accept jobs');
    }

    await observer?.afterAuthorityChecked?.({
      providerId: provider.id,
      providerUserId: provider.userId,
      trade,
    });

    // [C2 server] A RETRIED REQUEST IS THE SAME REQUEST. The phone sends no
    // Idempotency-Key here (builds 9/11 cannot be changed), so a response lost
    // on a slow network, or a second tap, used to mint a second REQUESTED job
    // and a second chat room for the same ask. The natural key is the ask
    // itself: this customer, this provider, the same words and photos, still
    // unanswered (REQUESTED), asked moments ago. The customer's User row is
    // locked FOR UPDATE above, so two copies of one request run one after the
    // other and the second one sees the first. It gets the first job back —
    // same job, same room, and no second notice to the provider.
    const earlier = await tx.serviceJob.findFirst({
      where: {
        tenantId: input.tenantId,
        customerId: input.customerId,
        providerId: provider.id,
        description: input.description,
        photos: { equals: input.photos },
        status: 'REQUESTED',
        chatRoomId: { not: null },
        createdAt: { gte: new Date(Date.now() - SERVICE_JOB_RETRY_WINDOW_MS) },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (earlier) return { job: earlier, created: false as const };

    const job = await tx.serviceJob.create({
      data: {
        // [TA-S1-006] Both parties were just proven to live in input.tenantId;
        // the job records it durably so safety routing never re-derives it.
        tenantId: input.tenantId,
        customerId: input.customerId,
        providerId: provider.id,
        description: input.description,
        photos: input.photos,
        status: 'REQUESTED',
      },
    });
    const room = await tx.chatRoom.create({
      data: {
        serviceJobId: job.id,
        participants: {
          create: [
            { userId: input.customerId, role: 'customer' },
            { userId: provider.userId, role: 'provider' },
          ],
        },
      },
    });
    const linked = await tx.serviceJob.update({ where: { id: job.id }, data: { chatRoomId: room.id } });
    return { job: linked, created: true as const };
  });
}
