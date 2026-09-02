import type { PrismaClient } from '@prisma/client';
import { adCheckoutGauge } from '../../plugins/observability';

/** [R045-ADS-04 · 05 · operations] Paid campaigns lacking confirmed inventory
 *  (the hybrid the aggregate lock forbids — legacy rows, or a bug), and
 *  campaigns holding more than one active invoice. Reported and paged; the
 *  remedy — stop serving, refund or re-book — is a person's decision. */
export interface AdCheckoutScan {
  paidWithoutInventory: Array<{ campaignId: string; status: string; invoiceId: string }>;
  duplicateActiveInvoices: Array<{ campaignId: string; invoices: number }>;
}

export async function scanAdCheckout(prisma: PrismaClient): Promise<AdCheckoutScan> {
  const paidWithoutInventory = await prisma.$queryRaw<Array<{ campaignId: string; status: string; invoiceId: string }>>`
    SELECT c."id" AS "campaignId", c."status"::text AS status, i."id" AS "invoiceId"
    FROM "ad_campaigns" c
    JOIN "ad_invoices" i ON i."campaignId" = c."id" AND i."status" IN ('PAID', 'PARTIALLY_REFUNDED')
    WHERE c."status" IN ('PENDING_REVIEW', 'SCHEDULED', 'LIVE', 'PAUSED')
      AND NOT EXISTS (SELECT 1 FROM "ad_bookings" b WHERE b."campaignId" = c."id" AND b."status" = 'CONFIRMED')
    ORDER BY i."paidAt" DESC LIMIT 200`;
  const duplicateActiveInvoices = await prisma.$queryRaw<Array<{ campaignId: string; invoices: bigint }>>`
    SELECT "campaignId", count(*)::bigint AS invoices FROM "ad_invoices" WHERE "status" <> 'VOID' GROUP BY "campaignId" HAVING count(*) > 1 LIMIT 200`;
  const scan: AdCheckoutScan = { paidWithoutInventory, duplicateActiveInvoices: duplicateActiveInvoices.map((d) => ({ campaignId: d.campaignId, invoices: Number(d.invoices) })) };
  adCheckoutGauge.labels('paid_without_inventory').set(scan.paidWithoutInventory.length);
  adCheckoutGauge.labels('duplicate_active_invoices').set(scan.duplicateActiveInvoices.length);
  return scan;
}
