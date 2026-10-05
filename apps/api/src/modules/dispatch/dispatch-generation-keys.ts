import { createHash } from 'node:crypto';

/**
 * Redis search memory is scoped to a delivery-custody generation after the
 * first ownership switch. Generation zero deliberately keeps the historical
 * key format so an in-flight pre-deploy cascade survives the rollout.
 *
 * Order.fulfillmentModeVersion is monotonic: once a delivery has switched,
 * an older worker can therefore mutate only its own suffix. Taxi searches do
 * not have delivery custody generations and pass no version.
 */
export const deliveryGenerationSuffix = (version?: number | null): string =>
  version != null && Number.isSafeInteger(version) && version > 0 ? `:fv${version}` : '';

/** The live offer PAIR. Forward: an order has at most one live card, valued
 *  `<moverId>:<attemptId>`. Reverse: a mover holds at most one live card,
 *  valued `<orderId>:<attemptId>`. Not generation-suffixed: the attempt id
 *  inside the value carries the generation. dispatch.service writes them;
 *  offer-withdrawal.ts removes the pair of an order that has closed. */
export const dispatchOfferKey = (orderId: string): string => `dispatch:offer:${orderId}`;
export const dispatchMoverOfferKey = (moverId: string): string => `dispatch:mover-offer:${moverId}`;

/** [AX299 F2 · AX310] The cards withdrawn from under this mover (their order
 *  closed) that could still be on their screen, should the withdrawal event
 *  never reach the app: a sorted set, one member per card,
 *  `<withdrawnAt>:<orderId>:<attemptId>`, scored with the card's own server
 *  deadline (ms since epoch). offer-withdrawal.ts writes it; an offer sent to
 *  the mover AFTER such a withdrawal and before that deadline (plus the screen
 *  skew) never earns an expiry penalty. */
export const dispatchWithdrawnCardsKey = (moverId: string): string => `dispatch:withdrawn-cards:${moverId}`;

/** [AX299 F2 · AX310] How far past a card's server deadline it may still be on
 *  the mover's screen: the app stamps its own deadline on arrival, a network hop
 *  later and rounded up to whole seconds. ONE value for the writer (a withdrawn
 *  card is recorded while its deadline plus this is still ahead) and the reader
 *  (an offer sent before the deadline plus this is excused), so they agree. */
export const WITHDRAWN_CARD_SCREEN_SKEW_MS = 3_000;

export const dispatchDeclinedKey = (orderId: string, version?: number | null): string =>
  `dispatch:declined:${orderId}${deliveryGenerationSuffix(version)}`;

export const dispatchRoundKey = (orderId: string, version?: number | null): string =>
  `dispatch:round:${orderId}${deliveryGenerationSuffix(version)}`;

export const dispatchExhaustKey = (orderId: string, version?: number | null): string =>
  `dispatch:exhausts:${orderId}${deliveryGenerationSuffix(version)}`;

/** [E36] The replay identity of one queued dispatch run: a short hash of the
 *  BullMQ job's identity (the worker passes `<job id>@<job creation time>`).
 *  A redelivery (the worker died, the job's lock lapsed) replays the SAME job,
 *  so it gets the same tag; every genuine cycle is a different job — even one
 *  re-created under a deterministic command id — with a different tag. Hashed
 *  so it is colon-free (BullMQ refuses a custom job id containing ':' unless
 *  it has exactly three parts) and so a re-arm chain keyed by its parent's tag
 *  never grows in length. */
export const dispatchReplayTag = (jobId: string): string =>
  createHash('sha256').update(jobId).digest('hex').slice(0, 20);

/** [E36] Marks that the run with this replay tag already committed its
 *  exhaustion attempt-count increment for this search, so a redelivery reuses
 *  that count instead of INCRing again. Lives for the terminal window
 *  (EXHAUST_TERMINAL_TTL_SECONDS), like the counter itself. */
export const exhaustJobKey = (orderId: string, version: number | null | undefined, replayTag: string): string =>
  `dispatch:exhaust-job:${orderId}${deliveryGenerationSuffix(version)}:${replayTag}`;

/** [E36] The re-arm a run schedules, keyed by that run's replay tag: a
 *  redelivered run re-adds the SAME job id and BullMQ keeps the first. Keyed
 *  by the parent run, never by the attempt count: the counter restarts at 1
 *  after a manual retry, and an id reused from a retained completed job would
 *  make BullMQ silently drop a legitimate re-sweep. */
export const redispatchJobId = (orderId: string, replayTag: string): string =>
  `redispatch-${orderId}-${replayTag}`;

export const dispatchExhaustLockKey = (orderId: string, version?: number | null): string =>
  `dispatch:exhaust-lock:${orderId}${deliveryGenerationSuffix(version)}`;

export const dispatchGenerationInitKey = (orderId: string, version: number): string =>
  `dispatch:generation-init:${orderId}:fv${version}`;
