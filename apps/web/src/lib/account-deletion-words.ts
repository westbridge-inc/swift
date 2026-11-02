// ---------------------------------------------------------------------------
// [WEB-DELETE · owner 1 Nov 2026] The words for deleting a Swift account, in one place: the public page that says
// how (/account/delete) and the signed-in flow on the website (components/account-deletion) show the same lists.
//
// Every line says what the server does (modules/user/account.service.ts deleteAccount, partner-wind-down.ts) in
// the words the Privacy Policy (section 6), the partner agreements and the app already use. Nothing here is the
// legal text: a change to what Swift keeps or for how long is a Privacy Policy change first (LEGAL_VERSION).
// ---------------------------------------------------------------------------

/** What deleting the account removes. */
export const DELETION_GONE: readonly string[] = [
  'Your name, phone number and email',
  'Your profile photo and verification selfie',
  'Your identity documents — deleted so they cannot be recovered, even from a backup',
  'Your saved addresses and precise locations',
  'Your cart, favourites, emergency contacts and any active trip-share links',
  'Your sign-ins on all devices and the details Swift uses to send app notifications',
];

/** The public page's own sentence above what is kept. */
export const DELETION_KEPT_LEAD = 'We do not keep anything we are not required to. Where a legal duty applies, the record is retained but stripped of the person it belonged to.';

/** What Swift must keep, why, and for how long (the Privacy Policy's own periods: it names no number of years). */
export const DELETION_KEPT: ReadonlyArray<{ what: string; why: string; howLong: string }> = [
  {
    what: 'Order, trip and delivery records',
    why: 'Kept in de-identified form for disputes, guarantees, tax and legal record-keeping. They stop being linked to a person.',
    howLong: 'For the period the law requires for disputes, guarantees, tax and legal obligations.',
  },
  {
    what: 'Money records — payouts, invoices, settlement',
    why: 'Financial records have their own statutory retention duty. If money is still owed in either direction, that is settled before the account closes.',
    howLong: 'For the period the law requires for financial records.',
  },
  {
    what: 'Safety and incident evidence',
    why: 'Where an incident or a legal hold exists, the case-bound evidence is retained under that hold rather than the account.',
    howLong: 'Until that case or hold ends.',
  },
  {
    what: 'The record of what you agreed to',
    why: 'The record of the terms you accepted is legal evidence of what was agreed. It holds only what it must.',
    howLong: 'Kept after the account is deleted.',
  },
];

/** The phone's confirmation (apps/mobile PersonalDataScreen), word for word. */
export const DELETE_LEAD = 'This closes your account and starts erasing your personal data. It cannot be undone. Financial records are kept de-identified. Records under a legal or safety hold remain protected until that hold ends.';

/** The phone's closure-request confirmation, with where a website partner sees the request. */
export const CLOSURE_LEAD = 'Send a closure request to our team. You keep access while outstanding business obligations are resolved, and you can see where your request stands on this page.';

/** What happens to a store when its owner asks Swift to close the account, said in two parts [REVIEW-F #2304 S3-3]:
 *  what happens NOW, on the request (closure-pause.ts, owner ruling 1 Nov; closure-fee-hold.ts, owner ruling 2 Nov),
 *  and what happens WHEN Swift's team closes the account (partner-wind-down.ts windDownPartner). */
export const STORE_CLOSURE_NOW: readonly string[] = [
  'New orders stop: your store takes no new orders from the moment you send the request. Orders already placed still finish.',
  'Your weekly fee stops: no new weekly fee is charged or falls due while your request is open. A fee already owed is still owed, and nothing you have paid is refunded automatically. If you cancel the request, your weekly fee starts again from then.',
];
export const STORE_CLOSURE_LATER: readonly string[] = [
  'Your store is taken off sale: its items can no longer be ordered. Its orders, receipts and sales history are kept as financial records.',
  'Your team loses access: every manager and staff member is removed from your store.',
  'If you paid for a week that has not started, Swift refunds it within 14 days to the account you paid from, records the refund, and then closes your account. A week that has started is not refunded.',
  'Your store’s photos and your documents are deleted, unless a legal hold keeps them.',
  'Our team closes the account once every live order is delivered or cancelled and nothing is owed either way.',
];

/** Said before the owner sends the request. */
export const STORE_ORDERS_PAUSE_NOW = 'Your store stops taking new orders, and your weekly fee stops, as soon as you send this request. Orders already placed still finish. Only Swift’s team, or cancelling the request on this page, lifts the pause.';

/** While the request is open and holds the pause. */
export const STORE_ORDERS_PAUSED = 'Your store takes no new orders, and no new weekly fee falls due, while this request is open. Orders already placed still finish.';

/** Once Swift's team has taken up the request: the owner can no longer cancel it here (the server refuses). */
export const CLOSURE_IN_HAND = 'Swift’s team is already closing your account, so this request can no longer be cancelled here. Contact Swift support if you want to keep your account.';

/** A manager or staff member (not an owner) deleting their own account. */
export const STAFF_DELETION_EFFECTS: readonly string[] = [
  'You leave the team of every store you work at. The store stays open: it belongs to its owner.',
];

/** A rider or driver deleting their own account (windDownPartner, partner obligations). */
export const MOVER_DELETION_EFFECTS: readonly string[] = [
  'You go offline for good: your rider or driver profile takes no more jobs. Your vehicle details and pay link are removed; your earnings history is kept as a financial record.',
  'Your weekly fee stops and no further fee falls due. A week that has started is not refunded. If you paid for a week that has not started, Swift refunds it first, then your account can be deleted.',
  'Your documents (licences, insurance, permits) are deleted so they cannot be recovered, unless a legal hold keeps them.',
  'Cash you hold from a delivery, or a cash handover still open with a store, must be settled first.',
];
