/**
 * [WEB-ONBOARDING · owner 1 Nov 2026] A partner's first screen after sign-up says what to do next, as the app's waiting
 * screens do (apps/mobile VendorOnboarding for a store, MoverOnboardingScreen for a rider or taxi driver). A store not
 * live yet used to land on "The board is live." with "Use the switch below to start taking orders" over a switch it
 * cannot use; a new rider landed on an earnings page with nothing about documents.
 *
 * Whose turn it is comes from the server: a store's `goLive` (apps/api vendor/go-live.ts storeGoLive), and for a rider
 * or driver the same split of document states — never sent, sent back or out of date is theirs; a copy Swift is still
 * reading is Swift's (go-live.ts OWNER_DOCUMENT_STATES).
 */
export const NOT_LIVE = {
  kicker: 'NOT LIVE YET',
  ownerTurn: 'Finish setting up your store',
  swiftTurn: 'Waiting for Swift’s approval',
  ownerBody: 'Customers can’t order yet. These come first:',
  noWord: 'Customers can’t order yet.',
  // The app's words for a branch on Swift's turn (lib/branches BRANCH_COPY.swiftChecks), said of the store.
  swiftBody: 'Everything Swift needs from you is in. A person at Swift checks your store before it goes live.',
  staffBody: 'Customers can’t order yet. The store’s owner finishes setting it up, then a person at Swift checks it.',
  // The app's waiting store screen (VendorOnboarding), word for word.
  wait: 'Look around while you wait — selling unlocks the moment you’re approved.',
} as const;

/** The police clearance is optional for a mover and never gates (it has its own card on the Documents page). */
const OPTIONAL_FOR_MOVERS = 'police_clearance';
const SENT: ReadonlySet<string> = new Set(['PENDING', 'APPROVED']);

export type MoverNextStep = { kind: 'send'; count: number } | { kind: 'review' } | null;

/** What a rider or driver not yet cleared does next: send the documents still owed, or wait while Swift reads them. */
export function moverNextStep(status: {
  checklist?: string[]; documents?: Array<{ docType: string; status: string; expiresAt?: string | null }>; roleVerified?: boolean;
} | null | undefined, now = new Date()): MoverNextStep {
  if (!status || status.roleVerified !== false) return null;
  const list = (status.checklist ?? []).filter((docType) => docType !== OPTIONAL_FOR_MOVERS);
  // Newest document per type wins, as the Documents page reads the list (newest first).
  const latest = new Map<string, { status: string; expiresAt?: string | null }>();
  for (const doc of status.documents ?? []) if (!latest.has(doc.docType)) latest.set(doc.docType, doc);
  // [REVIEW-LIGHT2 #2309] An approved copy past its date is out of date the moment it lapses, before the daily sweep
  // marks it EXPIRED (or while the sweep holds the row): it is the mover's to send again, as the server's checks read it.
  const sent = (doc: { status: string; expiresAt?: string | null } | undefined) => !!doc && SENT.has(doc.status)
    && !(doc.status === 'APPROVED' && doc.expiresAt && new Date(doc.expiresAt).getTime() <= now.getTime());
  const toSend = list.filter((docType) => !sent(latest.get(docType))).length;
  if (toSend > 0) return { kind: 'send', count: toSend };
  return list.length > 0 ? { kind: 'review' } : null;
}

export function moverNextWords(step: Exclude<MoverNextStep, null>): string {
  return step.kind === 'send'
    ? `${step.count} document${step.count === 1 ? '' : 's'} to send before you can go online.`
    : 'Everything Swift needs from you is in. A person at Swift checks your documents before you go online.';
}
