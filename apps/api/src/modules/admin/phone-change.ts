import type { FastifyBaseLogger } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { AppError, NotFoundError } from '../../utils/errors';
import { generateOtp, storeOtp, verifyOtp } from '../../utils/otp';
import { normalizePhone } from '../../utils/phone';
import { checkOtpDailyBudget } from '../../utils/sms-budget';
import { bindTenantTransaction } from '../../plugins/prisma';
import { runAsSystem } from '../../plugins/tenant-context';
import { publicLaunchCountryFromPhone } from '../auth/launch-market';
import type { NotificationChannels } from '../../providers/notifications/channels';
import { refuseStaffAccount } from './admin-email-change';
import { suspendedByEnforcement } from '../user/verified-deletion-gate';

/**
 * [BUG-HUNT F22 · COORD 4 Nov 2026] A person whose SIM or number changes had no door anywhere: the phone number IS the
 * sign-in, so this door hands over a whole account. A code to the new number proves somebody holds it, not who they
 * are, so one member of staff is never enough: asking takes a reason and a second person (C5), and only then does the
 * code go out. Staff accounts are refused for everyone, and so are a closed or banned account and one suspended by
 * enforcement or safety, on the row read under the lock when the code goes out and again when the account moves. The
 * move and the end of every session are one commit. The old number is told before the write, where it can be reached. The trail names the last four digits only.
 */
const CODE_LIFE_S = 300;
const pendingKey = (userId: string) => `phone_change:${userId}`;
const codeKey = (userId: string, phone: string) => `phone-change:${userId}:${phone}`;

/** Runs `write` under the person's lock and ends every session in the same commit (AuthService.logoutAll). */
type MoveWithSessions = (write: (tx: Prisma.TransactionClient) => Promise<void>) => Promise<void>;

interface PhoneChangeDeps {
  prisma: PrismaClient;
  redis: Redis;
  channels: Pick<NotificationChannels, 'sms'>;
  log: Pick<FastifyBaseLogger, 'warn'>;
}

export const lastFour = (phone: string) => phone.slice(-4);

const PERSON = { phone: true, status: true, roles: true, activeRole: true } as const;
type Person = Prisma.UserGetPayload<{ select: typeof PERSON }>;

function numberMayMove(person: Person | null, userId: string): Person {
  if (!person) throw new NotFoundError('User', userId);
  refuseStaffAccount(person);
  if (person.phone.startsWith('deleted:') || person.status === 'DEACTIVATED') {
    throw new AppError(409, 'ACCOUNT_CLOSED', 'This account has been closed. Its number cannot be changed.');
  }
  if (person.status === 'BANNED') {
    throw new AppError(409, 'ACCOUNT_BANNED', 'A banned account keeps its number, so that number cannot sign up again.');
  }
  return person;
}

async function lockedPerson(tx: Prisma.TransactionClient, userId: string): Promise<Person> {
  await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
  const person = numberMayMove(await tx.user.findUnique({ where: { id: userId }, select: PERSON }), userId);
  // A number that moves is a number free to sign up again: a suspension must not walk away from itself.
  if (await suspendedByEnforcement(tx, { id: userId, status: person.status })) {
    throw new AppError(409, 'SUSPENDED_BY_ENFORCEMENT', 'This account was suspended by enforcement or safety, so it keeps its number. This one goes to the owner.');
  }
  return person;
}

/** Send the code to the new number. Nothing about the account changes yet. `within` is the trail, in the checks' commit. */
export async function startPhoneChange(
  deps: PhoneChangeDeps,
  input: { userId: string; phone: string; ip: string; within: (tx: Prisma.TransactionClient) => Promise<void> },
): Promise<{ expiresIn: number }> {
  const phone = normalizePhone(input.phone);
  if (!publicLaunchCountryFromPhone(phone)) throw new AppError(400, 'COUNTRY_NOT_ACTIVE', 'Swift is currently available in Guyana only');
  await deps.prisma.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    const person = await lockedPerson(tx, input.userId);
    if (person.phone === phone) throw new AppError(409, 'SAME_PHONE', 'This account already uses that number.');
    if (await deps.prisma.user.findUnique({ where: { phone }, select: { id: true } })) {
      throw new AppError(409, 'PHONE_IN_USE', 'Another account uses that number. Sort that account out first.');
    }
    await input.within(tx);
  });
  const budget = await checkOtpDailyBudget(deps.redis, phone, { ip: input.ip, knownPhone: false });
  if (!budget.allowed) throw new AppError(429, 'RATE_LIMITED', 'Too many codes to this number right now. Please try again later.');
  const code = generateOtp();
  await storeOtp(deps.redis, codeKey(input.userId, phone), code);
  await deps.redis.set(pendingKey(input.userId), phone, 'EX', CODE_LIFE_S);
  try {
    await deps.channels.sms.sendSms(phone, `Your Swift code to move your account to this number is: ${code}. Read it to Swift support, and to nobody else.`);
  } catch {
    await budget.refund?.().catch(() => undefined);
    await deps.redis.del(pendingKey(input.userId));
    throw new AppError(502, 'SMS_SEND_FAILED', 'The code could not be sent. Check the number and try again.');
  }
  return { expiresIn: CODE_LIFE_S };
}

/** The person read the code back: the account moves. `within` runs in the move's own commit, for the trail. */
export async function confirmPhoneChange(
  deps: PhoneChangeDeps & { moveWithSessions: MoveWithSessions },
  input: { userId: string; code: string; within: (tx: Prisma.TransactionClient, moved: { from: string; to: string }) => Promise<void> },
): Promise<{ from: string; to: string }> {
  const phone = await deps.redis.get(pendingKey(input.userId));
  if (!phone) throw new AppError(400, 'INVALID_OTP', 'That code has expired. Start again to send a new one.');
  const before = numberMayMove(await deps.prisma.user.findUnique({ where: { id: input.userId }, select: PERSON }), input.userId);
  const checked = await verifyOtp(deps.redis, codeKey(input.userId, phone), input.code);
  if (!checked.valid) throw new AppError(400, 'INVALID_OTP', 'That code is not right. Ask the person to read it again.');
  await deps.redis.del(pendingKey(input.userId));
  await tellOldNumber(deps, before.phone);
  let from: string | undefined;
  try {
    await deps.moveWithSessions(async (tx) => {
      const person = await lockedPerson(tx, input.userId);
      from = person.phone;
      await tx.user.update({ where: { id: input.userId }, data: { phone } });
      await input.within(tx, { from, to: phone });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(409, 'PHONE_IN_USE', 'Another account took that number in the meantime.');
    }
    throw error;
  }
  if (from === undefined) throw new NotFoundError('User', input.userId);
  return { from, to: phone };
}

const ASK_ACTION = 'POST /users/:id/phone-change';

/** The stored ask with the last four in place of the number, or null when it holds none. */
function askWithoutNumber(snapshot: Prisma.JsonValue | null): Prisma.InputJsonValue | null {
  const stored = snapshot as { body?: { phone?: unknown } } | null;
  const phone = stored?.body?.phone;
  if (typeof phone !== 'string' || phone.startsWith('…')) return null;
  return { ...stored, body: { ...stored?.body, phone: `…${lastFour(phone)}` } } as Prisma.InputJsonValue;
}

/**
 * [COORD 4 Nov 2026] The second person has to read the number, but no personal data stays in a table erasure does not
 * name. Once the ask is carried out, whatever the door then answers, the approval row keeps the last four.
 */
export async function blankApprovedNumber(prisma: PrismaClient, approvalId: string): Promise<void> {
  const row = await prisma.privilegedApproval.findUnique({ where: { id: approvalId }, select: { bodySnapshot: true } });
  const blanked = askWithoutNumber(row?.bodySnapshot ?? null);
  if (blanked) await prisma.privilegedApproval.update({ where: { id: approvalId }, data: { bodySnapshot: blanked } });
}

/** The daily sweep's half: an ask that was refused, withdrawn or left to lapse is never carried out. */
export function blankClosedNumberAsks(prisma: PrismaClient, now = new Date()): Promise<number> {
  return runAsSystem('phone-change-ask-blank', async () => {
    const rows = await prisma.privilegedApproval.findMany({
      where: { action: ASK_ACTION, status: { not: 'APPLIED' }, OR: [{ status: { in: ['REJECTED', 'CANCELLED', 'EXPIRED'] } }, { expiresAt: { lte: now } }] },
      select: { id: true, bodySnapshot: true },
    });
    let blanked = 0;
    for (const row of rows) {
      const snapshot = askWithoutNumber(row.bodySnapshot);
      if (!snapshot) continue;
      await prisma.privilegedApproval.update({ where: { id: row.id }, data: { bodySnapshot: snapshot } });
      blanked += 1;
    }
    return blanked;
  });
}

/** Best effort: a number the person lost may never read this, and the account's inbox says it too. */
async function tellOldNumber(deps: PhoneChangeDeps, oldPhone: string): Promise<void> {
  await deps.channels.sms.sendSms(oldPhone, 'Your Swift account is being moved to a new number by Swift support. If this was not you, email support right away.')
    .catch((err: unknown) => deps.log.warn({ err }, 'the old number could not be told of a phone change'));
}
