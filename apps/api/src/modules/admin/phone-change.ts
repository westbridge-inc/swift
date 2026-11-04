import type { FastifyBaseLogger } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { AppError, NotFoundError } from '../../utils/errors';
import { generateOtp, storeOtp, verifyOtp } from '../../utils/otp';
import { normalizePhone } from '../../utils/phone';
import { checkOtpDailyBudget } from '../../utils/sms-budget';
import { publicLaunchCountryFromPhone } from '../auth/launch-market';
import type { NotificationChannels } from '../../providers/notifications/channels';

/**
 * [BUG-HUNT F22 · COORD 4 Nov 2026] A person whose SIM or number changes had no door anywhere: the phone number IS the
 * sign-in. Support moves the account, with a reason, and only after the person reads back a code sent to the NEW number:
 * the code proves they hold it, and a member of staff cannot point an account at a number of their own choosing without
 * that person being the one with the phone in hand. The code uses the same hashed, five-try, five-minute record as a
 * sign-in code, under a key no sign-in can reach. After the move every session ends, the old number is told, and the
 * audit row names the last four digits only.
 */
const CODE_LIFE_S = 300;
const pendingKey = (userId: string) => `phone_change:${userId}`;
const codeKey = (userId: string, phone: string) => `phone-change:${userId}:${phone}`;

interface PhoneChangeDeps {
  prisma: PrismaClient;
  redis: Redis;
  channels: Pick<NotificationChannels, 'sms'>;
  log: Pick<FastifyBaseLogger, 'warn'>;
}

export const lastFour = (phone: string) => phone.slice(-4);

/** Send the code to the new number. Nothing about the account changes yet. */
export async function startPhoneChange(deps: PhoneChangeDeps, input: { userId: string; phone: string; ip: string }): Promise<{ expiresIn: number }> {
  const phone = normalizePhone(input.phone);
  if (!publicLaunchCountryFromPhone(phone)) throw new AppError(400, 'COUNTRY_NOT_ACTIVE', 'Swift is currently available in Guyana only');
  const person = await deps.prisma.user.findUnique({ where: { id: input.userId }, select: { phone: true } });
  if (!person || person.phone.startsWith('deleted:')) throw new NotFoundError('User', input.userId);
  if (person.phone === phone) throw new AppError(409, 'SAME_PHONE', 'This account already uses that number.');
  if (await deps.prisma.user.findUnique({ where: { phone }, select: { id: true } })) {
    throw new AppError(409, 'PHONE_IN_USE', 'Another account uses that number. Sort that account out first.');
  }
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

/** The person read the code back: the account moves. Returns the old number for the notice, and the last four for the trail. */
export async function confirmPhoneChange(deps: PhoneChangeDeps, input: { userId: string; code: string }): Promise<{ from: string; to: string }> {
  const phone = await deps.redis.get(pendingKey(input.userId));
  if (!phone) throw new AppError(400, 'INVALID_OTP', 'That code has expired. Start again to send a new one.');
  const checked = await verifyOtp(deps.redis, codeKey(input.userId, phone), input.code);
  if (!checked.valid) throw new AppError(400, 'INVALID_OTP', 'That code is not right. Ask the person to read it again.');
  await deps.redis.del(pendingKey(input.userId));
  const person = await deps.prisma.user.findUnique({ where: { id: input.userId }, select: { phone: true } });
  if (!person) throw new NotFoundError('User', input.userId);
  try {
    await deps.prisma.user.update({ where: { id: input.userId }, data: { phone } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(409, 'PHONE_IN_USE', 'Another account took that number in the meantime.');
    }
    throw error;
  }
  return { from: person.phone, to: phone };
}

/** Best effort: the move has happened. A number the person lost may never read this; the account's inbox says it too. */
export async function tellOldNumber(deps: PhoneChangeDeps, oldPhone: string): Promise<void> {
  await deps.channels.sms.sendSms(oldPhone, 'Your Swift account was moved to a new number by Swift support. If this was not you, email support right away.')
    .catch((err: unknown) => deps.log.warn({ err }, 'the old number could not be told of a phone change'));
}
