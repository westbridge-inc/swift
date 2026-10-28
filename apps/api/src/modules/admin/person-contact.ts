import type { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../utils/errors';
import { maskPhone } from '../auth/step-up';
import { CUSTODY_CASE_ENTITY } from '../custody/custody-case';
import { assertReason, recordPhoneReveal, type PhoneRevealSubject } from './order-contact';

// ---------------------------------------------------------------------------
// [FOLLOWUPS · COORD ruling 28 Oct 2026, owner delegated; follows O-1] THE
// PERSON PAGES SHOW PHONE NUMBERS MASKED; THE FULL NUMBER IS AN AUDITED REVEAL.
//
// O-1 masked the order desk (order-contact.ts). The console still printed the
// FULL number on four pages: a person (users/:id), a store (vendors/:id: the
// owner and the store line), a rider or driver (riders/:id, drivers/:id), and a
// custody case (custody-cases/:id: the rider holding the goods and the relay
// rider). The same rule now holds there, by the same door:
//
//   - each page's read returns the phone MASKED (maskPhone: +592•••••1234);
//   - its own reveal route returns the full number of ONE party, and only with
//     a stated reason (x-swift-reason, 12-500 characters) and after the audit
//     row is WRITTEN (order-contact.ts recordPhoneReveal: the same rows,
//     REVEAL_PARTY_PHONE / REVEAL_PARTY_PHONE_MISS, never the number itself);
//   - each reveal reads the record exactly the way its page does (the same
//     model, the same id, the same tenant filter), so it reaches no person
//     the page could not show;
//   - who may reveal is its own capability per page (user / vendor / mover /
//     custody .contact.read, like order.contact.read): a grant that reads the
//     page (user.read, ...) sees the masked number and is refused the reveal.
// ---------------------------------------------------------------------------

const masked = (phone: string | null | undefined) => (phone ? maskPhone(phone) : phone ?? null);
type PhoneHolder = { phone?: string | null } | null | undefined;

/** A row with its own phone masked (a user). A new object; the input is untouched. */
export function maskOwnPhone<T extends object>(row: T): T {
  const src = row as PhoneHolder & object;
  return ('phone' in src ? { ...src, phone: masked(src.phone) } : src) as T;
}

/** A row whose `user` carries the phone (a rider, a driver, a custody case's holder or relay rider). */
export function maskUserPhone<T extends object | null>(row: T): T {
  if (!row) return row;
  const src = row as { user?: PhoneHolder };
  return (src.user && 'phone' in src.user ? { ...src, user: { ...src.user, phone: masked(src.user.phone) } } : src) as T;
}

/**
 * [REVIEW-M/G #2162 S3-1, M S4-1] A fee subscription as a person page carries it: the MMG payer's number (for a mover
 * paying from their own phone, it IS their number) masked, and the card token never (null while cards are off).
 */
export function maskSubscription<T>(sub: T): T {
  if (!sub || typeof sub !== 'object') return sub;
  const copy: Record<string, unknown> = { ...(sub as Record<string, unknown>) };
  delete copy['paymentToken'];
  if ('mmgPayerMsisdn' in copy) copy['mmgPayerMsisdn'] = masked(copy['mmgPayerMsisdn'] as string | null | undefined);
  return copy as T;
}

/** A person's detail: their number, and the number each cash strike recorded (theirs, at the door), masked. */
export function maskPersonPage<T extends object>(user: T): T {
  const src = maskOwnPhone(user) as { strikes?: PhoneHolder[] };
  return (Array.isArray(src.strikes) ? { ...src, strikes: src.strikes.map((strike) => (strike ? maskOwnPhone(strike) : strike)) } : src) as T;
}

/** A rider's or driver's detail: their number and their fee subscription's payer number masked. */
export function maskMoverPage<T extends object>(mover: T): T {
  const src = maskUserPhone(mover) as { subscription?: unknown };
  return ('subscription' in src ? { ...src, subscription: maskSubscription(src.subscription) } : src) as T;
}

/** A store's detail: its own line, its owner's number, its MMG number (live and pending) and its fee subscription's
 *  payer number masked. The public phone customers call stays as published. */
export function maskVendorPhones<T extends object>(vendor: T): T {
  const src = maskOwnPhone(vendor) as Record<string, unknown> & { owner?: { user?: PhoneHolder } | null };
  const out: Record<string, unknown> = { ...src };
  if (src.owner) out['owner'] = maskUserPhone(src.owner);
  for (const key of ['mmgNumber', 'mmgNumberPending'] as const) if (key in src) out[key] = masked(src[key] as string | null | undefined);
  if ('subscription' in src) out['subscription'] = maskSubscription(src['subscription']);
  return out as T;
}

/** A custody case's detail: the holder's and the relay rider's numbers masked. */
export function maskCaseRiderPhones<T extends { holder?: unknown; relay?: unknown }>(kase: T): T {
  return { ...kase, holder: maskUserPhone(kase.holder as object | null), relay: maskUserPhone(kase.relay as object | null) };
}

export const VENDOR_CONTACT_PARTIES = ['owner', 'store'] as const;
export type VendorContactParty = (typeof VENDOR_CONTACT_PARTIES)[number];
export const CUSTODY_CONTACT_PARTIES = ['holder', 'relay'] as const;
export type CustodyContactParty = (typeof CUSTODY_CONTACT_PARTIES)[number];

export type PersonContactTarget =
  | { page: 'user'; id: string }
  | { page: 'vendor'; id: string; party: VendorContactParty }
  | { page: 'rider' | 'driver'; id: string; tenantId: string }
  | { page: 'custody'; id: string; party: CustodyContactParty };

export interface PersonContactInput {
  target: PersonContactTarget;
  actorId: string;
  reason: string | null;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface PersonContactResult {
  party: string;
  phone: string;
  /** The audit row this read is recorded in, quoted back so the operator sees it is logged. */
  auditId: string;
}

const userSubject = (user: { id: string; phone: string | null } | null | undefined): PhoneRevealSubject =>
  (user ? { holder: 'user', id: user.id, phone: user.phone } : null);

/** One party's full number from a person page, after its read is recorded. */
export async function revealPersonPhone(deps: { prisma: PrismaClient }, input: PersonContactInput): Promise<PersonContactResult> {
  const reason = assertReason(input.reason);
  const { target } = input;
  const audit = { userId: input.actorId, ipAddress: input.ip, userAgent: input.userAgent };
  const reveal = async (party: string, entity: string, entityId: string, subject: PhoneRevealSubject, missMessage: string) => ({
    party,
    ...(await recordPhoneReveal(deps, { subject, audit: { ...audit, entity, entityId }, changes: { reason, party }, missMessage })),
  });

  switch (target.page) {
    case 'user': {
      // The page's read: GET /users/:id (user.findUnique by id, tenant-scoped by the client).
      const user = await deps.prisma.user.findUnique({ where: { id: target.id }, select: { id: true, phone: true } });
      if (!user) throw new NotFoundError('User', target.id);
      return reveal('person', 'User', user.id, userSubject(user), 'This person has no phone number on file.');
    }
    case 'vendor': {
      // The page's read: GET /vendors/:id (vendor.findUnique by id).
      const vendor = await deps.prisma.vendor.findUnique({
        where: { id: target.id },
        select: { id: true, phone: true, owner: { select: { user: { select: { id: true, phone: true } } } } },
      });
      if (!vendor) throw new NotFoundError('Vendor', target.id);
      const subject: PhoneRevealSubject = target.party === 'store'
        ? { holder: 'vendor', id: vendor.id, phone: vendor.phone }
        : userSubject(vendor.owner?.user);
      return reveal(target.party, 'Vendor', vendor.id, subject, target.party === 'store' ? 'This store has no phone number on file.' : 'This store has no owner number on file.');
    }
    case 'rider':
    case 'driver': {
      // The page's read: GET /riders/:id, GET /drivers/:id (findFirst by id AND the caller's tenant).
      const where = { id: target.id, user: { tenantId: target.tenantId } };
      const select = { id: true, user: { select: { id: true, phone: true } } } as const;
      const mover = target.page === 'rider'
        ? await deps.prisma.rider.findFirst({ where, select })
        : await deps.prisma.driver.findFirst({ where, select });
      if (!mover) throw new NotFoundError(target.page === 'rider' ? 'Rider' : 'Driver', target.id);
      return reveal('mover', target.page === 'rider' ? 'Rider' : 'Driver', mover.id, userSubject(mover.user), 'This mover has no phone number on file.');
    }
    case 'custody': {
      // The page's read: GET /custody-cases/:id (caseDetail: the case by id, then its holder and relay riders).
      const kase = await deps.prisma.custodyRecoveryCase.findUnique({ where: { id: target.id }, select: { id: true, holderRiderId: true, relayRiderId: true } });
      if (!kase) throw new NotFoundError('RecoveryCase', target.id);
      const riderId = target.party === 'holder' ? kase.holderRiderId : kase.relayRiderId;
      const rider = riderId ? await deps.prisma.rider.findUnique({ where: { id: riderId }, select: { user: { select: { id: true, phone: true } } } }) : null;
      return reveal(target.party, CUSTODY_CASE_ENTITY, kase.id, userSubject(rider?.user), target.party === 'holder' ? 'This case has no number for the rider holding the goods.' : 'This case has no relay rider number.');
    }
  }
}
