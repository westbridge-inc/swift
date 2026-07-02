import type { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Services vertical (spec §4.6). Trust is risk-tiered: verify hard where someone
// could be physically harmed. Every provider needs ID + police clearance; a
// trade qualification is an optional "Certified" badge. Providers without one
// can still join, shown transparently as "self-skilled".
// ---------------------------------------------------------------------------

/** Trades where bad work can cause physical harm — surfaced with a strong
 *  "choose a licensed provider" message; licensed providers are listed first. */
const HIGH_RISK_TRADES = new Set(['electrician', 'electrical', 'gas', 'gas_fitter', 'plumber', 'plumbing']);

export function tradeRiskTier(trade: string): 'HIGH' | 'LOW' {
  return HIGH_RISK_TRADES.has(trade.trim().toLowerCase()) ? 'HIGH' : 'LOW';
}

export function riskGuidance(trade: string): string {
  return tradeRiskTier(trade) === 'HIGH'
    ? 'Higher-risk work — we strongly recommend choosing a licensed (Certified) provider. Certified providers are shown first.'
    : 'Every provider is ID-verified and police-cleared — choose by ratings and reviews.';
}

/**
 * Government Electrical Inspectorate registry check (spec §3.4). The live GEI
 * registry is a CountryConfig verificationSource; here we accept a plausible
 * reference and otherwise leave the qualification for manual review.
 */
export function geiRegistryCheck(referenceNumber: string | undefined | null): boolean {
  return Boolean(referenceNumber && /^[A-Za-z0-9-]{5,}$/.test(referenceNumber));
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

/**
 * A provider may operate live only when ID + police clearance are approved
 * (the SERVICE_PROVIDER checklist). Mirrors the verification gate without
 * coupling to the vendor-oriented ChecklistRole type.
 */
export async function isProviderVerified(prisma: PrismaClient, userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { countryCode: true } });
  if (!user) return false;
  const config = await prisma.countryConfig.findUnique({ where: { code: user.countryCode } });
  const checklist = ((config?.documentChecklists as Record<string, string[]>) ?? {})['SERVICE_PROVIDER'] ?? [];
  if (checklist.length === 0) return false;

  const approved = await prisma.verificationDocument.findMany({
    where: {
      userId,
      docType: { in: checklist },
      status: 'APPROVED',
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { docType: true },
  });
  const have = new Set(approved.map((d) => d.docType));
  return checklist.every((docType) => have.has(docType));
}
