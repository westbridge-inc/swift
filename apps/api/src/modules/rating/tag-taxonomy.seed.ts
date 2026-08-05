import type { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Movement R — the tag taxonomy (R4), seeded EXACTLY, per subject role.
// 1–3★ shows the NEGATIVE set ("What went wrong?"); 4–5★ the POSITIVE set
// ("What was great?"). Slugs immutable; labels admin-editable; the customer
// `payment-issue` tag is a first-class risk-score input (wired in R5).
// ---------------------------------------------------------------------------

type Row = [slug: string, label: string];

const TAXONOMY: Record<string, { positive: Row[]; negative: Row[] }> = {
  VENDOR: {
    positive: [
      ['tasty-food', 'Tasty food'], ['great-value', 'Great value'], ['order-accurate', 'Order was right'],
      ['well-packaged', 'Well packaged'], ['fresh-items', 'Fresh items'], ['fast-prep', 'Ready fast'],
    ],
    negative: [
      ['missing-items', 'Missing items'], ['wrong-item', 'Wrong item'], ['cold-food', 'Arrived cold'],
      ['poor-packaging', 'Poor packaging'], ['long-wait', 'Long wait'], ['not-as-described', 'Not as described'],
    ],
  },
  RIDER: {
    positive: [
      ['on-time', 'On time'], ['friendly', 'Friendly'], ['careful-handling', 'Handled with care'], ['good-comms', 'Kept me updated'],
    ],
    negative: [
      ['late', 'Late'], ['rude', 'Rude'], ['rough-handling', 'Poor handling'], ['handover-issue', 'Handover problem'],
    ],
  },
  DRIVER: {
    positive: [
      ['safe-driving', 'Safe driving'], ['clean-vehicle', 'Clean vehicle'], ['on-time', 'On time'],
      ['friendly', 'Friendly'], ['fair-route', 'Good route'],
    ],
    negative: [
      ['unsafe-driving', 'Unsafe driving'], ['vehicle-condition', 'Vehicle condition'], ['late-pickup', 'Late pickup'],
      ['rude', 'Rude'], ['long-route', 'Took a long route'],
    ],
  },
  SERVICE_PROVIDER: {
    positive: [
      ['quality-work', 'Quality work'], ['on-time', 'On time'], ['fair-price', 'Fair price'],
      ['professional', 'Professional'], ['left-clean', 'Left it clean'],
    ],
    negative: [
      ['poor-quality', 'Poor quality work'], ['late-noshow', 'Late or no-show'], ['overcharged', 'Charged more than agreed'],
      ['unprofessional', 'Unprofessional'], ['left-mess', 'Left a mess'],
    ],
  },
  CUSTOMER: {
    positive: [
      ['respectful', 'Respectful'], ['ready-on-time', 'Was ready'],
    ],
    negative: [
      ['kept-waiting', 'Kept me waiting'], ['disrespectful', 'Disrespectful'],
      ['payment-issue', 'Payment problem'], ['address-wrong', 'Address was wrong'],
    ],
  },
};

export function seedRows(): Array<{ role: string; slug: string; label: string; sentiment: 'POSITIVE' | 'NEGATIVE' }> {
  const out: Array<{ role: string; slug: string; label: string; sentiment: 'POSITIVE' | 'NEGATIVE' }> = [];
  for (const [role, sets] of Object.entries(TAXONOMY)) {
    for (const [slug, label] of sets.positive) out.push({ role, slug, label, sentiment: 'POSITIVE' });
    for (const [slug, label] of sets.negative) out.push({ role, slug, label, sentiment: 'NEGATIVE' });
  }
  return out;
}

/** Idempotent per tenant; label edits by admins survive re-seeds. */
export async function seedRatingTags(prisma: PrismaClient, tenantId = 'swift-default'): Promise<{ created: number }> {
  let created = 0;
  for (const row of seedRows()) {
    const existing = await prisma.ratingTagDef.findUnique({
      where: { tenantId_role_slug: { tenantId, role: row.role, slug: row.slug } },
    });
    if (existing) continue;
    await prisma.ratingTagDef.create({ data: { tenantId, ...row } });
    created += 1;
  }
  return { created };
}

/** The valid tag slugs for one subject role + star band (service validation). */
export async function tagsForRole(prisma: PrismaClient, role: string, stars: number, tenantId = 'swift-default'): Promise<Set<string>> {
  const sentiment = stars <= 3 ? 'NEGATIVE' : 'POSITIVE';
  const rows = await prisma.ratingTagDef.findMany({ where: { tenantId, role, sentiment }, select: { slug: true } });
  return new Set(rows.map((r) => r.slug));
}
