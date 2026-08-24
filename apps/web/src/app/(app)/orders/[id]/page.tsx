'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Banknote,
  CircleX,
  Clock3,
  ExternalLink,
  MapPin,
  PackageCheck,
  Phone,
  Star,
  Truck,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { activeRide, cancelOrder, getOrder, getRide, money } from '@/lib/customer';
import styles from './tracking.module.css';

const POLL_INTERVAL_MS = 8_000;

type OrderLine = {
  id?: string;
  name: string;
  quantity: number;
  lineTotal?: number;
  customerPrice?: number;
};

type TimelineEvent = {
  status: string;
  note?: string | null;
  timestamp: string;
};

type OrderDetail = {
  id: string;
  orderNumber: string;
  orderType?: 'FOOD_DELIVERY' | 'GROCERY_DELIVERY' | 'COURIER' | 'TAXI' | string;
  status: string;
  fulfillment?: 'DELIVERY' | 'PICKUP' | 'APPOINTMENT' | string;
  vendor?: { name?: string; slug?: string } | null;
  vendorName?: string;
  items?: OrderLine[];
  subtotalCustomer?: number;
  deliveryFee?: number;
  discount?: number;
  tipAmount?: number;
  totalAmount?: number;
  total?: number;
  paymentMethod?: 'CASH' | 'MOBILE_MONEY' | string;
  paymentStatus?: string;
  paymentAction?: {
    kind: 'OPEN_EXTERNAL_URL';
    method: 'MOBILE_MONEY';
    provider: 'MMG';
    fundsFlow: 'DIRECT_TO_VENDOR';
    recipientName: string;
    amount: number;
    url: string;
  } | null;
  pickupCode?: string | null;
  deliveryAddress?: string | null;
  pickupAddress?: string | null;
  estimatedPrepTime?: number | null;
  rider?: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    displayRating?: number | string | null;
    vehicleType?: string | null;
    vehicleMake?: string | null;
    vehicleModel?: string | null;
    vehicleColor?: string | null;
    licensePlate?: string | null;
  } | null;
  timeline?: TimelineEvent[];
  holdExpiresAt?: string | null;
  freeCancellationExpiresAt?: string | null;
  canCancel?: boolean;
  cancellationFee?: number;
  cancellationReason?: string | null;
};

type Stage = { label: string; statuses: string[] };

const deliveryStages: Stage[] = [
  { label: 'Placed', statuses: ['PENDING', 'ACCEPTED'] },
  { label: 'Preparing', statuses: ['PREPARING', 'READY', 'READY_FOR_PICKUP'] },
  { label: 'On the way', statuses: ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'] },
  { label: 'Delivered', statuses: ['DELIVERED', 'COMPLETED'] },
];

const pickupStages: Stage[] = [
  { label: 'Placed', statuses: ['PENDING', 'ACCEPTED'] },
  { label: 'Preparing', statuses: ['PREPARING'] },
  { label: 'Ready', statuses: ['READY', 'READY_FOR_PICKUP'] },
  { label: 'Collected', statuses: ['PICKED_UP', 'DELIVERED', 'COMPLETED'] },
];

const appointmentStages: Stage[] = [
  { label: 'Booked', statuses: ['PENDING'] },
  { label: 'Confirmed', statuses: ['ACCEPTED'] },
  { label: 'In progress', statuses: ['PREPARING', 'IN_PROGRESS'] },
  { label: 'Completed', statuses: ['COMPLETED', 'DELIVERED'] },
];

const taxiStages: Stage[] = [
  { label: 'Requested', statuses: ['PENDING'] },
  { label: 'Driver assigned', statuses: ['ACCEPTED', 'DRIVER_ASSIGNED'] },
  { label: 'Driver arriving', statuses: ['DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'] },
  { label: 'Ride in progress', statuses: ['RIDE_IN_PROGRESS'] },
  { label: 'Completed', statuses: ['COMPLETED', 'DELIVERED'] },
];

function stagesFor(order: OrderDetail): Stage[] {
  if (order.orderType === 'TAXI') return taxiStages;
  if (order.fulfillment === 'PICKUP') return pickupStages;
  if (order.fulfillment === 'APPOINTMENT') return appointmentStages;
  return deliveryStages;
}

function stageIndex(status: string, stages: Stage[]): number {
  const exact = stages.findIndex((stage) => stage.statuses.includes(status));
  return exact >= 0 ? exact : 0;
}

function statusHeading(order: OrderDetail): string {
  if (order.status === 'CANCELLED') return order.orderType === 'TAXI' ? 'Ride cancelled' : 'Order cancelled';
  if (order.status === 'REFUNDED') return order.orderType === 'TAXI' ? 'Ride refunded' : 'Order refunded';
  if (order.status === 'FAILED') return order.orderType === 'TAXI' ? 'Ride could not be completed' : 'Order could not be completed';
  if (['DELIVERED', 'COMPLETED'].includes(order.status)) {
    if (order.orderType === 'TAXI') return 'Ride completed';
    if (order.fulfillment === 'APPOINTMENT') return 'Appointment completed';
    return order.fulfillment === 'PICKUP' ? 'Order collected' : 'Order delivered';
  }
  if (order.orderType === 'TAXI') {
    if (order.status === 'RIDE_IN_PROGRESS') return 'Your ride is in progress';
    if (order.status === 'DRIVER_ARRIVED') return 'Your driver has arrived';
    if (order.status === 'DRIVER_EN_ROUTE') return 'Your driver is on the way';
    if (['DRIVER_ASSIGNED', 'ACCEPTED'].includes(order.status)) return 'A driver is assigned';
    return order.status === 'PENDING' ? 'Ride requested' : 'Ride status updated';
  }
  if (order.status === 'ARRIVED') return 'Your rider has arrived';
  if (order.status === 'PICKED_UP') return order.fulfillment === 'PICKUP' ? 'Order collected' : 'Your order is on the way';
  if (order.status === 'EN_ROUTE_DELIVERY') return 'Your order is on the way';
  if (['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'].includes(order.status)) {
    return 'A rider is collecting your order';
  }
  if (['READY', 'READY_FOR_PICKUP'].includes(order.status)) return 'Your order is ready';
  if (order.status === 'PREPARING') return order.fulfillment === 'APPOINTMENT' ? 'Appointment in progress' : 'The store is preparing your order';
  if (order.status === 'ACCEPTED') return order.fulfillment === 'APPOINTMENT' ? 'Appointment confirmed' : 'The store accepted your order';
  return order.fulfillment === 'APPOINTMENT' ? 'Appointment requested' : 'Order placed';
}

function formatRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatEventTime(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function cancellationPayload(value: unknown): { message: string | null; fee: number | null } {
  const root = record(value);
  const first = record(root?.['data']) ?? root;
  const payload = record(first?.['data']) ?? first;
  return {
    message: typeof payload?.['message'] === 'string' ? payload['message'] : null,
    fee: typeof payload?.['cancellationFee'] === 'number' ? payload['cancellationFee'] : null,
  };
}

function verifiedMmgAction(order: OrderDetail): NonNullable<OrderDetail['paymentAction']> | null {
  const action = order.paymentAction;
  if (
    !action ||
    action.kind !== 'OPEN_EXTERNAL_URL' ||
    action.method !== 'MOBILE_MONEY' ||
    action.provider !== 'MMG' ||
    action.fundsFlow !== 'DIRECT_TO_VENDOR'
  ) return null;
  try {
    return new URL(action.url).protocol === 'https:' ? action : null;
  } catch {
    return null;
  }
}

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelResult, setCancelResult] = useState<string | null>(null);
  const [cancelFee, setCancelFee] = useState<number | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [openingPayment, setOpeningPayment] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const expiredHold = useRef<string | null>(null);
  const loadSequence = useRef(0);
  const loadInFlight = useRef<number | null>(null);
  const cancelConfirmButton = useRef<HTMLButtonElement | null>(null);
  const cancelReturnFocus = useRef<HTMLButtonElement | null>(null);
  const statusHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const load = useCallback(async () => {
    const request = loadSequence.current;
    if (loadInFlight.current === request) return;
    loadInFlight.current = request;
    try {
      const nextOrder = (await getOrder(id)) as OrderDetail;
      if (nextOrder.orderType === 'TAXI') {
        const [rideResult, activeResult] = await Promise.allSettled([
          getRide(id),
          activeRide(),
        ]);
        const ride = rideResult.status === 'fulfilled' ? rideResult.value : null;
        const active = activeResult.status === 'fulfilled' ? activeResult.value : null;
        const activeDriver = active?.id === id ? active.driver : null;
        const driver = ride?.driver ?? activeDriver;
        if (driver) {
          // Customer order detail omits taxi drivers; normalize the dedicated
          // ride contract into the existing counterparty shape used below.
          nextOrder.rider = {
            firstName: driver.user?.firstName,
            phone: activeDriver?.user?.phone,
            displayRating: driver.displayRating ?? null,
            vehicleMake: driver.vehicleMake,
            vehicleModel: driver.vehicleModel,
            vehicleColor: driver.vehicleColor,
            licensePlate: driver.licensePlate,
          };
        }
      }
      if (request !== loadSequence.current) return;
      setOrder(nextOrder);
      setTrackingError(null);
      setLastUpdatedAt(new Date());
    } catch (loadError) {
      if (request !== loadSequence.current) return;
      setTrackingError(loadError instanceof Error ? loadError.message : 'Could not load this order.');
    } finally {
      if (loadInFlight.current === request) loadInFlight.current = null;
    }
  }, [id]);

  useEffect(() => {
    setOrder(null);
    setTrackingError(null);
    setLastUpdatedAt(null);
    setError(null);
    setCancelResult(null);
    setCancelFee(null);
    setConfirmingCancel(false);
    setCancelling(false);
    setOpeningPayment(false);
    expiredHold.current = null;
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      loadSequence.current += 1;
    };
  }, [load]);

  const holdExpiresAt = order?.holdExpiresAt ?? null;
  useEffect(() => {
    if (!holdExpiresAt) return;
    const expiresAt = new Date(holdExpiresAt).getTime();
    if (!Number.isFinite(expiresAt)) return;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current >= expiresAt && expiredHold.current !== holdExpiresAt) {
        expiredHold.current = holdExpiresAt;
        void load();
      }
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [holdExpiresAt, load]);

  useEffect(() => {
    if (!confirmingCancel || !order) return;
    const terminal = ['CANCELLED', 'REFUNDED', 'FAILED'].includes(order.status);
    const taxiInCustody = order.orderType === 'TAXI' && ['DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'].includes(order.status);
    if (!order.canCancel || terminal || taxiInCustody) {
      setConfirmingCancel(false);
      setError('This order can no longer be cancelled. Swift refreshed its current status.');
      window.requestAnimationFrame(() => statusHeadingRef.current?.focus());
    }
  }, [confirmingCancel, order]);

  if (trackingError && !order) {
    return (
      <section className={styles.stateCard} role="alert">
        <h1>We could not load this order</h1>
        <p>{trackingError}</p>
        <button type="button" className={styles.primaryButton} onClick={() => void load()}>Try again</button>
      </section>
    );
  }

  if (!order) return <div className={styles.loading} aria-label="Loading order tracking" />;

  const cancelled = order.status === 'CANCELLED';
  const refunded = order.status === 'REFUNDED';
  const failed = order.status === 'FAILED';
  const stopped = cancelled || refunded || failed;
  const completed = ['DELIVERED', 'COMPLETED'].includes(order.status)
    || (order.fulfillment === 'PICKUP' && order.status === 'PICKED_UP');
  const mmgAmbiguous = order.paymentMethod === 'MOBILE_MONEY' && order.paymentStatus === 'PENDING';
  const holdExpiryMs = holdExpiresAt ? new Date(holdExpiresAt).getTime() : 0;
  const holdActive = !stopped && !order.rider && order.status === 'PENDING' && Number.isFinite(holdExpiryMs) && holdExpiryMs > now;
  const isTaxi = order.orderType === 'TAXI';
  const taxiCancellationUnknown = isTaxi && ['DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'].includes(order.status);
  const canOfferCancellation = Boolean(order.canCancel) && !stopped && !taxiCancellationUnknown;
  const stages = stagesFor(order);
  const currentStage = stageIndex(order.status, stages);
  const vendorName = isTaxi ? 'Swift ride' : order.vendorName ?? order.vendor?.name ?? 'the store';
  const destination = order.fulfillment === 'PICKUP'
    ? order.pickupAddress
    : order.fulfillment === 'APPOINTMENT'
      ? order.deliveryAddress ?? order.pickupAddress
      : order.deliveryAddress;
  const riderName = [order.rider?.firstName, order.rider?.lastName].filter(Boolean).join(' ');
  const vehicle = [order.rider?.vehicleColor, order.rider?.vehicleMake, order.rider?.vehicleModel, order.rider?.vehicleType]
    .filter(Boolean)
    .join(' ');
  const effectiveCancelFee = cancelFee ?? Number(order.cancellationFee ?? 0);
  const paymentCaptured = order.paymentStatus === 'CAPTURED';
  const paymentRefunded = order.paymentStatus === 'REFUNDED';
  const paymentFailed = order.paymentStatus === 'FAILED';
  const showPaymentTruth = failed || !stopped || paymentRefunded || (refunded && paymentCaptured);
  const mmgAction = verifiedMmgAction(order);
  const payableMmgAction = !trackingError && !stopped && !paymentCaptured && !paymentRefunded && order.paymentStatus === 'PENDING'
    ? mmgAction
    : null;

  const openVerifiedMmgPayment = async () => {
    if (openingPayment) return;
    const paymentWindow = window.open('about:blank', '_blank');
    if (!paymentWindow) {
      setError('Your browser blocked the payment window. Allow pop-ups for Swift, then try again.');
      return;
    }
    paymentWindow.opener = null;
    setOpeningPayment(true);
    setError(null);
    try {
      const latest = (await getOrder(id)) as OrderDetail;
      setOrder({ ...latest, rider: latest.rider ?? order.rider });
      setLastUpdatedAt(new Date());
      const action = verifiedMmgAction(latest);
      const latestStopped = ['CANCELLED', 'REFUNDED', 'FAILED'].includes(latest.status);
      if (!action || latestStopped || latest.paymentStatus !== 'PENDING') {
        paymentWindow.close();
        setError('Swift refreshed this order and no current verified MMG payment action is available. No payment was opened.');
        return;
      }
      paymentWindow.location.replace(action.url);
    } catch (paymentError) {
      paymentWindow.close();
      setError(paymentError instanceof Error ? paymentError.message : 'Swift could not recheck this MMG payment action.');
    } finally {
      setOpeningPayment(false);
    }
  };

  const confirmCancellation = async () => {
    setCancelling(true);
    setError(null);
    try {
      const latest = (await getOrder(id)) as OrderDetail;
      const latestFee = Number(latest.cancellationFee ?? 0);
      setOrder({ ...latest, rider: latest.rider ?? order.rider });
      setLastUpdatedAt(new Date());
      const latestTaxiCancellationUnknown = latest.orderType === 'TAXI'
        && ['DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'].includes(latest.status);
      if (!latest.canCancel || latestTaxiCancellationUnknown || ['CANCELLED', 'REFUNDED', 'FAILED'].includes(latest.status)) {
        setConfirmingCancel(false);
        setError('This order can no longer be cancelled. Swift refreshed its current status.');
        window.requestAnimationFrame(() => statusHeadingRef.current?.focus());
        return;
      }
      if (latestFee !== effectiveCancelFee) {
        setCancelFee(latestFee);
        setError(`The server’s cancellation quote changed to ${money(latestFee)}. Review the updated cash-only marker, then confirm again if you still want to cancel.`);
        window.requestAnimationFrame(() => cancelConfirmButton.current?.focus());
        return;
      }
      const result = cancellationPayload(await cancelOrder(id, 'changed my mind'));
      setCancelResult(result.message);
      setCancelFee(result.fee);
      setConfirmingCancel(false);
      await load();
      window.requestAnimationFrame(() => statusHeadingRef.current?.focus());
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Could not cancel this order.');
    } finally {
      setCancelling(false);
    }
  };

  const closeCancellationReview = () => {
    setConfirmingCancel(false);
    window.requestAnimationFrame(() => cancelReturnFocus.current?.focus());
  };

  return (
    <div className={styles.page}>
      <Link href="/orders" className={styles.backLink}>
        <ArrowLeft size={18} aria-hidden="true" />
        All orders
      </Link>

      <section className={styles.hero} aria-labelledby="order-status-heading">
        <div className={styles.heroIcon} aria-hidden="true">
          {stopped ? <CircleX size={28} /> : completed ? <PackageCheck size={28} /> : order.rider ? <Truck size={28} /> : <Clock3 size={28} />}
        </div>
        <div className={styles.heroCopy} role="status" aria-live="polite" aria-atomic="true">
          <p className={styles.eyebrow}>{vendorName} · {order.orderNumber}</p>
          <h1 ref={statusHeadingRef} tabIndex={-1} id="order-status-heading" className={styles.title}>{statusHeading(order)}</h1>
          <p className={styles.updateNote}>
            {stopped ? cancelResult ?? order.cancellationReason ?? 'This order is closed.' : 'This page checks Swift for updates every few seconds.'}
          </p>
        </div>
        <span className={`${styles.statusPill} ${completed ? styles.statusComplete : refunded ? styles.statusRefunded : cancelled || failed ? styles.statusCancelled : ''}`}>
          {order.status.replaceAll('_', ' ').toLowerCase()}
        </span>
      </section>

      {trackingError ? (
        <div className={styles.trackingNotice} role="alert">
          <span>
            The last update failed; Swift keeps retrying. {lastUpdatedAt ? `Showing the last server result from ${lastUpdatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}. ` : ''}
            {trackingError}
          </span>
          <button type="button" className={styles.secondaryButton} onClick={() => void load()}>Try updates again</button>
        </div>
      ) : null}

      {cancelResult ? (
        <div className={`${styles.cancelOutcome} ${Number(cancelFee ?? 0) > 0 ? styles.cancelWarning : ''}`} role="status">
          <strong>{cancelResult}</strong>
          {typeof cancelFee === 'number' ? (
            <span>{cancelFee > 0 ? `${money(cancelFee)} cash-only late-cancellation marker recorded; Swift does not collect it.` : 'No cancellation fee recorded by the server.'}</span>
          ) : null}
        </div>
      ) : null}

      {stopped && mmgAmbiguous ? (
        <div className={styles.moneyNotice} role="note">
          If you already sent the MMG payment, the business refunds you directly; Swift never held it.
        </div>
      ) : null}

      {holdActive ? (
        <section className={styles.holdCard} aria-labelledby="hold-title">
          <div>
            <p className={styles.eyebrow}>Server-set order hold</p>
            <h2 id="hold-title" className={styles.cardTitle}>A short window before the store sees it</h2>
            <p className={styles.mutedCopy}>
              {mmgAmbiguous
                ? 'The order is waiting. If you already paid by MMG, the store handles any refund directly.'
                : 'You can cancel without a fee while this hold is active. Swift is holding the order, not your money.'}
            </p>
          </div>
          <div className={styles.timer} role="timer" aria-label={`${formatRemaining(holdExpiryMs - now)} remains in the server order hold`}>
            <span>{formatRemaining(holdExpiryMs - now)}</span>
            <small>remaining</small>
          </div>
        </section>
      ) : null}

      {!stopped ? (
        <section className={styles.progressCard} aria-labelledby="progress-title">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Live status</p>
              <h2 id="progress-title" className={styles.cardTitle}>{isTaxi ? 'From request to drop-off' : 'From order to handover'}</h2>
            </div>
            {order.estimatedPrepTime ? <span className={styles.estimate}>About {order.estimatedPrepTime} min prep</span> : null}
          </div>
          <ol className={styles.statusRail} style={{ '--swift-stage-count': stages.length } as CSSProperties}>
            {stages.map((stage, index) => {
              const reached = index <= currentStage;
              const current = index === currentStage && !completed;
              return (
                <li key={stage.label} className={reached ? styles.stageReached : ''} aria-current={current ? 'step' : undefined}>
                  <span className={styles.stageDot}>{index < currentStage || completed ? '✓' : index + 1}</span>
                  <span>{stage.label}</span>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      <div className={styles.detailGrid}>
        <div className={styles.mainColumn}>
          {order.rider ? (
            <section className={styles.card} aria-labelledby="rider-title">
              <div className={styles.sectionHeading}>
                <div>
                  <p className={styles.eyebrow}>{isTaxi ? 'Your driver' : 'Your rider'}</p>
                  <h2 id="rider-title" className={styles.cardTitle}>{riderName || (isTaxi ? 'Driver assigned' : 'Rider assigned')}</h2>
                </div>
                {order.rider.displayRating ? (
                  <span className={styles.rating}><Star size={16} fill="currentColor" aria-hidden="true" /> {order.rider.displayRating}</span>
                ) : null}
              </div>
              <div className={styles.riderDetails}>
                {vehicle ? <p><Truck size={18} aria-hidden="true" /> {vehicle}</p> : null}
                {order.rider.licensePlate ? <p className={styles.plate}>Plate {order.rider.licensePlate}</p> : null}
                {order.rider.phone ? (
                  <a href={`tel:${order.rider.phone}`} className={styles.secondaryButton}>
                    <Phone size={18} aria-hidden="true" /> {isTaxi ? 'Call driver' : 'Call rider'}
                  </a>
                ) : null}
              </div>
            </section>
          ) : null}

          {isTaxi && order.pickupAddress ? (
            <section className={styles.card} aria-labelledby="pickup-title">
              <div className={styles.iconTitle}>
                <MapPin size={22} aria-hidden="true" />
                <div>
                  <p className={styles.eyebrow}>Pickup</p>
                  <h2 id="pickup-title" className={styles.cardTitle}>{order.pickupAddress}</h2>
                </div>
              </div>
            </section>
          ) : null}

          {destination ? (
            <section className={styles.card} aria-labelledby="destination-title">
              <div className={styles.iconTitle}>
                <MapPin size={22} aria-hidden="true" />
                <div>
                  <p className={styles.eyebrow}>{isTaxi ? 'Drop-off' : order.fulfillment === 'PICKUP' ? 'Collect from' : order.fulfillment === 'APPOINTMENT' ? 'Appointment location' : 'Deliver to'}</p>
                  <h2 id="destination-title" className={styles.cardTitle}>{destination}</h2>
                </div>
              </div>
              {order.pickupCode ? (
                <div className={styles.pickupCode}>
                  <span>Show this pickup code</span>
                  <strong>{order.pickupCode}</strong>
                </div>
              ) : null}
            </section>
          ) : null}

          {(order.timeline?.length ?? 0) > 0 ? (
            <section className={styles.card} aria-labelledby="timeline-title">
              <p className={styles.eyebrow}>Server history</p>
              <h2 id="timeline-title" className={styles.cardTitle}>{isTaxi ? 'Ride timeline' : 'Order timeline'}</h2>
              <ol className={styles.timeline}>
                {order.timeline?.map((event, index) => (
                  <li key={`${event.status}-${event.timestamp}-${index}`}>
                    <span className={styles.timelineDot} aria-hidden="true" />
                    <div>
                      <strong>{event.status.replaceAll('_', ' ').toLowerCase()}</strong>
                      <time dateTime={event.timestamp}>{formatEventTime(event.timestamp)}</time>
                      {event.note ? <p>{event.note}</p> : null}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>

        <aside className={styles.summaryCard} aria-labelledby="summary-title">
          <p className={styles.eyebrow}>Receipt preview</p>
          <h2 id="summary-title" className={styles.cardTitle}>{isTaxi ? 'Your ride' : 'Your order'}</h2>
          <div className={styles.orderLines}>
            {(order.items ?? []).map((item, index) => (
              <div key={item.id ?? `${item.name}-${index}`} className={styles.line}>
                <span>{item.quantity}× {item.name}</span>
                <strong>{money(item.lineTotal ?? Number(item.customerPrice ?? 0) * item.quantity)}</strong>
              </div>
            ))}
          </div>
          <div className={styles.breakdown}>
            {typeof order.subtotalCustomer === 'number' ? <div className={styles.line}><span>{isTaxi ? 'Fare' : 'Items'}</span><strong>{money(order.subtotalCustomer)}</strong></div> : null}
            {!isTaxi && typeof order.deliveryFee === 'number' ? <div className={styles.line}><span>Delivery fee</span><strong>{money(order.deliveryFee)}</strong></div> : null}
            {Number(order.discount ?? 0) > 0 ? <div className={styles.line}><span>Discount</span><strong>−{money(Number(order.discount))}</strong></div> : null}
            {Number(order.tipAmount ?? 0) > 0 ? <div className={styles.line}><span>{isTaxi ? 'Driver tip' : 'Rider tip'}</span><strong>{money(Number(order.tipAmount))}</strong></div> : null}
            <div className={styles.totalLine}><span>Total</span><strong>{money(order.totalAmount ?? order.total ?? 0)}</strong></div>
          </div>
          {showPaymentTruth ? (
            <div className={styles.cashTruth}>
              <Banknote size={22} aria-hidden="true" />
              <div>
                <strong>
                  {failed
                    ? paymentFailed ? 'Payment was not collected' : 'Closed order payment status'
                    : paymentRefunded
                    ? 'Payment marked refunded'
                    : order.paymentMethod === 'MOBILE_MONEY'
                      ? refunded && paymentCaptured ? 'Business received the MMG payment' : paymentCaptured ? 'Business confirmed MMG received' : 'MMG goes to the business'
                      : order.paymentMethod === 'CASH'
                        ? refunded && paymentCaptured
                          ? 'Cash was recorded before the refund'
                          : paymentCaptured
                            ? isTaxi ? 'Cash received after the ride' : order.fulfillment === 'DELIVERY' ? 'Cash received at handover' : 'Business confirmed cash received'
                            : completed
                              ? 'Cash status awaiting confirmation'
                              : isTaxi ? 'Cash due to the driver' : order.fulfillment === 'DELIVERY' ? 'Cash due at handover' : 'Cash due to the business'
                        : 'Payment status from Swift'}
                </strong>
                <p>
                  {failed
                    ? paymentFailed
                      ? 'Swift’s order record marks this payment failed. Nothing remains due for this closed order, and Swift did not hold any order money.'
                      : paymentCaptured
                        ? 'The business confirmed it received payment directly before this order failed. Swift did not hold the money; contact the business about any refund.'
                        : order.paymentMethod === 'MOBILE_MONEY'
                          ? 'This order is closed and Swift does not show a captured payment. Do not make a new payment. If you already sent MMG, the business handles the refund directly.'
                          : 'This order is closed and Swift does not show confirmed cash receipt. Nothing remains due; Swift did not hold any order money.'
                    : paymentRefunded
                    ? 'Swift’s order record marks this payment refunded. Swift did not hold the order money.'
                    : order.paymentMethod === 'MOBILE_MONEY'
                      ? refunded && paymentCaptured
                        ? 'Swift records the MMG payment as received and the order as refunded. The business handles that refund directly; Swift never held the money.'
                        : paymentCaptured
                          ? 'The business confirmed it received your MMG transfer directly. No additional payment is due through Swift.'
                          : payableMmgAction
                            ? `Swift does not hold this payment. This verified link sends ${money(payableMmgAction.amount)} directly to ${payableMmgAction.recipientName}.`
                            : 'Swift does not hold this payment. No verified MMG payment link is available on this order; do not pay from unverified details.'
                      : order.paymentMethod === 'CASH'
                        ? paymentCaptured
                          ? refunded
                            ? 'Swift records cash received directly and the order as refunded. The business handles that refund; Swift never held the money.'
                            : isTaxi
                              ? 'Swift’s order record confirms cash was received directly after the ride.'
                              : order.fulfillment === 'DELIVERY'
                              ? 'Swift’s order record confirms cash was received directly at handover.'
                              : 'Swift’s order record confirms the business received cash directly.'
                          : completed
                            ? `${isTaxi ? 'The ride' : order.fulfillment === 'APPOINTMENT' ? 'The appointment' : order.fulfillment === 'PICKUP' ? 'The collection' : 'The handover'} is complete, but this order does not yet show confirmed cash receipt.`
                            : `Pay ${isTaxi ? 'the driver' : order.fulfillment === 'DELIVERY' ? 'the rider' : 'the business'} directly. Swift does not hold your money.`
                        : `The server reports ${order.paymentStatus?.toLowerCase() ?? 'an unknown payment state'} for this order.`}
                </p>
                {payableMmgAction ? (
                  <button type="button" className={`${styles.secondaryButton} ${styles.paymentAction}`} disabled={openingPayment} onClick={() => void openVerifiedMmgPayment()}>
                    {openingPayment ? 'Rechecking payment…' : `Pay ${payableMmgAction.recipientName} by MMG`}
                    <ExternalLink size={16} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {error ? <p className={styles.alert} role="alert">{error}</p> : null}

          {canOfferCancellation && !confirmingCancel ? (
            <button
              type="button"
              className={styles.cancelButton}
              onClick={(event) => {
                cancelReturnFocus.current = event.currentTarget;
                setConfirmingCancel(true);
                window.requestAnimationFrame(() => cancelConfirmButton.current?.focus());
              }}
            >
              Review cancellation
            </button>
          ) : null}

          {confirmingCancel && canOfferCancellation ? (
            <div className={`${styles.cancelConfirm} ${effectiveCancelFee > 0 ? styles.cancelWarning : ''}`}>
              <p id="cancellation-quote">
                {effectiveCancelFee > 0
                  ? `Swift’s last server quote shows a ${money(effectiveCancelFee)} cash-only late-cancellation marker. ${mmgAmbiguous ? 'If you already sent MMG, the business refunds you directly. ' : ''}Swift does not collect the marker; the server confirms it when you cancel.`
                  : `Swift’s last server quote showed no fee${order.freeCancellationExpiresAt ? ` through ${formatEventTime(order.freeCancellationExpiresAt)}` : ''}. ${mmgAmbiguous ? 'If you already sent MMG, the business refunds you directly. ' : ''}Swift rechecks the fee before cancelling and never collects a late marker.`}
              </p>
              <div className={styles.confirmActions}>
                <button ref={cancelConfirmButton} type="button" className={styles.primaryButton} aria-describedby="cancellation-quote" disabled={cancelling} onClick={() => void confirmCancellation()}>
                  {cancelling ? 'Cancelling…' : 'Confirm cancellation'}
                </button>
                <button type="button" className={styles.secondaryButton} disabled={cancelling} onClick={closeCancellationReview}>
                  Keep order
                </button>
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
