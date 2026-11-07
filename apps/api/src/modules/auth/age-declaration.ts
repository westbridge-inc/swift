import type { ConsentDocumentType } from '../legal/consent.service';

/**
 * [Owner ruling 15 Oct 2026 · Terms "You must be at least 18 years old" · Privacy §8 "Children"]
 * A sign-up carries a required, unticked "I am 18 or older" tick. The server records the tick in
 * the consent ledger, anchored to these exact words (their own versioned document), in the same
 * transaction that creates the account.
 *
 * Every client must send it, ticked (`ageConfirmed: true`): a sign-up without it is refused before
 * the one-use signup proof is spent, so ticking and retrying works. The website always sends it, and
 * so does the phone app from build 12 (RegisterScreen sends `ageConfirmed` on every sign-up; its
 * Register button stays off until the tick is given). Build 12 is the first phone build in the public
 * stores; builds 9-11, which omitted the field, never reached them and were let through only until
 * build 12 was approved (launch checklist, 7 Nov 2026).
 */
export const AGE_DECLARATION_TYPE: ConsentDocumentType = 'age_declaration';
export const AGE_DECLARATION_VERSION = 'v1';
/** The exact words beside the tick. A change is a new version — a version is a promise about specific words. */
export const AGE_DECLARATION_V1 = 'I am 18 or older.';

export const AGE_CONFIRMATION_MESSAGE = 'You must be 18 or older to create a Swift account. Tick "I am 18 or older" to continue.';

/** True when this sign-up carries the ticked 18+ declaration every sign-up needs (see the rule above). */
export function ageConfirmed(body: { ageConfirmed?: boolean }): boolean {
  return body.ageConfirmed === true;
}
