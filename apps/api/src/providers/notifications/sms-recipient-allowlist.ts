import { isProduction } from '../../utils/runtime-mode';
import { log } from '../../utils/logger';
import { smsRecipientNotAllowlistedCounter } from '../../plugins/observability';
import type { SmsOptions, SmsProvider } from './channels';

/**
 * [L04 · SMS allowlist] Outside production, a REAL SMS provider texts only the
 * numbers on SMS_RECIPIENT_ALLOWLIST (E.164, separated by commas, spaces or new
 * lines; delivered as SMS_RECIPIENT_ALLOWLIST_FILE through the secret store so
 * the numbers never sit in a compose file).
 *
 * Why: an automated store-review crawler tapped "Send code" on staging with
 * random numbers, and staging — a real provider — texted strangers.
 *
 *  - Any other recipient: nothing is sent, the caller gets an ordinary result
 *    (so send-otp answers exactly as for a real send — no oracle), and a
 *    counter moves. The number is never logged.
 *  - An empty or missing allowlist texts NO ONE: fail closed.
 *  - "Production" is the runtime mode the boot configuration parses
 *    (utils/runtime-mode): exactly `production`. Production is never wrapped,
 *    and the boot check refuses production while the setting is present, so
 *    it can never quietly restrict real users.
 *  - The development adapter is not wrapped: it sends nothing anywhere.
 */
export const SMS_RECIPIENT_ALLOWLIST = 'SMS_RECIPIENT_ALLOWLIST';

const E164 = /^\+[1-9][0-9]{6,14}$/;

/** The entries as written (empty entries dropped). */
function entriesOf(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,]+/).filter((entry) => entry.length > 0);
}

/** Entries that are not E.164 — the boot check refuses them by position, never echoing a value. */
export function malformedAllowlistPositions(raw: string | undefined): number[] {
  return entriesOf(raw).flatMap((entry, i) => (E164.test(entry) ? [] : [i + 1]));
}

export function parseSmsRecipientAllowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set(entriesOf(raw).filter((entry) => E164.test(entry)));
}

class AllowlistedSmsProvider implements SmsProvider {
  readonly supportsHandoff?: true;
  constructor(private readonly inner: SmsProvider, private readonly allowed: ReadonlySet<string>) {
    if (inner.supportsHandoff) this.supportsHandoff = true;
  }

  async sendSms(to: string, body: string, options?: SmsOptions): Promise<{ ref: string }> {
    if (this.allowed.has(to)) return this.inner.sendSms(to, body, options);
    smsRecipientNotAllowlistedCounter.inc();
    log().warn('[sms-allowlist] non-production text not sent: recipient is not on SMS_RECIPIENT_ALLOWLIST');
    return { ref: 'not-allowlisted' };
  }
}

let announcedSize: number | null = null;
/** Say once per process (and again if the list changes) how many numbers may
 *  be texted — the count only, never a number — and say loudly when it is none. */
function announce(size: number): void {
  if (announcedSize === size) return;
  announcedSize = size;
  if (size === 0) {
    log().warn('[sms-allowlist] SMS is OFF: no allowlisted recipients (SMS_RECIPIENT_ALLOWLIST is empty or unset on this non-production deployment) — no code or alert text will be delivered');
  } else {
    log().info(`[sms-allowlist] non-production SMS limited to ${size} allowlisted recipient(s)`);
  }
}

/** Wrap a real SMS provider for a non-production deployment; production gets it unchanged. */
export function guardNonProductionSms(
  provider: SmsProvider,
  env: Record<string, string | undefined> = process.env,
): SmsProvider {
  if (isProduction(env)) return provider;
  const allowed = parseSmsRecipientAllowlist(env[SMS_RECIPIENT_ALLOWLIST]);
  announce(allowed.size);
  return new AllowlistedSmsProvider(provider, allowed);
}
