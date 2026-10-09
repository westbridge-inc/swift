import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { NotFoundError } from '../../utils/errors';

/** A stable one-way identifier for old and new reviews. CUIDs carry an exact
 * generation time; their public digest does not expose that timestamp. No
 * migration or new runtime key is required, and cached legacy IDs remain
 * accepted as inputs. Never return a canonical rating ID from these surfaces. */
export function publicVendorReviewId(id: string): string {
  return `rv_${createHash('sha256').update(`swift-review:${id}`).digest('base64url')}`;
}

/** Resolve only at an authenticated mutation door, then re-run its existing
 * publication/tenant/author authority checks. Vendor replies additionally
 * constrain this lookup to the selected store before reading any review. */
export async function resolveVendorReviewId(
  db: Pick<PrismaClient, '$queryRaw'>, suppliedId: string, vendorId?: string,
): Promise<string> {
  if (!suppliedId.startsWith('rv_')) return suppliedId;
  if (!/^rv_[A-Za-z0-9_-]{43}$/.test(suppliedId)) throw new NotFoundError('Review', suppliedId);
  const rows = vendorId === undefined
    ? await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM ratings WHERE
        'rv_' || rtrim(translate(encode(sha256(convert_to('swift-review:' || id, 'UTF8')), 'base64'), '+/', '-_'), '=') = ${suppliedId}
      LIMIT 1`
    : await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM ratings WHERE "vendorId" = ${vendorId} AND
        'rv_' || rtrim(translate(encode(sha256(convert_to('swift-review:' || id, 'UTF8')), 'base64'), '+/', '-_'), '=') = ${suppliedId}
      LIMIT 1`;
  if (!rows[0]) throw new NotFoundError('Review', suppliedId);
  return rows[0].id;
}

