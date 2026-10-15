import type { PrismaClient } from '@prisma/client';
import type { EmailProvider, SmsProvider } from '../../providers/notifications/channels';
import { mayReceiveMarketing } from '../legal/consent.service';
import { LEGAL_VERSION } from '../legal/legal.routes';
import { OPERATOR } from '../legal/operator';
import { gsm7Parts, isGsm7 } from '../../utils/sms-text';

/**
 * [R22 · research B13 · DPA s.17(2)-(5)] Every marketing text and e-mail says it is from
 * Swift and how to stop it, and stopping works.
 *
 * This module is the ONLY way a marketing SMS or e-mail leaves Swift (marketing-senders
 * test: every other sendSms/sendEmail caller is a listed service message). Each send:
 *  - goes only to a person whose LATEST marketing consent is a grant to the CURRENT words
 *    (mayReceiveMarketing; withdrawn means zero sends);
 *  - names Swift first ("Swift: …" in a text; "From Swift (<the operator name>)" in an e-mail);
 *  - says how to stop: "Reply STOP to opt out." in a text, and in an e-mail the app switch
 *    the consent text promises (Account → Marketing messages), plus STOP by text.
 * A marketing TEXT is refused while the inbound STOP door is not configured: a text may
 * never promise a STOP that does not work (sms-inbound.routes).
 */

export const MARKETING_SMS_PREFIX = 'Swift: ';
export const MARKETING_SMS_STOP_LINE = 'Reply STOP to opt out.';
/** A marketing text stays within two GSM-7 parts (306 characters): longer concatenations get dropped. */
export const MARKETING_SMS_MAX_PARTS = 2;

/** The texted words that withdraw marketing consent (the carrier-standard opt-out keywords). */
export const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT-OUT', 'REVOKE'] as const;

/** True when a texted reply is an opt-out: one keyword, any case, surrounding spaces and a full stop ignored. */
export function isStopKeyword(body: string | null | undefined): boolean {
  const word = (body ?? '').trim().replace(/[.!]+$/, '').toUpperCase();
  return (STOP_KEYWORDS as readonly string[]).includes(word);
}

/** Inbound STOP is live only with the account token Twilio signs with and the exact URL it calls. */
export function inboundStopConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env['TWILIO_AUTH_TOKEN']?.trim() && !!env['TWILIO_INBOUND_SMS_URL']?.trim();
}

/** The marketing text as sent: "Swift: <offer> Reply STOP to opt out." — GSM-7 only, at most two parts. */
export function marketingSmsText(offer: string): string {
  const words = offer.trim().replace(/\s+/g, ' ');
  if (words.length === 0) throw new Error('[R22] a marketing text needs words');
  const text = `${MARKETING_SMS_PREFIX}${words} ${MARKETING_SMS_STOP_LINE}`;
  if (!isGsm7(text)) throw new Error('[R22] a marketing text must use only GSM-7 characters (no curly quotes, dashes or emoji)');
  if (gsm7Parts(text) > MARKETING_SMS_MAX_PARTS) throw new Error(`[R22] a marketing text may use at most ${MARKETING_SMS_MAX_PARTS} SMS parts`);
  return text;
}

/** The marketing e-mail as sent: the sender line first, the way to stop last. */
export function marketingEmailContent(input: { subject: string; text: string }, env: Record<string, string | undefined> = process.env): { subject: string; body: string } {
  const stopByText = inboundStopConfigured(env) ? ', or reply STOP to any text from Swift' : '';
  return {
    subject: `Swift: ${input.subject.trim()}`,
    body: [
      `From Swift (${OPERATOR.name}).`,
      '',
      input.text.trim(),
      '',
      '--',
      `You get Swift offers because you said yes to marketing messages. To stop them, switch off Account → Marketing messages in the Swift app${stopByText}. Order, ride and safety messages are not affected.`,
    ].join('\n'),
  };
}

export type MarketingSendOutcome = 'SENT' | 'NO_CONSENT' | 'NO_ADDRESS' | 'STOP_NOT_READY';

/** Send one marketing text to one person, if they said yes to the current words. */
export async function sendMarketingSms(
  deps: { prisma: PrismaClient; sms: SmsProvider; env?: Record<string, string | undefined> },
  userId: string,
  offer: string,
): Promise<MarketingSendOutcome> {
  const text = marketingSmsText(offer);
  if (!inboundStopConfigured(deps.env)) return 'STOP_NOT_READY';
  if (!(await mayReceiveMarketing(deps.prisma, 'customer', userId, LEGAL_VERSION))) return 'NO_CONSENT';
  const user = await deps.prisma.user.findUnique({ where: { id: userId }, select: { phone: true, status: true } });
  if (!user?.phone || user.status !== 'ACTIVE') return 'NO_ADDRESS';
  await deps.sms.sendSms(user.phone, text);
  return 'SENT';
}

/** Send one marketing e-mail to one person, if they said yes to the current words. */
export async function sendMarketingEmail(
  deps: { prisma: PrismaClient; email: EmailProvider; env?: Record<string, string | undefined> },
  userId: string,
  content: { subject: string; text: string },
): Promise<MarketingSendOutcome> {
  const message = marketingEmailContent(content, deps.env);
  if (!(await mayReceiveMarketing(deps.prisma, 'customer', userId, LEGAL_VERSION))) return 'NO_CONSENT';
  const user = await deps.prisma.user.findUnique({ where: { id: userId }, select: { email: true, status: true } });
  if (!user?.email || user.status !== 'ACTIVE') return 'NO_ADDRESS';
  await deps.email.sendEmail(user.email, message.subject, message.body);
  return 'SENT';
}
