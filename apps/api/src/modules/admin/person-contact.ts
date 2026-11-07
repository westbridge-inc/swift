import type { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../utils/errors';
import { maskPhone } from '../auth/step-up';
import { CUSTODY_CASE_ENTITY } from '../custody/custody-case';
import { capabilitiesOf, holdsCapability } from './admin-authority';
import { maskEmail } from './admin-email-change';
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

// ---------------------------------------------------------------------------
// [SEC-PII · security scan 28 Oct 2026] THE PERSON LISTS FOLLOW THE PAGES.
//
// The lists that lead to the pages above (GET /users, the people in /search,
// /riders, /drivers, /vendors, /vendors/pending) printed every row's full
// number and email to any grant that could open the list, so a grant refused
// the audited door could read, in bulk, what the door refuses it one person at
// a time. Each list now masks every row's numbers (the same helpers as the
// pages) and emails unless the caller's LIVE grant holds the matching contact
// capability. Searching by the full number still works server-side.
// ---------------------------------------------------------------------------

/** The contact capability that shows a list's rows in full: the same names the reveal doors demand. */
export const PERSON_CONTACT_CAPABILITIES = {
  user: 'user.contact.read',
  mover: 'mover.contact.read',
  vendor: 'vendor.contact.read',
} as const;
export type PersonContactKind = keyof typeof PERSON_CONTACT_CAPABILITIES;

/**
 * Does this request's LIVE grant hold the contact capability? The grant is the
 * one the admin capability hook read from the database for THIS request
 * (`request.adminPermissions`, the same read the route decision used), so a
 * revoked capability masks the very next list. No grant read (the hook did not
 * run) means masked: this never fails open.
 */
export function holdsPersonContact(request: unknown, kind: PersonContactKind): boolean {
  const req = request as { user?: { role?: string | null } | null; adminPermissions?: readonly string[] | null } | null;
  if (!req || req.adminPermissions === undefined) return false;
  const held = capabilitiesOf({ role: req.user?.role ?? null, permissions: req.adminPermissions });
  return holdsCapability(held, PERSON_CONTACT_CAPABILITIES[kind]);
}

/**
 * [SEC-PII · COORD ruling] A caller WITHOUT the contact capability does not search by number or email at all.
 * Any such search is an oracle over the masked row: a substring match recovers the number digit by digit, and
 * even an exact match leaves about a thousand guesses (the row shows the last digits and the name). So the
 * routes drop their phone and email clauses for that caller (names keep their search), and a query that looks
 * like a number or an address is answered with this hint instead of a silent "no match".
 */
export const CONTACT_SEARCH_HINT = {
  phoneOrEmail: 'Searching by phone number or email needs contact access.',
  phone: 'Searching by phone number needs contact access.',
} as const;

/**
 * The hint for a query that looks like a phone number (E.164 or a 7-digit local number: 7 to 15 digits, written
 * with digits, spaces, + ( ) - only) or, where emails are searched, an email (contains @). Never for an order
 * number or any other reference (letters in it), nor a short run of digits. [REVIEW-F #2170 S3-1]
 */
export function contactSearchHint(search: string | undefined, opts: { email: boolean }): string | undefined {
  if (!search) return undefined;
  const raw = search.trim();
  const digits = raw.replace(/\D/g, '').length;
  const phoneShaped = /^[+\d\s().-]+$/.test(raw) && digits >= 7 && digits <= 15;
  const looksLikeContact = phoneShaped || (opts.email && raw.includes('@'));
  if (!looksLikeContact) return undefined;
  return opts.email ? CONTACT_SEARCH_HINT.phoneOrEmail : CONTACT_SEARCH_HINT.phone;
}

const maskedEmail = (email: string | null | undefined) => (email ? maskEmail(email) : email ?? null);
type EmailHolder = { email?: string | null } | null | undefined;

/** A row with its own email masked ("o•••@example.com"). A new object; the input is untouched. */
function maskOwnEmail<T extends object>(row: T): T {
  const src = row as EmailHolder & object;
  return ('email' in src ? { ...src, email: maskedEmail(src.email) } : src) as T;
}

/** A person as a list row carries them: their number and their email masked. */
export function maskUserListRow<T extends object>(row: T): T {
  return maskOwnEmail(maskOwnPhone(row));
}

/** A rider or driver as a list row carries them: the person's number (and email, if selected) and the fee payer's number masked. */
export function maskMoverListRow<T extends object>(mover: T): T {
  const src = maskMoverPage(mover) as { user?: EmailHolder };
  return (src.user && 'email' in src.user ? { ...src, user: maskOwnEmail(src.user) } : src) as T;
}

/** A store as a list row carries it: every number the page masks, and the store's and its owner's emails. */
export function maskVendorListRow<T extends object>(vendor: T): T {
  const src = maskOwnEmail(maskVendorPhones(vendor)) as Record<string, unknown> & { owner?: { user?: EmailHolder } | null };
  return (src.owner?.user && 'email' in src.owner.user ? { ...src, owner: { ...src.owner, user: maskOwnEmail(src.owner.user) } } : src) as T;
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
