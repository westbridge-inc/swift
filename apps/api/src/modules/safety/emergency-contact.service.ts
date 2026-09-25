import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { AppError, NotFoundError, ForbiddenError } from '../../utils/errors';
import { generateOtp, storeOtp, verifyOtp, checkOtpRateLimit } from '../../utils/otp';
import { checkOtpDailyBudget } from '../../utils/sms-budget';
import { normalizePhone } from '../../utils/phone';
import type { NotificationChannels } from '../../providers/notifications/channels';
import { log } from '../../utils/logger';

// Emergency contacts (safety spec §5). A user lists the people who should be
// reached when they trigger an SOS. Each number is proven with a one-time SMS
// handshake — the contact receives a code and relays it to the owner — so a
// typo can't silently disable the feature and only reachable, aware numbers are
// stored. Fan-out on an ACTIVE alert (a later slice) reaches VERIFIED contacts
// in priority order.
//
// The confirmation SMS is a cost/abuse vector, so it wears the same armour as
// the auth OTP: the code is CSPRNG, hashed at rest, attempt-capped and
// constant-time compared (utils/otp), and the send is rate-limited AND
// daily-budgeted. Crucially the rate-limit keys on the TARGET PHONE, not the
// contact row — otherwise delete+re-add would mint a fresh key each time and let
// an authenticated user SMS-bomb any number.

const MAX_CONTACTS = Math.min(10, Math.max(1, Number(process.env['MAX_EMERGENCY_CONTACTS']) || 5));

// [Q9] An emergency contact is someone ELSE. The account's own number is
// refused at add, at verify and at resend, and skipped wherever an alert picks
// who to text: texting yourself during an emergency reaches nobody, and a code
// sent to your own phone would let you confirm a contact nobody else ever saw.
// Rows saved before this rule are kept as they are (no migration, nothing
// deleted); they are marked on read and never alerted. Every check compares
// against the phone the account holds NOW, so a number that becomes the
// owner's own later is caught by the same comparison.
export const EMERGENCY_CONTACT_IS_YOU = 'EMERGENCY_CONTACT_IS_YOU';
export const EMERGENCY_CONTACT_IS_YOU_MESSAGE = 'An emergency contact must be someone else. Enter their number, not yours.';

/** A phone as its digits: the platform normaliser (utils/phone), then the
 *  leading + dropped, so an account number stored without it is still the
 *  same number. Null for the erasure tombstone, which is not a phone. */
function phoneDigits(raw: string | null | undefined): string | null {
  if (!raw || raw.startsWith('deleted:')) return null;
  const digits = normalizePhone(raw).replace(/^\+/, '');
  return digits.length > 0 ? digits : null;
}

/** [Q9] True when a contact number is the account holder's own phone. */
export function isOwnNumber(contactPhoneE164: string, ownPhone: string | null | undefined): boolean {
  const own = phoneDigits(ownPhone);
  return own !== null && own === phoneDigits(contactPhoneE164);
}

export interface AddContactInput {
  userId: string;
  name: string;
  phoneE164: string;
  relationship?: string | null;
  priority?: number | null;
}

export class EmergencyContactService {
  constructor(private prisma: PrismaClient, private redis: Redis, private channels: NotificationChannels) {}

  /** Per-contact key for the confirmation code (each row verifies independently). */
  private codeKey(contactId: string) { return `ec:${contactId}`; }
  /** Per-PHONE key for the anti-bomb rate-limit (survives delete+re-add). */
  private smsKey(phoneE164: string) { return `ec:${phoneE164}`; }

  /** [Q9] `isOwnNumber` marks a row saved before the own-number rule (or one
   *  the owner's current phone now matches): it stays listed, and is never alerted. */
  async list(userId: string) {
    const [owner, rows] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } }),
      this.prisma.emergencyContact.findMany({
        where: { userId },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    return rows.map((c) => ({ ...c, isOwnNumber: isOwnNumber(c.phoneE164, owner?.phone) }));
  }

  /** [Q9] Refuse the account's own number, read fresh on every call. */
  private async refuseOwnNumber(userId: string, phoneE164: string): Promise<void> {
    const owner = await this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (isOwnNumber(phoneE164, owner?.phone)) {
      throw new AppError(422, EMERGENCY_CONTACT_IS_YOU, EMERGENCY_CONTACT_IS_YOU_MESSAGE);
    }
  }

  /** Add (or update) a contact. Upsert on (userId, phoneE164): re-adding a number
   *  refreshes its details WITHOUT dropping a prior verification (the number is
   *  unchanged). A code is sent only when the contact is not yet verified, and
   *  best-effort — a rate-limit must not fail the save (use resend() to force).
   *  [Q9] The account's own number is refused first: no row, no code. */
  async add(input: AddContactInput): Promise<{ contact: Awaited<ReturnType<PrismaClient['emergencyContact']['upsert']>>; codeSent: boolean }> {
    await this.refuseOwnNumber(input.userId, input.phoneE164);
    const priority = Math.min(3, Math.max(1, Math.trunc(input.priority ?? 1)));
    const existing = await this.prisma.emergencyContact.findUnique({
      where: { userId_phoneE164: { userId: input.userId, phoneE164: input.phoneE164 } },
    });
    if (!existing) {
      const count = await this.prisma.emergencyContact.count({ where: { userId: input.userId } });
      if (count >= MAX_CONTACTS) {
        throw new AppError(422, 'TOO_MANY_CONTACTS', `You can have at most ${MAX_CONTACTS} emergency contacts.`);
      }
    }
    const contact = await this.prisma.emergencyContact.upsert({
      where: { userId_phoneE164: { userId: input.userId, phoneE164: input.phoneE164 } },
      create: { userId: input.userId, name: input.name, phoneE164: input.phoneE164, relationship: input.relationship ?? null, priority },
      update: { name: input.name, relationship: input.relationship ?? null, priority }, // preserve verifiedAt — same number
    });

    let codeSent = false;
    if (!contact.verifiedAt) {
      try {
        await this.sendCode(contact.id, contact.phoneE164, input.userId);
        codeSent = true;
      } catch (e) {
        if (!(e instanceof AppError && e.statusCode === 429)) throw e; // 429 (recent send) is fine on add
      }
    }
    return { contact, codeSent };
  }

  /** Send/refresh the confirmation code to the contact's phone. Rate-limited
   *  1/min per target phone and counted against the shared daily SMS budget. */
  async sendCode(contactId: string, phoneE164: string, ownerUserId: string): Promise<void> {
    const allowed = await checkOtpRateLimit(this.redis, this.smsKey(phoneE164));
    if (!allowed) throw new AppError(429, 'RATE_LIMITED', 'Please wait a moment before requesting another confirmation code.');
    const budget = await checkOtpDailyBudget(this.redis, phoneE164);
    if (!budget.allowed) throw new AppError(429, 'SMS_BUDGET_EXCEEDED', 'This number has received too many messages today. Try again tomorrow.');

    const owner = await this.prisma.user.findUnique({ where: { id: ownerUserId }, select: { firstName: true } });
    const ownerName = owner?.firstName?.trim() || 'A Swift user';
    const code = generateOtp();
    await storeOtp(this.redis, this.codeKey(contactId), code);
    try {
      await this.channels.sms.sendSms(
        phoneE164,
        `${ownerName} added you as their Swift emergency contact — you'll be alerted if they trigger an SOS. Confirm with code ${code}. Didn't expect this? Ignore this message.`,
      );
    } catch (err) {
      log().error({ err, contactId }, 'emergency-contact: confirmation SMS failed');
      throw new AppError(502, 'SMS_SEND_FAILED', "We couldn't send the confirmation code right now. Please try again in a moment.");
    }
  }

  /** Explicit resend (owner-initiated). Surfaces the rate-limit as a 429.
   *  [Q9] Never to the account's own number, even on a row saved before the rule. */
  async resend(userId: string, contactId: string) {
    const contact = await this.owned(userId, contactId);
    await this.refuseOwnNumber(userId, contact.phoneE164);
    if (contact.verifiedAt) return contact; // already proven — nothing to send
    await this.sendCode(contact.id, contact.phoneE164, userId);
    return contact;
  }

  /** Confirm the code the contact relayed. Idempotent once verified.
   *  [Q9] Refused before the idempotent answer, so an own-number row never
   *  reads as confirmed, even one confirmed before the rule existed. */
  async verify(userId: string, contactId: string, code: string) {
    const contact = await this.owned(userId, contactId);
    await this.refuseOwnNumber(userId, contact.phoneE164);
    if (contact.verifiedAt) return contact;
    const result = await verifyOtp(this.redis, this.codeKey(contactId), code);
    if (!result.valid) throw new AppError(400, 'INVALID_CODE', result.reason || 'Invalid or expired code.');
    return this.prisma.emergencyContact.update({ where: { id: contactId }, data: { verifiedAt: new Date() } });
  }

  async remove(userId: string, contactId: string) {
    await this.owned(userId, contactId);
    await this.prisma.emergencyContact.delete({ where: { id: contactId } });
  }

  private async owned(userId: string, contactId: string) {
    const c = await this.prisma.emergencyContact.findUnique({ where: { id: contactId } });
    if (!c) throw new NotFoundError('EmergencyContact', contactId);
    if (c.userId !== userId) throw new ForbiddenError('This is not your contact.');
    return c;
  }
}
