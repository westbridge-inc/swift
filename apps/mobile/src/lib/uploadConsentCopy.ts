/**
 * [R17 · legal research D1/D2/B1/G4, in-app ¶15] The words beside the ticks before an upload (phone build 12). The API
 * records each tick in the consent ledger, anchored to these exact words (apps/api verification/upload-consent.ts);
 * uploadConsentCopy.test.ts holds the two together.
 */
export const DOCUMENT_CONSENT_TEXT = 'I consent to Swift processing this document for verification, per the privacy notice. It is stored encrypted and shared only as the Privacy Policy explains.';
// [Owner ruling 24 Oct 2026 — NO CUSTOMER ID GATE] An ID no longer unlocks taxi rides or larger orders: the words
// are the API's customer_id_v2 (build 12's own JS still shows v1's words and sends customer_id_v1).
export const CUSTOMER_ID_CONSENT_TEXT = 'I agree Swift may keep this ID photo with my account, as the Privacy Policy explains.';
