import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// [PT-1 · AH.10.9 / AH.10.9.2] The card rail v2 authority.
//
// A hosted-session / observation capability. It replaces nothing yet and
// extends nothing: the old seam (providers/payment/payment-provider.ts —
// tokenizeCard plus a binary succeeded|failed charge) cannot represent a
// browser session, REQUIRES_ACTION, PENDING, UNKNOWN or a retrieval, so the
// spec puts a typed v2 authority beside it instead of guessing fields into it.
//
// Provider-neutral by construction: nothing in this file names a real
// processor's paths, fields, codes or flags. A real adapter is written from
// that provider's own documentation; until then the only implementation is
// Swift's simulator (simulator-provider.ts), which production refuses.
//
// What every implementation must honour:
//  - [C1] No method accepts, returns or names a card number, a security code
//    or a PIN. Card entry happens only on the provider's hosted page.
//  - [C2] Every token-bearing call names the binding (provider, environment,
//    account) that minted the token, and an adapter refuses any binding but
//    its own BEFORE any effect (assertBinding below).
//  - [C5] parseReturn is an observation: synchronous, no network, never money
//    truth. confirm / retrieve are the provider's server-side answers.
//  - Every answer is exactly one of five statuses — succeeded | failed |
//    unknown | requires_action | pending — and carries the sha256 of the raw
//    payload it was parsed from, never the payload itself.
// ---------------------------------------------------------------------------

export const CARD_RAIL_ENVIRONMENTS = ['sandbox', 'live'] as const;
export type CardRailEnvironment = (typeof CARD_RAIL_ENVIRONMENTS)[number];

/** Which provider, environment and merchant-account LABEL minted a token or a
 *  session [C2]. The account is a label Swift chose, never the merchant
 *  number and never a credential. */
export interface CardRailBinding {
  provider: string;
  environment: CardRailEnvironment;
  account: string;
}

/** The binding a stored row records, in the shape the adapter speaks. */
export function bindingOf(row: { provider: string; environment: string; providerAccount: string }): CardRailBinding {
  return { provider: row.provider, environment: row.environment as CardRailEnvironment, account: row.providerAccount };
}

export function sameBinding(a: CardRailBinding, b: CardRailBinding): boolean {
  return a.provider === b.provider && a.environment === b.environment && a.account === b.account;
}

export function describeBinding(b: CardRailBinding): string {
  return `${b.provider}/${b.environment}/${b.account}`;
}

/** Thrown by an adapter asked to act for a binding that is not its own. It is
 *  raised before any network call or write, so nothing was sent anywhere. */
export class CardBindingMismatchError extends Error {
  override readonly name = 'CardBindingMismatchError';
  constructor(readonly expected: CardRailBinding, readonly actual: CardRailBinding) {
    super(`card rail binding mismatch: this adapter is ${describeBinding(expected)}, the token or session is ${describeBinding(actual)} — refused before any effect`);
  }
}

/** [C2] Every adapter calls this first in every token- or session-bearing method. */
export function assertBinding(own: CardRailBinding, asked: CardRailBinding): void {
  if (!sameBinding(own, asked)) throw new CardBindingMismatchError(own, asked);
}

export type CardSessionPurpose = 'ENROLL' | 'PAY_NOW';

/** [CARDS S1] The service's answer to a provider about to send a completion (see `confirm`). */
export type CompletionClaim = 'send' | 'closed' | 'claimed';

/** [CARDS S1] How long a completion claimed and sent may still be answering:
 *  the completion's own request deadline (30 s) plus a margin to record its
 *  answer. Until then nobody treats its answer as lost, and finance never
 *  closes its session. */
export const COMPLETION_CLAIM_WAIT_MS = 35_000;

/** Safe fields from the provider's own approved completion, never a browser return. */
export type CardCompletionEvidence = {
  Approved: true;
  IsoResponseCode: '00';
  TransactionType: 2;
  TransactionIdentifier: string;
  OrderIdentifier: string;
  TotalAmount: number;
  CurrencyCode: string;
  RiskManagement: { ThreeDSecure: { AuthenticationStatus: string; Eci?: string } };
};

/** The five outcomes. A caller switches over all of them; `assertNever` makes
 *  a sixth a compile error rather than a silent default. */
export type CardOutcomeStatus = 'succeeded' | 'failed' | 'unknown' | 'requires_action' | 'pending';
export const CARD_OUTCOME_STATUSES: readonly CardOutcomeStatus[] = ['succeeded', 'failed', 'unknown', 'requires_action', 'pending'];

export function assertNever(value: never, what: string): never {
  throw new Error(`unhandled ${what}: ${JSON.stringify(value)}`);
}

/** The sha256 of an answer's raw payload — the only form in which a payload
 *  is ever kept. Keys are sorted so the digest names content, not ordering. */
export function rawDigest(raw: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical(raw)) ?? 'undefined').digest('hex');
}

interface Evidence {
  /** sha256 of the provider payload this answer was parsed from. */
  rawSha256: string;
}

/** What a provider reports about an enrolled card: its vault reference and the
 *  display facts. Never a card number. The vault token is sealed the moment it
 *  reaches Swift (modules/billing/card-vault.ts). */
export interface VaultedCard {
  vaultToken: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export type CreateCardSessionOutcome = Evidence & (
  | { status: 'succeeded'; hostedUrl: string; providerSessionRef: string }
  | { status: 'failed'; reason: string }
  /** The provider may have made a page that nobody holds the address of: harmless, and never retried blind. */
  | { status: 'unknown'; reason: string }
);

/** The provider's server-side truth about one hosted session. */
export type CardSessionOutcome = Evidence & (
  | { status: 'succeeded'; purpose: 'ENROLL'; card: VaultedCard }
  | { status: 'succeeded'; purpose: 'PAY_NOW'; providerRef: string; amountMinor: number; currencyCode: string; completionEvidence?: CardCompletionEvidence }
  | { status: 'failed'; reason: string }
  /** The cardholder still has to authenticate on the hosted page. */
  | { status: 'requires_action'; reason: string }
  /** Nothing has happened on the page yet. */
  | { status: 'pending' }
  /** [PT-4] `voidable`: the provider may have TAKEN money that Swift cannot
   *  book (an approval without its proof, for another amount or transaction,
   *  or an answer that was lost). The service voids it at once under a
   *  durable claim, and holds it for a person when the void is not confirmed. */
  | { status: 'unknown'; reason: string; voidable?: { providerRef: string } }
);

/** What the provider says it charged. Swift compares it with the intent
 *  before booking anything: a figure that disagrees is HELD, never booked. */
export interface ChargedAmount {
  amountMinor: number;
  currencyCode: string;
}

/** The provider's answer about one off-session (merchant-initiated) charge.
 *  A capture (succeeded) and an in-flight charge (pending) both say how much,
 *  in what currency, so a mis-scaled or mis-currencied charge can never be
 *  booked as the weekly fee. */
export type CardChargeOutcome = Evidence & (
  | ({ status: 'succeeded'; providerRef: string } & ChargedAmount)
  | { status: 'failed'; reason: string; providerRef?: string }
  /** The bank wants the cardholder present (3-D Secure). Not a decline, never a strike [C4]. */
  | { status: 'requires_action'; reason: string; providerRef?: string }
  | ({ status: 'pending'; providerRef?: string } & ChargedAmount)
  /** `absent`: the provider says it holds no record of this key — evidence of
   *  absence only as strong as its contract, and never a decline. */
  | { status: 'unknown'; reason: string; providerRef?: string; absent?: true }
);

/** Does what the provider reports charging equal what the intent asked for? */
export function chargeMatchesIntent(reported: ChargedAmount, intent: ChargedAmount): boolean {
  return Number.isSafeInteger(reported.amountMinor) && reported.amountMinor === intent.amountMinor
    && reported.currencyCode === intent.currencyCode;
}

/** A refund is never "done" until the provider says succeeded; requested and
 *  pending are shown as exactly that (AH.10.10). A refund cannot require the
 *  cardholder's action, so it has four outcomes. */
export type CardRefundOutcome = Evidence & (
  | { status: 'succeeded'; providerRef: string }
  | { status: 'failed'; reason: string }
  | { status: 'pending'; providerRef?: string }
  | { status: 'unknown'; reason: string }
);

/** What the browser brought back — recorded, never trusted as money [C5]. */
export interface CardReturnObservation {
  rawSha256: string;
  claimedStatus: CardOutcomeStatus | 'invalid';
}

export interface CardRailProvider {
  /** Who this configured adapter is. */
  readonly binding: CardRailBinding;
  /** True ONLY for Swift's simulator: a test page, no real card, no real money. */
  readonly simulator: boolean;
  /** [PT-2] Whether this provider can SAVE a card for the weekly fee (an
   *  ENROLL session, then charges without the partner present). A provider
   *  whose documentation gives no such charge, or no card facts to show
   *  (brand, last 4, expiry), answers false: the API then offers Pay now only
   *  and refuses an ENROLL session before any page is made. */
  readonly savesCards: boolean;

  /** Ask the provider for a hosted page. `sessionRef` is Swift's durable
   *  intent (the CardSession id), created before this call. The return URL
   *  carries Swift's one-use state; PAY_NOW carries the server-priced amount
   *  in minor units, converted at the seam by toProviderMinor. */
  createSession(input: {
    binding: CardRailBinding;
    sessionRef: string;
    purpose: CardSessionPurpose;
    returnUrl: string;
    expiresAt: Date;
    amountMinor?: number;
    currencyCode?: string;
  }): Promise<CreateCardSessionOutcome>;

  /** Read what the browser brought back. Pure: no network, no write, no money. */
  parseReturn(params: Readonly<Record<string, string>>): CardReturnObservation;

  /** [PT-4] Optional. Called by the service for a session's FIRST VALID return
   *  only (state, binding, window already checked), after its observation is
   *  recorded. A provider whose server-side completion depends on what the
   *  browser brought back (a 3-D Secure result) keeps its own decision here.
   *  It never moves money and never makes `confirm` succeed by itself: it can
   *  only make the provider decline to complete. */
  noteReturn?(input: { binding: CardRailBinding; providerSessionRef: string; params: Readonly<Record<string, string>> }): Promise<void>;

  /** The provider's server-side answer about a hosted session.
   *  `beforeCompletion` [CARDS S1]: a provider whose answer needs a financial
   *  instruction (a completion) asks the service, immediately before sending it,
   *  to claim it DURABLY on the session. The service answers `send` (claimed
   *  now: send it once), `closed` (the session closed first and no claim was
   *  ever made: never send; nothing was taken) or `claimed` (a durable claim
   *  already exists: a completion may already have been sent, so never send
   *  again and treat the money as possibly taken). */
  confirm(input: { binding: CardRailBinding; providerSessionRef: string; purpose: CardSessionPurpose; beforeCompletion?: (providerRef: string) => Promise<CompletionClaim> }): Promise<CardSessionOutcome>;

  /** Charge an enrolled card off-session (merchant-initiated). The key makes a
   *  retry the same instruction: the provider captures at most once per key. */
  chargeInstrument(input: {
    binding: CardRailBinding;
    vaultToken: string;
    amountMinor: number;
    currencyCode: string;
    idempotencyKey: string;
  }): Promise<CardChargeOutcome>;

  /** The truth of an instruction, by Swift's key, BEFORE any retry. */
  retrieve(input: { binding: CardRailBinding; idempotencyKey: string; providerRef?: string }): Promise<CardChargeOutcome>;

  refund(input: {
    binding: CardRailBinding;
    providerRef: string;
    amountMinor: number;
    currencyCode: string;
    idempotencyKey: string;
  }): Promise<CardRefundOutcome>;

  /** [PT-4] Optional: cancel an approved payment before it settles, the whole
   *  amount only. Same four outcomes and the same one-call-per-key rule as refund. */
  voidPayment?(input: { binding: CardRailBinding; providerRef: string; idempotencyKey: string }): Promise<CardRefundOutcome>;
}

/** Where a v2 provider comes from, resolved lazily: only v2 work ever asks. */
export type CardRailSource = () => CardRailProvider;

/** How a refund may be SHOWN. Requested or pending is never "refunded": only
 *  the provider's succeeded answer is (AH.10.10). */
export type CardRefundDisplay = 'REFUNDED' | 'REFUND_PENDING' | 'REFUND_FAILED' | 'REFUND_UNCONFIRMED';
export function cardRefundDisplay(outcome: Pick<CardRefundOutcome, 'status'>): CardRefundDisplay {
  switch (outcome.status) {
    case 'succeeded': return 'REFUNDED';
    case 'pending': return 'REFUND_PENDING';
    case 'failed': return 'REFUND_FAILED';
    case 'unknown': return 'REFUND_UNCONFIRMED';
    default: return assertNever(outcome.status, 'card refund outcome');
  }
}
