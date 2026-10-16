import type { FastifyRequest } from 'fastify';
import type { ConsentDocumentType } from '../legal/consent.service';
import { browserClientOf } from './browser-session';

/**
 * [Owner ruling 15 Oct 2026 · Terms "You must be at least 18 years old" · Privacy §8 "Children"]
 * A sign-up carries a required, unticked "I am 18 or older" tick. The server records the tick in
 * the consent ledger, anchored to these exact words (their own versioned document), in the same
 * transaction that creates the account.
 *
 * Which clients must send it:
 *  - the website (a browser client): always — it ships with the tick;
 *  - any client that sends `ageConfirmed` (the phone app from build 12): it must be `true`.
 * Phone builds 9, 10 and 11 send no such field and keep signing up; their accounts get no age row
 * (nothing is fabricated). Once build 12 is the oldest phone build in use, requiring it from every
 * client is a one-line change here (launch checklist).
 */
export const AGE_DECLARATION_TYPE: ConsentDocumentType = 'age_declaration';
export const AGE_DECLARATION_VERSION = 'v1';
/** The exact words beside the tick. A change is a new version — a version is a promise about specific words. */
export const AGE_DECLARATION_V1 = 'I am 18 or older.';

export const AGE_CONFIRMATION_MESSAGE = 'You must be 18 or older to create a Swift account. Tick "I am 18 or older" to continue.';

/** True when this sign-up must carry the ticked 18+ declaration (see the rule above). */
export function ageConfirmationRequired(
  request: Pick<FastifyRequest, 'headers'>,
  body: { ageConfirmed?: boolean },
): boolean {
  return body.ageConfirmed !== undefined || browserClientOf(request) !== null;
}
