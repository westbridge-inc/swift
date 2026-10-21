'use client';

import CartSkeleton from '@/app/(app)/cart/loading';
import { useOrderingContext, type OrderingMode } from '@/components/ordering-context';
import { FulfilmentChoice } from '@/components/checkout/fulfilment-choice';
import { todayHours } from '@/lib/store-hours';
import { useGuestBasket } from '@/lib/basket-state';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { MapPin, Minus, Plus, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { BackButton, useOwnBackButton } from '@/components/customer-shell';
import { Pictogram } from '@/components/glyphs';
import { useCustomerSession } from '@/components/customer-session';
import { customerCartKey } from '@/lib/cart-key';
import {
  addAddress,
  cartQuoteFingerprint,
  checkout,
  checkoutAttemptSignature,
  clearCheckoutAttempt,
  getAddresses,
  getCart,
  getPublicStorefront,
  getPublicVendor,
  money,
  persistCheckoutAttempt,
  readCheckoutAttempt,
  removeCartLine,
  setCartAddress,
  updateCartLine,
  type Cart,
} from '@/lib/customer';
import { getCartQuote, pickupChoices, quoteStoreIds, removeCartPromotion } from '@/lib/cart-quote';
import type { NewAddress } from '@/components/checkout/new-address-form';
import { MONEY_UNKNOWN, parseAmount, sumAmounts } from '@/lib/money';
import { photo } from '@/lib/media';
import { ApiRequestError } from '@/lib/auth';
import {
  cartPaymentOptions,
  checkoutPaymentFields,
  checkoutPaymentMethod,
  mmgOffered,
  normalizeCartPaymentCapabilities,
  reconcileCartPaymentSelection,
  selectCartPaymentMethod,
  type CartPaymentSelection,
} from '@/lib/app-rules';
import styles from '@/app/(app)/cart/cart.module.css';
import { lazyRetry } from '@/lib/chunk-retry';

const TIPS = [0, 200, 500, 1000];
const GuestCart = lazyRetry(() => import('@/components/guest-basket').then(module => ({ default: module.GuestCart })));
// [WEB-PIN] Only a customer adding an address opens this form (a pin on the
// map), so it loads on demand and the map's code never weighs on the checkout.
const NewAddressForm = lazyRetry(() => import('@/components/checkout/new-address-form').then(module => ({ default: module.NewAddressForm })));

/** The checkout page for whoever is here: a guest sees their browser basket
 *  and signs in at Place order; a signed-in customer gets the one checkout. */
export function Checkout() {
  const { status } = useCustomerSession();
  const basket = useGuestBasket();
  if (status === 'checking' || !basket.loaded) return <CartSkeleton />;
  if (status !== 'signed-in' || basket.lines.length) return <Suspense fallback={<CartSkeleton />}><GuestCart /></Suspense>;
  return <CheckoutPanel />;
}

/** [W4] The ONE checkout: every order on the website is placed here, from
 *  the store page and the cart alike (one place, one set of safety checks). */
export function CheckoutPanel() {
  // [W5] Delivery or pickup: the one ordering context holds the choice (the
  // bar above and the store's order panel set the same one).
  const { mode: orderingMode, setMode: setOrderingMode } = useOrderingContext();
  const pickup = orderingMode === 'PICKUP';
  const router = useRouter();
  // [WEB-REDESIGN] Every fresh read of the cart also updates the count the
  // rail and the dock show, so the badge never disagrees with this page.
  const { scope, epoch } = useCustomerSession();
  const queryClient = useQueryClient();
  const [cart, setCart] = useState<Cart | null>(null);
  // The cart draws its own Back beside its title only once it has lines; in
  // its loading, error and empty states the shell's Back row stays.
  useOwnBackButton(Boolean(cart?.items?.length));
  const [addresses, setAddresses] = useState<any[]>([]);
  const [addrId, setAddrId] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [tip, setTip] = useState(0); // SWIFT-071: no pre-selected tip — the rider tip is opt-in
  // [Q7b] Cash, or the business's own MMG when the server says THIS cart can
  // take it — the phone app's rules, imported. Cash until chosen otherwise.
  const [paySelection, setPaySelection] = useState<CartPaymentSelection>({ method: 'CASH', scope: '' });
  const [cartSafety, setCartSafety] = useState<'checking' | 'safe' | 'blocked'>('checking');
  const [cartSafetyMessage, setCartSafetyMessage] = useState('Swift is checking this saved cart against the live store menu.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noRiders, setNoRiders] = useState(false);
  const [addingAddr, setAddingAddr] = useState(false);
  // [WEB-PIN] The server's own words when it will not price a just-pinned
  // address (e.g. past the store's delivery radius), shown where it was chosen.
  const [pinRefusal, setPinRefusal] = useState<string | null>(null);
  // A cancelled address form hands focus back to the button that opened it.
  const addAddressButton = useRef<HTMLButtonElement | null>(null);
  const refocusAddAddress = useRef(false);
  useEffect(() => {
    if (addingAddr || !refocusAddAddress.current) return;
    refocusAddAddress.current = false;
    addAddressButton.current?.focus();
  }, [addingAddr]);
  // [W5] The live store a pickup is collected from, read with the safety check.
  const [pickupStore, setPickupStore] = useState<{ address: string; hours: string | null } | null>(null);
  // [W5] The stores the last quote priced: a pickup quote names every one.
  const quoteStores = useRef<string[]>([]);
  const safetyNotice = useRef<HTMLDivElement | null>(null);
  const checkoutRail = useRef<HTMLElement | null>(null);
  const errorMessage = useRef<HTMLParagraphElement | null>(null);

  // [REPORT-012 F-012-01] Show the tip the cart will actually charge: hydrate
  // the selector ONCE from the persisted cart tip (it may have been set from
  // another surface/session). Checkout always submits the selection
  // explicitly, so what this screen displays is exactly what is charged —
  // "No tip" selected means tipAmount: 0 goes to the server, which now
  // honors an explicit zero.
  const tipHydrated = useRef(false);
  const checkoutAttempt = useRef<{ signature: string; key: string } | null>(null);
  const checkoutBusy = useRef(false);
  const refreshSequence = useRef(0);
  async function refresh(options: { announceChecking?: boolean } = {}): Promise<{ cart: Cart; safe: boolean } | null> {
    const request = ++refreshSequence.current;
    if (options.announceChecking !== false) setCartSafety('checking');
    const [cartResult, addressResult] = await Promise.allSettled([readQuote(), getAddresses()]);
    if (request !== refreshSequence.current) return null;
    if (cartResult.status === 'rejected') {
      const message = cartResult.reason instanceof Error ? cartResult.reason.message : 'Could not load the live cart.';
      setCartSafety('blocked');
      setCartSafetyMessage('Swift could not refresh the live cart. Checkout stays locked until the server responds; use Check cart again below.');
      setError(message);
      throw cartResult.reason;
    }
    const c = cartResult.value;
    const a = addressResult.status === 'fulfilled' ? addressResult.value : [];
    setCart(c); setAddresses(a); setError(null);
    queryClient.setQueryData(customerCartKey(scope, epoch), c);
    setAddressError(addressResult.status === 'rejected'
      ? addressResult.reason instanceof Error ? addressResult.reason.message : 'Could not load your delivery addresses.'
      : null);
    // A pickup quote is priced with no tip, so only a delivery quote carries the cart's own tip.
    if (!tipHydrated.current && !pickup) { tipHydrated.current = true; setTip(Number(c?.tipAmount) || 0); }
    const def = a.find((x: any) => x.id === c?.deliveryAddress?.id) ?? a.find((x: any) => x.isDefault) ?? a[0];
    setAddrId(def?.id ?? null);

    if (!c.items.length) {
      checkoutAttempt.current = null;
      clearCheckoutAttempt();
      setCartSafety('safe');
      setCartSafetyMessage('');
      return { cart: c, safe: true };
    }
    const block = (message: string) => {
      setCartSafety('blocked');
      setCartSafetyMessage(message);
      return { cart: c, safe: false };
    };
    if (!c.vendor?.id || !c.vendor.slug) {
      return block('Swift cannot identify one live store quote for this saved cart. Remove its items and start again from a store page.');
    }
    if (c.items.some((line) => line.isAvailable === false)) {
      return block('At least one saved item is no longer available. Remove unavailable items before ordering.');
    }
    const fulfillmentModes = new Set(c.items.map((line) => line.fulfillment));
    if (fulfillmentModes.size !== 1 || !fulfillmentModes.has('DELIVERY')) {
      return block(fulfillmentModes.has('PICKUP')
        ? 'Pickup-only items are ordered in the Swift app for now. Remove those lines to order on the web.'
        : fulfillmentModes.has('APPOINTMENT')
          ? 'Appointment checkout is not available on the web yet. Remove those lines to continue with a delivery order.'
          : 'This cart mixes or omits fulfilment modes, so Swift will not show or submit one aggregate total.');
    }
    // [W5 · review S2] Any promotion, even one that discounts nothing here (a
    // free-delivery code under pickup): checkout would still spend its use.
    if (c.promoCode?.code || Number(c.discount ?? 0) > 0) {
      return block('This saved cart has a promotion. A cart with a promotion is ordered in the Swift app for now; remove the promotion to order it here.');
    }
    if (pickup) {
      // [W5] Never a delivery total under a pickup label: every store in the
      // basket must come back priced for pickup, with no delivery fee.
      if (!confirmsPickup(c)) {
        return block('Swift could not confirm a pickup price for this cart. Checkout stays locked until the server prices it for pickup; check the cart again, or choose delivery.');
      }
    } else {
      const quotedDistance = Number(c.deliveryDistanceKm ?? c.vendor.distanceKm);
      const deliveryRadius = Number(c.vendor.deliveryRadius);
      if (Number.isFinite(quotedDistance) && Number.isFinite(deliveryRadius) && quotedDistance > deliveryRadius) {
        return block(`This address is ${quotedDistance.toFixed(1)} km from the store, outside its ${deliveryRadius.toFixed(1)} km delivery radius. Choose another saved address before ordering.`);
      }
    }
    try {
      const liveStore = await getPublicStorefront(c.vendor.slug);
      if (request !== refreshSequence.current) return null;
      if (liveStore.id !== c.vendor.id) {
        return block('The public store no longer matches this saved cart. Remove its items and start again from a live store page.');
      }
      setPickupStore({ address: [liveStore.addressLine1, liveStore.city].filter(Boolean).join(', '), hours: todayHours(liveStore.operatingHours) });
      if (!liveStore.isCurrentlyOpen || !liveStore.acceptingOrders) {
        return block(liveStore.isCurrentlyOpen
          ? 'This store has paused orders. Checkout stays locked until the live store starts taking orders again.'
          : 'This store is closed right now. Checkout stays locked until the live store is open.');
      }
      const vendor = await getPublicVendor(c.vendor.id);
      if (request !== refreshSequence.current) return null;
      const liveItemIds = new Set(vendor.categories.flatMap((category) => category.items.map((item) => item.id)));
      if (c.items.some((line) => !liveItemIds.has(line.itemId))) {
        return block('These saved lines do not all belong to the store behind the server quote. Remove them and start a fresh single-store order.');
      }
      setCartSafety('safe');
      setCartSafetyMessage('');
      return { cart: c, safe: true };
    } catch {
      if (request !== refreshSequence.current) return null;
      return block('Swift could not verify this saved cart against the live store menu. Checkout stays locked until that server truth is available.');
    }
  }
  useEffect(() => { refresh().catch((e) => setError(e.message)); }, [pickup]);

  /** [W5] The quote for the customer's choice. Pickup is asked for every store
   *  in the basket (the phone app's choices); the stores come from the cart's
   *  own lines, so a basket whose stores changed is asked again. */
  async function readQuote(): Promise<Cart> {
    if (!pickup) return getCart();
    let asked = quoteStores.current;
    let quote = await (asked.length ? getCartQuote(pickupChoices(asked)) : getCart());
    for (let again = 0; again < 2; again += 1) {
      const stores = quoteStoreIds(quote.items);
      if (!stores.length || stores.join() === asked.join()) break;
      asked = stores;
      quote = await getCartQuote(pickupChoices(stores));
    }
    quoteStores.current = asked;
    return quote;
  }

  /** [W5] The server priced exactly this basket's stores for pickup, with no delivery fee. */
  function confirmsPickup(quote: Cart): boolean {
    const stores = quoteStoreIds(quote.items);
    const rows = quote.vendors ?? [];
    return stores.length > 0
      && stores.join() === quoteStores.current.join()
      && rows.length === stores.length
      && rows.every((row) => stores.includes(row.vendorId) && row.fulfillment === 'PICKUP' && parseAmount(row.deliveryFee) === 0)
      && parseAmount(quote.deliveryFee ?? 0) === 0
      && parseAmount(quote.tipAmount ?? 0) === 0;
  }

  const subtotal = (cart?.items ?? []).reduce((s, l) => s + (l.customerPrice ?? 0) * l.quantity, 0);
  // SWIFT-071: the total must reflect the DELIVERY FEE (and discount), not just
  // items + tip. Delivery fee and discount are server-computed money; only the
  // tip is the shopper's live selection.
  // [W-13] These arrive from a Prisma `Decimal`, which crosses the wire as a
  // STRING. The type here says `number` and nothing enforced it, so this line
  // was one schema change away from `"4000" + 500` — a displayed and submitted
  // total off by a factor of a thousand. Each part is parsed exactly; if any
  // one of them is not money, there is no total and checkout says so rather
  // than showing a figure built from a part that was quietly read as zero.
  // [W5] Pickup has no rider, so no rider tip.
  const effectiveTip = pickup ? 0 : tip;
  const serverSubtotal = parseAmount(cart?.subtotalCustomer) ?? subtotal;
  const deliveryFee = parseAmount(cart?.deliveryFee) ?? 0;
  const discount = parseAmount(cart?.discount) ?? 0;
  const totalParts = cart
    ? sumAmounts(cart.subtotalCustomer ?? subtotal, cart.deliveryFee ?? 0, -(parseAmount(cart.discount) ?? 0), effectiveTip)
    : subtotal + effectiveTip;
  const total = totalParts;
  const moneyUnreadable = cart != null && totalParts === null;
  const meetsMinimum = cart?.meetsMinimum ?? true;
  const minimumShortfall = Math.max(0, Number(cart?.minimumOrderAmount ?? 0) - serverSubtotal);
  const hasDestinationQuote = Boolean(addrId && cart?.deliveryAddress?.id === addrId);
  // Pickup needs no destination: its quote is the price.
  const hasQuote = pickup || hasDestinationQuote;
  const knownDeliveryDistance = Number(cart?.deliveryDistanceKm ?? cart?.vendor?.distanceKm);
  const knownDeliveryRadius = Number(cart?.vendor?.deliveryRadius);
  const knownOutOfRange = Number.isFinite(knownDeliveryDistance)
    && Number.isFinite(knownDeliveryRadius)
    && knownDeliveryDistance > knownDeliveryRadius;
  const paymentCapabilities = useMemo(
    () => normalizeCartPaymentCapabilities(cart?.paymentCapabilities),
    [cart?.paymentCapabilities],
  );
  const effectivePaySelection = reconcileCartPaymentSelection(paySelection, paymentCapabilities);
  // The phone app's own payment cards; pickup is paid at the counter.
  const paymentOptions = cartPaymentOptions(paymentCapabilities, { appointmentOnly: false, pickup });
  const payByMmg = effectivePaySelection.method === 'MMG';

  function resetCheckoutReplay() {
    checkoutAttempt.current = null;
    clearCheckoutAttempt();
  }

  function cartMutationLockedByCheckout() {
    const pending = checkoutAttempt.current ?? readCheckoutAttempt();
    if (!pending) return false;
    checkoutAttempt.current = pending;
    setError('A checkout attempt still has an unresolved server outcome. Check Orders or retry the same order before changing this cart.');
    return true;
  }

  /** A different way to pay is a different order request: like the tip, it
   *  starts a fresh checkout attempt, and never under an unresolved one. */
  function choosePayment(method: CartPaymentSelection['method']) {
    if (checkoutBusy.current || cartMutationLockedByCheckout()) return;
    resetCheckoutReplay();
    setPaySelection(selectCartPaymentMethod(method, paymentCapabilities));
  }

  /** [W5] Delivery or pickup is a different order request: like the tip and
   *  the payment, it starts a fresh checkout attempt, never under an
   *  unresolved one. The ordering context remembers it for the visit. */
  function chooseFulfilment(next: OrderingMode) {
    if (next === orderingMode || checkoutBusy.current || cartMutationLockedByCheckout()) return;
    resetCheckoutReplay();
    setError(null);
    setNoRiders(false);
    setOrderingMode(next);
  }

  async function mutateCart(work: () => Promise<unknown>) {
    if (checkoutBusy.current || cartMutationLockedByCheckout()) return;
    checkoutBusy.current = true;
    resetCheckoutReplay();
    setBusy(true); setError(null);
    try {
      await work();
      await refresh();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'Could not update your cart.');
    } finally {
      checkoutBusy.current = false;
      setBusy(false);
    }
  }

  /** [WEB-PIN] A pinned address is saved, then THIS cart is priced for it: the
   *  server checks the store's delivery radius on PUT /cart/address and returns
   *  the quote — the phone app's order (AddressesScreen, selectFor 'cart'). */
  async function saveAddress(fields: NewAddress) {
    if (checkoutBusy.current || cartMutationLockedByCheckout()) return;
    checkoutBusy.current = true;
    resetCheckoutReplay();
    setBusy(true); setError(null); setPinRefusal(null);
    try {
      const a = await addAddress({ ...fields, isDefault: addresses.length === 0 });
      setAddingAddr(false);
      let refusal: string | null = null;
      try {
        await setCartAddress(a.id);
      } catch (quoteError) {
        refusal = quoteError instanceof Error ? quoteError.message : 'Swift could not price delivery to that pin.';
      }
      await refresh();
      if (refusal) setPinRefusal(refusal);
    } catch (e: any) { setError(e.message); }
    finally { checkoutBusy.current = false; setBusy(false); }
  }

  async function recheckCartSafety() {
    try {
      await refresh({ announceChecking: false });
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Could not reload your cart.');
    } finally {
      window.requestAnimationFrame(() => checkoutRail.current?.focus());
    }
  }

  /** The total a refreshed server quote comes to, with this page's tip. */
  function refreshedTotal(quote: Cart) {
    const refreshedSubtotal = quote.subtotalCustomer
      ?? quote.subtotal
      ?? quote.items.reduce((sum, line) => sum + line.customerPrice * line.quantity, 0);
    return money(
      refreshedSubtotal
      + Number(quote.deliveryFee ?? 0)
      - Number(quote.discount ?? 0)
      + effectiveTip,
    );
  }

  async function placeOrder() {
    if (!cart?.items?.length || checkoutBusy.current || cartSafety !== 'safe' || (!pickup && !addrId) || !meetsMinimum) return;
    checkoutBusy.current = true;
    setBusy(true); setError(null); setNoRiders(false);
    try {
      const proof = await refresh({ announceChecking: false });
      if (!proof?.safe) {
        window.requestAnimationFrame(() => safetyNotice.current?.focus());
        return;
      }
      const liveCart = proof.cart;
      if (!liveCart.items.length) {
        resetCheckoutReplay();
        router.push('/orders');
        return;
      }
      if (cartQuoteFingerprint(liveCart) !== cartQuoteFingerprint(cart)) {
        setError(`Swift refreshed this saved cart to ${refreshedTotal(liveCart)}. Review the live lines and server quote, then place the order again.`);
        return;
      }
      // [Q7b] The method is read against the LIVE cart's capability. A choice
      // of MMG that the refreshed cart can no longer take is never quietly
      // turned into cash: the customer is told, and places the order again.
      const liveCapabilities = normalizeCartPaymentCapabilities(liveCart.paymentCapabilities);
      const paymentMethod = checkoutPaymentMethod(effectivePaySelection, liveCapabilities);
      if (payByMmg && paymentMethod !== 'MOBILE_MONEY') {
        setPaySelection(selectCartPaymentMethod('CASH', liveCapabilities));
        setError('MMG is no longer available for this order, so Swift switched it to cash. Review the payment, then place the order again.');
        window.requestAnimationFrame(() => errorMessage.current?.focus());
        return;
      }
      // [L09 · price lock] The total and line prices this page showed: the
      // server refuses with PRICE_CHANGED (old → new) if the order would
      // charge anything else, so a price changed since is never charged unseen.
      const expectedLines = cart.items.flatMap((line) => {
        const unitPrice = parseAmount(line.customerPrice);
        return unitPrice === null ? [] : [{ lineId: line.id, unitPrice }];
      });
      // [W5] Pickup: the same choices that priced the quote go in the order.
      const pickupOrder = pickup ? pickupChoices(quoteStoreIds(liveCart.items)) : null;
      // [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] MMG goes to the store's NUMBER when the server offers it (the
      // shared phone rule): the server is told, so it never answers with the old pay-link flow.
      const body = {
        ...checkoutPaymentFields(effectivePaySelection, liveCapabilities),
        tipAmount: pickupOrder ? pickupOrder.tipAmount : tip,
        ...(pickupOrder ? { fulfillmentSelections: pickupOrder.fulfillmentSelections } : {}),
        // [W5 · review S2] A web order never names a promotion.
        ...(total !== null ? { expectedTotal: total } : {}),
        expectedLines,
      };
      const signature = checkoutAttemptSignature(liveCart, body);
      const storedAttempt = checkoutAttempt.current ?? readCheckoutAttempt();
      if (storedAttempt && storedAttempt.signature !== signature) {
        checkoutAttempt.current = storedAttempt;
        setError('An earlier checkout attempt still has an unresolved server outcome. Check Orders before changing or placing this cart; Swift will not create a second attempt with a new key.');
        return;
      }
      const attempt = storedAttempt;
      checkoutAttempt.current = attempt;
      const retrying = Boolean(attempt);
      if (!retrying && !pickup && addrId) {
        const quotedCart = await setCartAddress(addrId);
        if (cartQuoteFingerprint(quotedCart) !== cartQuoteFingerprint(liveCart)) {
          setCart(quotedCart);
          const quotedTotal = refreshedTotal(quotedCart);
          await refresh({ announceChecking: false });
          setError(`Swift refreshed this order to ${quotedTotal}. Review the new server total, then place the order again.`);
          window.requestAnimationFrame(() => errorMessage.current?.focus());
          return;
        }
        setCart(quotedCart);
      }
      const idempotencyKey = attempt?.key ?? crypto.randomUUID();
      checkoutAttempt.current = { signature, key: idempotencyKey };
      persistCheckoutAttempt({ signature, key: idempotencyKey });
      const res = await checkout(body, idempotencyKey);
      resetCheckoutReplay();
      const oid = res.order?.id ?? res.orders?.[0]?.id;
      router.push(oid ? `/orders/${oid}` : '/orders');
    } catch (e: any) {
      const message = e instanceof Error ? e.message : 'Could not place this order.';
      if (/selfie|profile photo/i.test(message)) {
        resetCheckoutReplay();
        router.push('/selfie?next=%2Fcart');
        return;
      }
      const definiteRejection = e instanceof ApiRequestError
        && e.status >= 400
        && e.status < 500
        && e.code !== 'DUPLICATE_REQUEST';
      let cartReconciled = false;
      try {
        const reconciledCart = await getCart();
        if (reconciledCart.items.length === 0) {
          resetCheckoutReplay();
          router.push('/orders');
          return;
        }
        await refresh({ announceChecking: false });
        cartReconciled = true;
      } catch {
        // Keep the key if server cart truth is unreachable. It is safer to
        // replay one attempt than to create a new potentially duplicate order.
      }
      if (definiteRejection && cartReconciled) resetCheckoutReplay();
      // The server refused the MMG destination at checkout: this cart goes
      // back to cash for its current scope, as in the phone app.
      if (e instanceof ApiRequestError && e.code?.startsWith('MMG_')) {
        setPaySelection(selectCartPaymentMethod('CASH', paymentCapabilities));
      }
      // The server's own answer (order.service.ts): 409 DELIVERY_NO_RIDERS.
      if (e instanceof ApiRequestError && e.code === 'DELIVERY_NO_RIDERS') setNoRiders(true);
      else setError(message);
      window.requestAnimationFrame(() => (errorMessage.current ?? checkoutRail.current)?.focus());
    } finally { checkoutBusy.current = false; setBusy(false); }
  }

  async function changeAddress(nextAddressId: string) {
    if (checkoutBusy.current || cartMutationLockedByCheckout()) return;
    const previous = addrId;
    checkoutBusy.current = true;
    resetCheckoutReplay();
    setBusy(true); setError(null); setPinRefusal(null); setAddrId(nextAddressId);
    try {
      await setCartAddress(nextAddressId);
      await refresh();
    } catch (addressError: any) {
      setAddrId(previous);
      setError(addressError.message);
    } finally {
      checkoutBusy.current = false;
      setBusy(false);
    }
  }

  if (!cart && error) return (
    <section className={styles.stateCard} role="alert">
      <span className="sw-empty-tile"><Pictogram name="groceries" size={40} /></span>
      <h1 className={styles.stateTitle}>Swift could not load your cart</h1>
      <p className={styles.errorCopy}>{error}</p>
      <button type="button" onClick={() => void refresh().catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : 'Could not load your cart.'))} className={`${styles.button} ${styles.buttonPrimary} ${styles.retryButton}`}>Try again</button>
    </section>
  );
  if (!cart) return <CartSkeleton />;
  if (!cart.items?.length) return (
    <section className={styles.emptyState}>
      <span className="sw-empty-tile"><Pictogram name="groceries" size={40} /></span>
      <h1 className={styles.stateTitle}>Your cart is empty</h1>
      <p className={styles.stateCopy}>Add something good — it lands here.</p>
      <Link href="/" className={styles.emptyLink}>Find food</Link>
    </section>
  );

  const unitCount = cart.items.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
  return (
    <div className={styles.page}>
      <section className={styles.itemsColumn} aria-labelledby="cart-title">
        <div className={styles.titleRow}>
          <BackButton />
          <h1 id="cart-title" className={styles.title}>Cart</h1>
        </div>
        {cart.vendor?.name ? <p className={styles.fromStore}>From <b>{cart.vendor.name}</b></p> : null}
        <div className={styles.lines}>
          {cart.items.map((l) => (
            <article key={l.id} className={styles.itemCard}>
              <span className={styles.thumb}>
                {photo(l.imageUrl) ? <Image {...photo(l.imageUrl)!} alt="" fill sizes="64px" loading="lazy" className="object-cover" /> : <Pictogram name="food" size={26} />}
              </span>
              <div className={styles.itemCopy}>
                <div className={styles.itemTop}>
                  <p className={styles.itemName}>{l.name}</p>
                  {/* The server's own line total, or the em-dash: never price × quantity worked out here. */}
                  <p className={styles.lineTotal}>{money(l.lineTotal)}</p>
                </div>
                {(l.selectedOptionNames?.length ?? 0) > 0 ? <p className={styles.itemMeta}>{l.selectedOptionNames?.join(' · ')}</p> : null}
                <p className={styles.itemPrice}>{money(l.customerPrice)} each</p>
                <div className={styles.itemActions}>
                  <div className={styles.quantity} aria-label={`${l.name} quantity`}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void mutateCart(() => l.quantity <= 1 ? removeCartLine(l.id) : updateCartLine(l.id, l.quantity - 1))}
                      aria-label={`Remove one ${l.name}`}
                      className={styles.quantityButton}
                    ><Minus size={14} aria-hidden /></button>
                    <span className={styles.quantityCount} aria-live="polite">{l.quantity}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void mutateCart(() => updateCartLine(l.id, l.quantity + 1))}
                      aria-label={`Add another ${l.name}`}
                      className={styles.quantityButton}
                    ><Plus size={14} aria-hidden /></button>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void mutateCart(() => removeCartLine(l.id))}
                    aria-label={`Remove ${l.name} from cart`}
                    className={styles.removeButton}
                  ><Trash2 size={18} /></button>
                </div>
              </div>
            </article>
          ))}
        </div>

        <section className={styles.panel} aria-label="Delivery or pickup">
          <FulfilmentChoice name="checkout-fulfilment" value={orderingMode} onChange={chooseFulfilment} disabled={busy} />
        </section>

        {pickup ? (
          <section className={styles.panel} aria-labelledby="pickup-title">
            <div className={styles.panelHeading}>
              <MapPin size={16} aria-hidden="true" />
              <h2 id="pickup-title" className={styles.panelTitle}>Pick up from {cart.vendor?.name ?? 'the store'}</h2>
            </div>
            {pickupStore?.address ? <p className={styles.stateCopy}>{pickupStore.address}</p> : null}
            {pickupStore?.hours ? <p className={styles.stateCopy}>{pickupStore.hours}</p> : null}
            <p className={styles.stateCopy}>No delivery fee</p>
          </section>
        ) : <section className={styles.panel} aria-labelledby="delivery-address-title">
          <div className={styles.panelHeading}>
            <MapPin size={16} aria-hidden="true" />
            <h2 id="delivery-address-title" className={styles.panelTitle}>Deliver to</h2>
          </div>
          {addressError ? (
            <div className={styles.panelStack} role="alert">
              <p className={styles.errorMessage}>{addressError}</p>
              <button type="button" className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => void refresh().catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : 'Could not reload your cart.'))}>Try addresses again</button>
            </div>
          ) : (
            <>
              {addresses.length > 0 ? (
                <div className={styles.field}>
                  <label htmlFor="cart-delivery-address" className={styles.label}>Saved delivery address</label>
                  <select id="cart-delivery-address" value={addrId ?? ''} disabled={busy || (cartSafety !== 'safe' && !knownOutOfRange)} onChange={(e) => void changeAddress(e.target.value)} className={styles.input}>
                    {addresses.map((a) => <option key={a.id} value={a.id}>{a.label} — {a.addressLine1}, {a.city}</option>)}
                  </select>
                </div>
              ) : null}
              {pinRefusal ? <p className={styles.errorMessage} role="alert">{pinRefusal}</p> : null}
              {/* [WEB-PIN] A new address is always on offer — a customer whose
                  saved addresses are all wrong for this order can pin another. */}
              {addingAddr ? (
                <Suspense fallback={<p className={styles.stateCopy} role="status">Opening the map…</p>}>
                  <NewAddressForm busy={busy} onSave={(fields) => void saveAddress(fields)} onCancel={() => { refocusAddAddress.current = true; setAddingAddr(false); }} />
                </Suspense>
              ) : (
                <button ref={addAddressButton} type="button" disabled={busy} onClick={() => { setPinRefusal(null); setAddingAddr(true); }} className={`${styles.button} ${styles.buttonSecondary}`}>
                  {addresses.length > 0 ? 'Pin a new address on the map' : 'Add a delivery address'}
                </button>
              )}
            </>
          )}
        </section>}

        {pickup ? null : <section className={styles.panel} aria-labelledby="tip-title">
          <h2 id="tip-title" className={styles.panelTitle}>Tip your rider</h2>
          <div className={styles.tipGrid}>
            {TIPS.map((t) => (
              <button key={t} type="button" aria-pressed={tip === t} disabled={busy || cartSafety !== 'safe'} onClick={() => { if (checkoutBusy.current || cartMutationLockedByCheckout()) return; resetCheckoutReplay(); setTip(t); }} className={`${styles.tipButton} ${tip === t ? styles.tipSelected : ''}`}>{t === 0 ? 'No tip' : money(t)}</button>
            ))}
          </div>
        </section>}

        <section className={styles.panel} aria-labelledby="payment-title">
          <h2 id="payment-title" className={styles.panelTitle}>Payment</h2>
          {mmgOffered(paymentCapabilities) ? (
            <div role="radiogroup" aria-labelledby="payment-title" className={styles.payOptions}>
              {paymentOptions.map((option) => (
                <label key={option.key} className={styles.payOption}>
                  <input
                    type="radio"
                    name="payment-method"
                    value={option.key}
                    checked={effectivePaySelection.method === option.key}
                    disabled={busy || cartSafety !== 'safe'}
                    onChange={() => choosePayment(option.key)}
                  />
                  <span className={styles.payOptionCopy}>
                    <span className={styles.cashTitle}>{option.title}</span>
                    <span className={styles.cashCopy}>{option.sub}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <div className={styles.cashPanel}>
              <span className={styles.radioOn} aria-hidden="true" />
              <span className={styles.payOptionCopy}>
                <span className={styles.cashTitle}>{pickup ? paymentOptions[0]!.title : 'Cash at the door'}</span>
                <span className={styles.cashCopy}>{pickup ? paymentOptions[0]!.sub : 'Pay the rider directly when this delivery arrives.'} Swift never holds your order money.</span>
              </span>
            </div>
          )}
        </section>
      </section>

      <aside ref={checkoutRail} tabIndex={-1} className={styles.rail} aria-label="Checkout">
        {cartSafety !== 'safe' ? (
          <div ref={safetyNotice} tabIndex={-1} className={`${styles.safety} ${cartSafety === 'blocked' ? styles.safetyBlocked : styles.safetyNotice}`} role={cartSafety === 'blocked' ? 'alert' : 'status'}>
            <div className={styles.panelStack}>
              <p>{cartSafetyMessage}</p>
              {cartSafety === 'blocked' && (cart.promoCode?.code || discount > 0) ? (
                <button type="button" disabled={busy} onClick={() => void mutateCart(() => removeCartPromotion())} className={`${styles.button} ${styles.buttonSecondary}`}>
                  Remove promotion
                </button>
              ) : null}
              {cartSafety === 'blocked' ? (
                <button type="button" disabled={busy} onClick={() => void recheckCartSafety()} className={`${styles.button} ${styles.buttonSecondary}`}>
                  Check cart again
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {error ? <p ref={errorMessage} tabIndex={-1} className={styles.error} role="alert" aria-live="assertive">{error}</p> : null}

        {cartSafety === 'safe' ? <section className={styles.summary} aria-label="Order total">
          <h2 className={styles.panelTitle}>Order summary</h2>
          <div className={styles.breakdown}>
            <div className={styles.moneyLine}><span className={styles.moneyLabel}>Items ({unitCount})</span><strong className={styles.moneyValue}>{money(serverSubtotal)}</strong></div>
            {pickup
              ? <div className={styles.moneyLine}><span className={styles.moneyLabel}>Pickup</span><strong className={styles.moneyValue}>No delivery fee</strong></div>
              : <div className={styles.moneyLine}><span className={styles.moneyLabel}>Delivery fee</span><strong className={styles.moneyValue}>{hasDestinationQuote ? money(deliveryFee) : 'Choose an address for a quote'}</strong></div>}
            {discount > 0 ? <div className={styles.moneyLine}><span className={styles.moneyLabel}>Discount</span><strong className={styles.moneyValue}>−{money(discount)}</strong></div> : null}
            {pickup ? null : <div className={styles.moneyLine}><span className={styles.moneyLabel}>Rider tip</span><strong className={styles.moneyValue}>{money(tip)}</strong></div>}
            <div className={styles.totalLine}><span>Total</span><strong>{moneyUnreadable ? MONEY_UNKNOWN : hasQuote ? money(total) : 'Quote needed'}</strong></div>
          </div>
          {/* [W-13] A total Swift cannot compute is not shown as a number and
              cannot be ordered against. The old line added a part it could not
              read as if it were zero, or concatenated it as a string. */}
          {moneyUnreadable ? (
            <p role="alert" className={styles.noRidersCopy}>
              Swift cannot read this order&apos;s figures from the server. Checkout stays locked until the total is
              certain — refresh, and contact support if it persists.
            </p>
          ) : null}
          {noRiders && !pickup ? (
            <div className={styles.noRiders}>
              <p className={styles.noRidersCopy}>No delivery riders are online right now.</p>
              {/* [W5] The phone app's answer: collect it yourself. Switching
                  places nothing; the pickup quote is shown before any order. */}
              <button type="button" onClick={() => chooseFulfilment('PICKUP')} disabled={busy} className={`${styles.button} ${styles.buttonPrimary}`}>Order for pickup instead</button>
              <button type="button" onClick={() => void placeOrder()} disabled={busy || moneyUnreadable} className={`${styles.button} ${styles.buttonSecondary}`}>{payByMmg ? 'Try delivery again' : 'Try cash delivery again'}</button>
            </div>
          ) : (
            <button type="button" onClick={() => void placeOrder()} disabled={busy || (!pickup && !addrId) || !meetsMinimum || moneyUnreadable} className={`${styles.button} ${styles.buttonPrimary} ${styles.checkoutButton}`}>
              {busy ? 'Placing…' : !pickup && !addrId ? 'Add a delivery address to order' : !meetsMinimum ? `Add ${money(minimumShortfall)} to reach the minimum` : pickup ? `Place pickup order · ${money(total)}${payByMmg ? ' · pay by MMG' : ''}` : hasDestinationQuote ? (payByMmg ? `Place order · ${money(total)} · pay by MMG` : `Place cash order · ${money(total)}`) : 'Get delivery quote'}
            </button>
          )}
          <p className={styles.payNote}>{payByMmg ? `You’ll pay ${cart.vendor?.name ?? 'the business'} on MMG — Swift never holds your money.` : pickup ? 'Pay in cash when you collect it.' : 'Pay in cash when it arrives.'}</p>
        </section> : null}
      </aside>
    </div>
  );
}
