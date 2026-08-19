import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient, type QualificationType } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';

/** The verification projection is used both on the root client and inside
 * profile-save transactions. Keep the contract narrow enough that the same
 * canonical checklist can run before the transaction commits. */
type ProviderVerificationDb = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Services vertical (spec §4.6). Trust is risk-tiered: verify hard where someone
// could be physically harmed. Every provider needs ID + police clearance; a
// trade qualification is an optional "Certified" badge. Providers without one
// can still join, shown transparently as "self-skilled".
// ---------------------------------------------------------------------------

export const SERVICE_TRADE_CATALOG = {
  electrician: {
    label: 'Electrician', riskTier: 'HIGH',
    aliases: ['electrician', 'electrical', 'electrical contractor', 'electrical installation contractor'],
  },
  plumber: {
    label: 'Plumber', riskTier: 'HIGH',
    aliases: ['plumber', 'plumbing', 'major plumbing'],
  },
  gas_fitter: {
    label: 'Gas fitter', riskTier: 'HIGH',
    aliases: ['gas fitter', 'gas fitting', 'gas technician'],
  },
  carpenter: {
    label: 'Carpenter / joiner', riskTier: 'LOW',
    aliases: ['carpenter', 'carpentry', 'joiner', 'carpenter joiner'],
  },
  cleaner: { label: 'Cleaner', riskTier: 'LOW', aliases: ['cleaner', 'cleaning', 'house cleaner'] },
  ac_refrigeration: {
    label: 'AC & refrigeration technician', riskTier: 'LOW',
    aliases: ['ac repair', 'a c repair', 'ac refrigeration', 'ac and refrigeration technician', 'air conditioning repair', 'refrigeration technician', 'hvac'],
  },
  mechanic: { label: 'Mechanic', riskTier: 'LOW', aliases: ['mechanic', 'auto mechanic', 'vehicle mechanic'] },
  painter: { label: 'Painter', riskTier: 'LOW', aliases: ['painter', 'painting', 'house painter'] },
  mason: { label: 'Mason', riskTier: 'LOW', aliases: ['mason', 'masonry', 'bricklayer'] },
  welder: {
    label: 'Welder / fabricator', riskTier: 'LOW',
    aliases: ['welder', 'welding', 'fabricator', 'welder fabricator'],
  },
  gardener: { label: 'Gardener', riskTier: 'LOW', aliases: ['gardener', 'gardening', 'landscaper', 'landscaping'] },
  appliance_electronics_repair: {
    label: 'Appliance & electronics repair', riskTier: 'LOW',
    aliases: ['appliance repair', 'electronics repair', 'appliance and electronics repair'],
  },
  solar_generator_inverter_installer: {
    label: 'Solar / generator / inverter installer', riskTier: 'LOW',
    aliases: ['solar installer', 'generator installer', 'inverter installer', 'solar generator inverter installer'],
  },
  tiler: { label: 'Tiler', riskTier: 'LOW', aliases: ['tiler', 'tiling', 'tile installer'] },
  pest_control: { label: 'Pest control', riskTier: 'LOW', aliases: ['pest control', 'exterminator'] },
  heavy_equipment_operator: {
    label: 'Heavy-equipment operator', riskTier: 'LOW',
    aliases: ['heavy equipment operator', 'heavy machinery operator'],
  },
  chef: { label: 'Chef', riskTier: 'LOW', aliases: ['chef', 'personal chef'] },
  caterer: { label: 'Caterer', riskTier: 'LOW', aliases: ['caterer', 'catering'] },
  party_organizer: { label: 'Party organizer', riskTier: 'LOW', aliases: ['party organizer', 'event planner', 'party planner'] },
  barber: { label: 'Barber', riskTier: 'LOW', aliases: ['barber', 'barbering'] },
  hairdresser: { label: 'Hairdresser', riskTier: 'LOW', aliases: ['hairdresser', 'hair stylist', 'hairstylist'] },
  tutor: { label: 'Tutor', riskTier: 'LOW', aliases: ['tutor', 'tutoring'] },
  mover: { label: 'Mover', riskTier: 'LOW', aliases: ['mover', 'moving service', 'furniture mover'] },
} as const;

export type ServiceTradeId = keyof typeof SERVICE_TRADE_CATALOG;

function normalizeTradeAlias(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const SERVICE_TRADE_ALIASES = new Map<string, ServiceTradeId>();
for (const [tradeId, entry] of Object.entries(SERVICE_TRADE_CATALOG) as Array<[
  ServiceTradeId,
  (typeof SERVICE_TRADE_CATALOG)[ServiceTradeId],
]>) {
  SERVICE_TRADE_ALIASES.set(normalizeTradeAlias(tradeId), tradeId);
  for (const alias of entry.aliases) SERVICE_TRADE_ALIASES.set(normalizeTradeAlias(alias), tradeId);
}

/** Translate user-facing labels/legacy aliases to the one persisted trade ID. */
export function canonicalServiceTrade(input: string): ServiceTradeId | null {
  return SERVICE_TRADE_ALIASES.get(normalizeTradeAlias(input)) ?? null;
}

export function requireCanonicalServiceTrade(input: string): ServiceTradeId {
  const trade = canonicalServiceTrade(input);
  if (!trade) {
    throw new AppError(400, 'UNKNOWN_SERVICE_TRADE', 'Choose a service from Swift’s supported trade catalog.');
  }
  return trade;
}

export function serviceTradeLabel(trade: string): string {
  const canonical = canonicalServiceTrade(trade);
  return canonical ? SERVICE_TRADE_CATALOG[canonical].label : trade;
}

export function tradeRiskTier(trade: string): 'HIGH' | 'LOW' {
  const canonical = canonicalServiceTrade(trade);
  // Unknown trades are rejected at every request boundary. Fail high if an
  // internal caller nevertheless asks for guidance rather than understating risk.
  return canonical ? SERVICE_TRADE_CATALOG[canonical].riskTier : 'HIGH';
}

export function riskGuidance(trade: string): string {
  return tradeRiskTier(trade) === 'HIGH'
    ? 'Higher-risk work — we strongly recommend choosing a licensed (Certified) provider. Certified providers are shown first.'
    : 'Every provider is ID-verified and police-cleared — choose by ratings and reviews.';
}

/** A credential can only badge the exact trade selected when it was submitted.
 * GEI is specifically an electrician credential; generic qualifications still
 * require a trusted reviewer and remain bound to their submitted trade. */
export function qualificationTypeMatchesTrade(type: QualificationType, trade: ServiceTradeId): boolean {
  return type !== 'GEI_LICENCE' || trade === 'electrician';
}

/**
 * Booking reminders (master plan §4.3): both sides get ONE nudge in the 24h
 * before a confirmed slot. Covers service jobs (provider-confirmed) and
 * appointment bookings. Dedupe rides on the notification log (same pattern as
 * the verification expiry reminders) — no schema flags to keep in sync.
 */
export async function sendBookingReminders(
  prisma: PrismaClient,
  notify: (n: { userId: string; title: string; body: string; data: Record<string, unknown> }) => Promise<void>,
): Promise<number> {
  const now = new Date();
  const soon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  let sent = 0;

  const alreadyReminded = async (userId: string, kind: string, refId: string) => {
    const existing = await prisma.notification.findFirst({
      where: {
        userId,
        AND: [
          { data: { path: ['kind'], equals: kind } },
          { data: { path: ['refId'], equals: refId } },
        ],
      },
      select: { id: true },
    });
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
    const when = job.scheduledFor!.toLocaleString('en-GY', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    for (const [userId, body] of [
      [job.customerId, `Your ${job.provider.trade.toLowerCase()} is booked for ${when}. Cash on completion.`],
      [job.provider.userId, `You have a job booked for ${when}. Check the details in your jobs list.`],
    ] as Array<[string, string]>) {
      if (await alreadyReminded(userId, 'booking_reminder', job.id)) continue;
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
  const bookings = await prisma.booking.findMany({
    where: { status: 'CONFIRMED', slotStart: { gt: now, lte: soon } },
    include: { item: { select: { name: true, vendor: { select: { name: true, owner: { select: { userId: true } } } } } } },
  });
  for (const b of bookings) {
    const when = b.slotStart.toLocaleString('en-GY', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    for (const [userId, body] of [
      [b.customerId, `${b.item.name} at ${b.item.vendor.name} is booked for ${when}.`],
      [b.item.vendor.owner.userId, `${b.item.name} appointment coming up ${when}.`],
    ] as Array<[string, string]>) {
      if (await alreadyReminded(userId, 'booking_reminder', b.id)) continue;
      await notify({
        userId,
        title: 'Appointment tomorrow',
        body,
        data: { kind: 'booking_reminder', refId: b.id },
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
 * The full document checklist a provider must satisfy: the SERVICE_PROVIDER
 * base (identity + character) PLUS any trade-mandated extension from
 * CountryConfig (onboarding spec §3.5 — requirements are data, not code).
 * In Guyana that is exactly one trade: electrical work is illegal without a
 * GEI Electrical Contractor Licence, so electricians carry
 * `gei_electrical_licence` as a GATE, never a badge.
 */
export async function providerChecklist(prisma: ProviderVerificationDb, userId: string): Promise<string[]> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { countryCode: true } });
  if (!user) return [];
  const config = await prisma.countryConfig.findUnique({ where: { code: user.countryCode } });
  const lists = (config?.documentChecklists as Record<string, string[]>) ?? {};
  const base = lists['SERVICE_PROVIDER'] ?? [];
  const provider = await prisma.serviceProvider.findUnique({ where: { userId }, select: { trade: true } });
  const trade = provider?.trade ? canonicalServiceTrade(provider.trade) : null;
  if (!trade) return [];
  const extra = lists[tradeChecklistKey(trade)] ?? [];
  return [...new Set([...base, ...extra])];
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

  const approved = await prisma.verificationDocument.findMany({
    where: {
      userId,
      docType: { in: checklist },
      status: 'APPROVED',
      purgedAt: null,
      fileUrl: { not: '' },
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { OR: [{ retentionExpiresAt: null }, { retentionExpiresAt: { gt: now } }] },
      ],
    },
    select: { docType: true },
  });
  const have = new Set(approved.map((d) => d.docType));
  return checklist.every((docType) => have.has(docType));
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
          ...(trade === 'electrician' ? {} : { type: { not: 'GEI_LICENCE' } }),
        },
      })
    : 0;
  const selfSkilled = matchingQualificationCount === 0;

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

    const job = await tx.serviceJob.create({
      data: {
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
    return tx.serviceJob.update({ where: { id: job.id }, data: { chatRoomId: room.id } });
  });
}
