import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { riderApi, driverApi } from '../services/api';
import { connectSocket, getSocket } from '../services/socket';
import { useMoverPreview } from '../stores/moverPreview';
import type { MoverKind } from '../lib/moverLocation';

// ---------------------------------------------------------------------------
// The mover's live offer cards: the dispatch:offer socket stream, the queue
// the screen shows the head of, recovery after a dropped socket, and the
// render proof. Its own module (moved out of hooks/mover.ts, which re-exports
// it) so its tests drive the real hook with only its own four collaborators
// stubbed, not the thirty modules the rest of the mover hooks import.
// ---------------------------------------------------------------------------

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

function usePreview() {
  return useMoverPreview((s) => s.preview);
}

export interface DispatchOffer {
  orderId: string;
  offerAttemptId?: string;
  orderNumber?: string;
  vendorName?: string;
  expiresInSeconds?: number;
  etaMinutes?: number;
  isExpress?: boolean;
  // [ALG-06] A rescue bonus from Swift's OWN money on a re-offered job —
  // server-set, absent on a normal offer. Never the customer's or the store's
  // money and never cash in hand at the door: Swift settles it.
  rescueIncentiveGyd?: number | null;
  // Load-bearing for the MMG fare lock: movers must never submit an MMG fare.
  paymentMethod?: 'CASH' | 'MOBILE_MONEY' | (string & {});
  customerTrust?: { trustLevel: string; completedOrders: number; strikes: number } | null;
  itemCount?: number;
  estLoad?: string | null;
  // [REPORT-010 F-07] Authoritative money/route facts carried by the RECOVERY
  // payload so a rebuilt card never prices itself from a missing board row.
  deliveryFee?: number;
  tipAmount?: number;
  taxiFareTotal?: number | null;
  pickupAddress?: string | null;
  deliveryAddress?: string | null;
  // [WS-6.0] The cash-math triple, SERVER-COMPUTED. Absent on MMG (the customer
  // already paid the store) and absent whenever the server could not reconcile
  // the split — the card must render nothing rather than a breakdown that does
  // not add up. Never compute these client-side.
  cashMath?: { collectFromCustomer: number; payToVendor: number; youKeep: number } | null;
  // [TAXI multi-stop] A ride WITH stops carries them on the live card and on
  // the recovered one (the board's shape); a ride without stops has neither.
  stopCount?: number;
  stops?: { sequence: number; address: string; lat: number; lng: number }[];
}

type RecoveredDispatchOffer = Omit<DispatchOffer, 'offerAttemptId'> & {
  offerAttemptId: string | null;
};

/** [DISPATCH 1/3 · AX299 F2] The server withdrew ONE card: its order closed
 *  while the card rang (`dispatch:offer_withdrawn`, from the one withdrawal
 *  point, dispatch/offer-withdrawal.ts). Keyed by order AND attempt. */
export interface DispatchOfferWithdrawn {
  orderId: string;
  offerAttemptId?: string | null;
  reason?: string;
}

/** Is this queued card the withdrawn one? The same order and, when both carry
 *  one, the same attempt: a newer attempt of that order is a different, live
 *  card. A card from before attempts (no id on either side) matches by order. */
function isWithdrawnCard(card: DispatchOffer, withdrawn: DispatchOfferWithdrawn): boolean {
  if (card.orderId !== withdrawn.orderId) return false;
  return !card.offerAttemptId || !withdrawn.offerAttemptId || card.offerAttemptId === withdrawn.offerAttemptId;
}

/** [AX310] How many retired cards the hook remembers: far more than can ring
 *  one mover while a request is in flight, small enough to never matter. */
const RETIRED_CARDS_REMEMBERED = 64;

/**
 * Real-time dispatch offers. The backend emits `dispatch:offer` to the mover's
 * user room the moment they're the top candidate; we surface it instantly and
 * refresh the available list. Polling (useAvailableJobs) stays as a fallback,
 * so a missed socket event still resolves within the poll interval.
 */
export function useDispatchOffers(kind: MoverKind | null, online: boolean) {
  const pv = usePreview();
  const qc = useQueryClient();
  // Stacking: offers QUEUE (FIFO, deduped by orderId) instead of overwriting —
  // with capacity 2 the server may legitimately offer a second job while one
  // card is showing. The visible card is queue[0]; the rest wait their turn,
  // exactly the vendor takeover's shape. Each entry carries an ABSOLUTE
  // deadline stamped at arrival, so backgrounding cannot freeze a countdown
  // into a lie (master audit G11).
  const [offerQueue, setOfferQueue] = useState<(DispatchOffer & { deadlineAt?: number })[]>([]);
  const offer = offerQueue[0] ?? null;
  const queuedBehind = Math.max(0, offerQueue.length - 1);
  // [AX310] Cards this device has retired (withdrawn by the server, answered
  // here, or lapsed), by order and attempt, for the life of the hook. A
  // recovery answer the server read BEFORE a withdrawal can land after it; it
  // must not put the dead card back on top of the queue with a fresh deadline.
  // A card with an attempt id is refused only on its exact generation, so a
  // new attempt for the same order still shows; one without (a pre-attempt
  // card) is refused once its order has retired anything.
  const retired = useRef(new Map<string, { orderId: string; attemptId: string }>());
  const retire = (orderId: string, attemptId?: string | null) => {
    const key = `${orderId}:${attemptId ?? ''}`;
    retired.current.delete(key);
    retired.current.set(key, { orderId, attemptId: attemptId ?? '' });
    while (retired.current.size > RETIRED_CARDS_REMEMBERED) {
      retired.current.delete(retired.current.keys().next().value!);
    }
  };
  const isRetired = (card: DispatchOffer) => {
    for (const r of retired.current.values()) {
      if (r.orderId === card.orderId && (!card.offerAttemptId || r.attemptId === card.offerAttemptId)) return true;
    }
    return false;
  };
  const pushOffer = (data: DispatchOffer) => {
    if (isRetired(data)) return;
    setOfferQueue((q) => (q.some((o) => o.orderId === data.orderId)
      ? q.map((o) => (o.orderId === data.orderId ? { ...o, ...data, deadlineAt: o.deadlineAt } : o))
      : [...q, { ...data, deadlineAt: data.expiresInSeconds ? Date.now() + data.expiresInSeconds * 1000 : undefined }]));
  };
  const dropOffer = (orderId: string) => setOfferQueue((q) => q.filter((o) => o.orderId !== orderId));
  const setOffer = (data: DispatchOffer | null) => {
    if (data === null) setOfferQueue((q) => q.slice(1));
    else pushOffer(data);
  };

  useEffect(() => {
    // No live offers in preview (read-only, no socket/auth).
    if (!kind || !online || pv) {
      setOfferQueue([]);
      return;
    }
    connectSocket();
    const s = getSocket();
    const api = kind === 'DRIVER' ? driverApi : riderApi;
    // The render proof is NOT stamped here: a card that just arrived may be
    // waiting behind another. It is stamped when the card is on screen (below).
    const onOffer = (data: DispatchOffer) => {
      setOffer(data);
      qc.invalidateQueries({ queryKey: ['mover', 'available', kind] });
    };
    s.on('dispatch:offer', onOffer);

    // [AX299 F2] A cancel withdraws its order's card and frees the mover at
    // once, so the next offer can arrive a second later. Drop exactly the
    // withdrawn card, wherever it sits in the queue, so the next one is on
    // screen with its whole window instead of waiting behind a dead card.
    const onWithdrawn = (withdrawn: DispatchOfferWithdrawn) => {
      if (!withdrawn?.orderId) return;
      retire(withdrawn.orderId, withdrawn.offerAttemptId);
      setOfferQueue((q) => q.filter((o) => !isWithdrawnCard(o, withdrawn)));
      qc.invalidateQueries({ queryKey: ['mover', 'available', kind] });
    };
    s.on('dispatch:offer_withdrawn', onWithdrawn);

    // [E27 / danger #37] Offer RECOVERY: a socket that dropped while the ping
    // was in flight used to lose the card forever (and the silent timeout
    // still counted against acceptance). On mount and every reconnect, ask
    // the server for the live exclusive offer and rebuild the card with its
    // REAL remaining seconds. Failures are garnish — the poll fallback and
    // the next socket ping still stand.
    let gone = false;
    const recover = async () => {
      try {
        const data = await unwrap<{ offer: RecoveredDispatchOffer | null }>(api.currentOffer());
        if (!gone && data?.offer?.orderId) {
          const recoveredOffer: DispatchOffer = {
            ...data.offer,
            offerAttemptId: data.offer.offerAttemptId ?? undefined,
          };
          setOffer(recoveredOffer);
          qc.invalidateQueries({ queryKey: ['mover', 'available', kind] });
        }
      } catch { /* recovery only — never surface */ }
    };
    void recover();
    s.on('connect', recover);
    return () => {
      gone = true;
      s.off('dispatch:offer', onOffer);
      s.off('dispatch:offer_withdrawn', onWithdrawn);
      s.off('connect', recover);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, online, qc, pv]);

  // [danger #21 · AX299 F2] Render proof when the card is ON SCREEN — the head
  // of the queue while online — never on arrival. A timeout without this stamp
  // is undeliverable and never decays the acceptance rate, so a card waiting
  // behind another is not "seen", and one whose window ran out while it waited
  // never is. Once per card generation. Fire-and-forget garnish.
  const seenCard = useRef<string | null>(null);
  useEffect(() => {
    if (!offer || !kind || !online || pv) return;
    const key = `${offer.orderId}:${offer.offerAttemptId ?? ''}`;
    if (seenCard.current === key) return;
    if (offer.deadlineAt !== undefined && offer.deadlineAt <= Date.now()) return;
    seenCard.current = key;
    const api = kind === 'DRIVER' ? driverApi : riderApi;
    void api.offerSeen(offer.orderId, offer.offerAttemptId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer?.orderId, offer?.offerAttemptId, kind, online, pv]);

  // Auto-dismiss once the offer window lapses (the backend reassigns it).
  // Keyed to the ABSOLUTE deadline stamped at arrival, and it drops THAT
  // order, not whatever sits at the head by then — with a queue the two can
  // differ. A timer that fires late after backgrounding still computes a
  // non-negative remainder, so a lapsed card cannot linger (G11). A card whose
  // window ran out while it waited behind another leaves at once, unshown.
  useEffect(() => {
    if (!offer) return;
    const deadline = offer.deadlineAt ?? (offer.expiresInSeconds ? Date.now() + offer.expiresInSeconds * 1000 : null);
    if (!deadline) return;
    const { orderId, offerAttemptId } = offer;
    const lapse = () => { retire(orderId, offerAttemptId); dropOffer(orderId); };
    if (deadline <= Date.now()) {
      lapse();
      return;
    }
    const t = setTimeout(lapse, deadline - Date.now());
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer?.orderId]);

  return {
    offer,
    // Stacking: how many more offers wait behind the visible card — the UI
    // states queue depth honestly, like the vendor takeover does.
    queuedBehind,
    // Answered on this device (accepted or declined): retired, like a lapse.
    dismiss: () => {
      if (!offer) return;
      retire(offer.orderId, offer.offerAttemptId);
      dropOffer(offer.orderId);
    },
  };
}
