/**
 * [VERIFY-DOCS V3] THE DOCUMENT REVIEWER GRANT — who may open, approve or
 * reject a person's documents.
 *
 * Owner rulings, 6 Oct 2026: only a verification reviewer opens documents;
 * opening, approving and rejecting all need an explicit grant that `*` and the
 * role defaults never imply; a SUPER_ADMIN may grant it to themselves with a
 * recorded reason; one grant at launch; shadow mode never relaxes it.
 *
 * The grant is the `documents.review` entry in `Admin.permissions` (no new
 * role, no migration). The capability engine (admin-authority.ts) decides it
 * on the four document doors; this module holds what the engine cannot:
 *
 *   - the render route's re-check. A view link is minted FOR a reviewer and
 *     names them; every load re-reads that reviewer's grant, role, status and
 *     tenant, so revoking the grant — or suspending or demoting the reviewer —
 *     kills links that are already open, instead of leaving a five-minute
 *     bearer token in the wild.
 *   - the legacy pointers. Rider/Driver rows still carry the client-written
 *     document fields of the pre-registry upload path. An admin response that
 *     includes a mover row would hand them to any operator; they are withheld
 *     unless the caller holds the grant.
 *   - granting and revoking, as one locked read-modify-write of the grant list.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { DOCUMENT_REVIEWER_CAPABILITY } from './admin-authority';

export { DOCUMENT_REVIEWER_CAPABILITY };

export const DOCUMENT_REVIEWER_REQUIRED = 'DOCUMENT_REVIEWER_REQUIRED';
/** What the console shows. Plain words, and it says what to do next. */
export const DOCUMENT_REVIEWER_MESSAGE =
  'You need the document-reviewer permission — ask a super-admin, or grant it to yourself in Staff & roles';

export function documentReviewerRequired(): AppError {
  return new AppError(403, DOCUMENT_REVIEWER_REQUIRED, DOCUMENT_REVIEWER_MESSAGE);
}

const STAFF_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const;

/** The grant is held only by its exact name — never by `*` or a wildcard. */
export function holdsDocumentReviewerGrant(permissions: readonly string[] | null | undefined): boolean {
  return Array.isArray(permissions) && permissions.includes(DOCUMENT_REVIEWER_CAPABILITY);
}

/**
 * Is this person, right now, an active document reviewer for the owner of the
 * document? Read live on every render: the grant, the staff role they are
 * acting in, an account that has not been cut off, and the same tenant as the
 * person whose document it is.
 */
export async function isActiveDocumentReviewer(
  prisma: Pick<PrismaClient, 'user'>,
  reviewerUserId: string,
  documentOwnerUserId: string,
): Promise<boolean> {
  const reviewer = await prisma.user.findUnique({
    where: { id: reviewerUserId },
    select: { activeRole: true, status: true, tenantId: true, admin: { select: { permissions: true } } },
  }) as { activeRole: string | null; status: string; tenantId: string; admin: { permissions: string[] } | null } | null;
  if (!reviewer) return false;
  if (!(STAFF_ROLES as readonly string[]).includes(reviewer.activeRole ?? '')) return false;
  // Only an ACTIVE account reviews: suspended, banned, deactivated and
  // not-yet-verified accounts are all refused.
  if (reviewer.status !== 'ACTIVE') return false;
  if (!holdsDocumentReviewerGrant(reviewer.admin?.permissions)) return false;
  const owner = await prisma.user.findUnique({ where: { id: documentOwnerUserId }, select: { tenantId: true } });
  return !!owner && owner.tenantId === reviewer.tenantId;
}

/**
 * The legacy, client-written document pointers on mover rows (rider.routes /
 * driver.routes accept them as free strings, outside the document registry).
 * Withheld from every admin response unless the caller holds the grant.
 */
export const LEGACY_DOCUMENT_POINTERS: readonly string[] = [
  'nationalIdUrl', 'driverLicenseUrl', 'vehicleInsuranceUrl', 'vehicleInspectionUrl', 'idDocumentUrl', 'selfieUrl',
];
const POINTER_SET = new Set(LEGACY_DOCUMENT_POINTERS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A copy of `payload` without any legacy document pointer, at any depth.
 * Copy-on-write: an object with nothing to remove is returned as itself, so
 * a cached object is never mutated. Only plain objects and arrays are walked
 * (a Date, a Decimal or a Buffer is a value, not a container).
 */
export function withoutLegacyDocumentPointers<T>(payload: T): T {
  const seen = new WeakMap<object, unknown>();
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (seen.has(value)) return seen.get(value);
      seen.set(value, value);
      let changed = false;
      const out = value.map((item) => {
        const next = walk(item);
        if (next !== item) changed = true;
        return next;
      });
      const result = changed ? out : value;
      seen.set(value, result);
      return result;
    }
    if (!isPlainObject(value)) return value;
    if (seen.has(value)) return seen.get(value);
    seen.set(value, value);
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (POINTER_SET.has(key)) { changed = true; continue; }
      const next = walk(child);
      if (next !== child) changed = true;
      out[key] = next;
    }
    const result = changed ? out : value;
    seen.set(value, result);
    return result;
  };
  return walk(payload) as T;
}

export interface ReviewerGrantChange {
  readonly userId: string;
  readonly documentReviewer: boolean;
  readonly changed: boolean;
}

/**
 * Grant or revoke, inside the caller's transaction, under a row lock on the
 * target's Admin row so two decisions cannot interleave their list edits.
 * Granting adds the entry beside whatever the list holds (it never narrows);
 * revoking removes exactly that entry and nothing else. Granting to an admin
 * with no Admin row creates one holding only the grant — their reach stays
 * the role's container (capabilitiesOf). Revoking from no row changes nothing.
 */
export async function setDocumentReviewerGrant(
  tx: Prisma.TransactionClient,
  targetUserId: string,
  grant: boolean,
): Promise<ReviewerGrantChange> {
  await tx.$queryRaw`SELECT "id" FROM "admins" WHERE "userId" = ${targetUserId} FOR UPDATE`;
  const row = await tx.admin.findUnique({ where: { userId: targetUserId }, select: { permissions: true } });
  const current = row?.permissions ?? [];
  const holds = holdsDocumentReviewerGrant(current);
  if (holds === grant) return { userId: targetUserId, documentReviewer: holds, changed: false };
  if (grant) {
    if (row) await tx.admin.update({ where: { userId: targetUserId }, data: { permissions: [...current, DOCUMENT_REVIEWER_CAPABILITY] } });
    else await tx.admin.create({ data: { userId: targetUserId, permissions: [DOCUMENT_REVIEWER_CAPABILITY] } });
  } else {
    await tx.admin.update({ where: { userId: targetUserId }, data: { permissions: current.filter((p) => p !== DOCUMENT_REVIEWER_CAPABILITY) } });
  }
  return { userId: targetUserId, documentReviewer: grant, changed: true };
}
