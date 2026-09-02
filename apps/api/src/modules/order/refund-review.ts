import type { PrismaClient } from '@prisma/client';
import { refundsAwaitingReviewGauge } from '../../plugins/observability';

/**
 * [M-33] Route missing snapshots to review. A return whose discount share
 * was INFERRED (no redemption snapshot — a legacy order), or a legacy return
 * recorded before the basis existed on a discounted order, is not settled on
 * the inferred number: it is counted here, published, and paged once a day
 * so a person recomputes it from the order and contacts the parties.
 */
export interface RefundReviewScan {
  inferredOpen: number;
  legacyOpen: number;
}

export async function scanInferredRefunds(prisma: PrismaClient): Promise<RefundReviewScan> {
  const [row] = await prisma.$queryRaw<Array<{ inferred_open: bigint; legacy_open: bigint }>>`
    SELECT
      count(*) FILTER (WHERE r."refundBasis" = 'INFERRED')::bigint AS inferred_open,
      count(*) FILTER (WHERE r."refundBasis" IS NULL AND o."discount" > 0)::bigint AS legacy_open
    FROM "return_requests" r
    JOIN "orders" o ON o."id" = r."orderId"
    WHERE r."status" = 'REQUESTED'`;
  const scan = { inferredOpen: Number(row?.inferred_open ?? 0), legacyOpen: Number(row?.legacy_open ?? 0) };
  refundsAwaitingReviewGauge.set(scan.inferredOpen + scan.legacyOpen);
  return scan;
}
