'use client';

import CartSkeleton from './loading';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Trash2, MapPin } from 'lucide-react';
import {
  addAddress,
  cartQuoteFingerprint,
  checkout,
  checkoutAttemptSignature,
  clearCart,
  clearCheckoutAttempt,
  getAddresses,
  getCart,
  getPublicStorefront,
  getPublicVendor,
  money,
  placeDetails,
  placesAutocomplete,
  persistCheckoutAttempt,
  readCheckoutAttempt,
  removeCartLine,
  removeCartPromo,
  setCartAddress,
  updateCartLine,
  type Cart,
  type Place,
} from '@/lib/customer';
import { MONEY_UNKNOWN, parseAmount, sumAmounts } from '@/lib/money';
import { ApiRequestError } from '@/lib/auth';
import {
  cartPaymentOptions,
  checkoutPaymentMethod,
  normalizeCartPaymentCapabilities,
  reconcileCartPaymentSelection,
  selectCartPaymentMethod,
  type CartPaymentSelection,
} from '@/lib/app-rules';
import { cartErrorMessage, cartStockRefusal, cartStoreGroups, type CartStockRefusal } from '@/lib/cart-presentation';
import styles from './cart.module.css';

const TIPS = [0, 200, 500, 1000];

export default function CartPage() {
  const router = useRouter();
  const [cart, setCart] = useState<Cart | null>(null);
  const [addresses, setAddresses] = useState<any[]>([]);
  const [addrId, setAddrId] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [tip, setTip] = useState(0); // SWIFT-071: no pre-selected tip — the rider tip is opt-in
  // [Q7b] Cash, or the business's own MMG when the server says THIS cart can
  // take it — the phone app's rules, imported. Cash until chosen otherwise.
  const [paySelection, setPaySelection] = useState<CartPaymentSelection>({ method: 'CASH', scope: '' });
  const [cartSafety, setCartSafety] = useState<'checking' | 'safe' | 'blocked'>('checking');
  const [cartSafetyMessage, setCartSafetyMessage] = useState('Checking your items with the store…');
  const [selectedStore, setSelectedStore] = useState<string | null>(null);
  const groups = cart ? cartStoreGroups(cart) : [];
  const mixedStores = groups.length > 1;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stockRefusal, setStockRefusal] = useState<CartStockRefusal | null>(null);
  const [noRiders, setNoRiders] = useState(false);
  const [addingAddr, setAddingAddr] = useState(false);
  const [newAddr, setNewAddr] = useState({ label: '', addressLine1: '', city: '', region: '' });
  const [addressMatches, setAddressMatches] = useState<Place[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<{ label: string; lat: number; lng: number } | null>(null);
  const [addressLookupBusy, setAddressLookupBusy] = useState(false);
  const addressLabelInput = useRef<HTMLInputElement | null>(null);
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
    const [cartResult, addressResult] = await Promise.allSettled([getCart(), getAddresses()]);
    if (request !== refreshSequence.current) return null;
    if (cartResult.status === 'rejected') {
      const message = cartErrorMessage(cartResult.reason, 'Could not load your cart. Please try again.');
      setCartSafety('blocked');
      setCartSafetyMessage('Could not refresh your cart. Please check it again before ordering.');
      setError(message);
      throw cartResult.reason;
    }
    const c = cartResult.value;
    const a = addressResult.status === 'fulfilled' ? addressResult.value : [];
    setCart(c); setAddresses(a); setError(null);
    setStockRefusal((current) => current && c.items.some((line) => line.itemId === current.itemId
      && line.quantity > current.available) ? current : null);
    setAddressError(addressResult.status === 'rejected'
      ? cartErrorMessage(addressResult.reason, 'Could not load your delivery addresses. Please try again.')
      : null);
    if (!tipHydrated.current) { tipHydrated.current = true; setTip(Number(c?.tipAmount) || 0); }
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
    const storeGroups = cartStoreGroups(c);
    if (storeGroups.length > 1) {
      return block(`Your cart has items from ${storeGroups.length} stores. Check out one store at a time.`);
    }
    if (storeGroups[0]?.id && storeGroups[0].id !== c.vendor?.id) {
      return block('We could not confirm this store’s delivery details. Remove these items and add them again from the store to continue.');
    }
    if (!c.vendor?.id || !c.vendor.slug) {
      return block('Could not confirm the store for these items. Remove them and add them again from the store.');
    }
    if (c.items.some((line) => line.isAvailable === false)) {
      return block('An item is no longer available. Remove unavailable items before ordering.');
    }
    const fulfillmentModes = new Set(c.items.map((line) => line.fulfillment));
    if (fulfillmentModes.size !== 1 || !fulfillmentModes.has('DELIVERY')) {
      return block(fulfillmentModes.has('PICKUP')
        ? 'For pickup, please use the Swift phone app. Remove pickup items to continue with delivery here.'
        : fulfillmentModes.has('APPOINTMENT')
          ? 'For appointments, please use the Swift phone app. Remove appointment items to continue with delivery here.'
          : 'Some items cannot be delivered together. Remove them and choose delivery items from the store.');
    }
    if (Number(c.discount ?? 0) > 0) {
      return block('This promotion cannot be used with this delivery. Remove the promo code to continue.');
    }
    const quotedDistance = Number(c.deliveryDistanceKm ?? c.vendor.distanceKm);
    const deliveryRadius = Number(c.vendor.deliveryRadius);
    if (Number.isFinite(quotedDistance) && Number.isFinite(deliveryRadius) && quotedDistance > deliveryRadius) {
      return block(`This address is ${quotedDistance.toFixed(1)} km from the store, outside its ${deliveryRadius.toFixed(1)} km delivery radius. Choose another saved address before ordering.`);
    }
    try {
      const liveStore = await getPublicStorefront(c.vendor.slug);
      if (request !== refreshSequence.current) return null;
      if (liveStore.id !== c.vendor.id) {
        return block('Could not confirm the store for these items. Remove them and add them again from the store.');
      }
      if (!liveStore.isCurrentlyOpen || !liveStore.acceptingOrders) {
        return block(liveStore.isCurrentlyOpen
          ? 'This store has paused orders. Please try again when it is taking orders.'
          : 'This store is closed right now. Please try again when it opens.');
      }
      const vendor = await getPublicVendor(c.vendor.id);
      if (request !== refreshSequence.current) return null;
      const liveItemIds = new Set(vendor.categories.flatMap((category) => category.items.map((item) => item.id)));
      if (c.items.some((line) => !liveItemIds.has(line.itemId))) {
        return block('Some items could not be found at this store. Remove them and add them again from the store.');
      }
      setCartSafety('safe');
      setCartSafetyMessage('');
      return { cart: c, safe: true };
    } catch {
      if (request !== refreshSequence.current) return null;
      return block('Could not check your items with the store. Please try again before ordering.');
    }
  }
  useEffect(() => { refresh().catch((e) => setError(cartErrorMessage(e))); }, []);

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
  const serverSubtotal = parseAmount(cart?.subtotalCustomer) ?? subtotal;
  const deliveryFee = parseAmount(cart?.deliveryFee) ?? 0;
  const discount = parseAmount(cart?.discount) ?? 0;
  const totalParts = cart
    ? sumAmounts(cart.subtotalCustomer ?? subtotal, cart.deliveryFee ?? 0, -(parseAmount(cart.discount) ?? 0), tip)
    : subtotal + tip;
  const total = totalParts;
  const moneyUnreadable = cart != null && totalParts === null;
  const meetsMinimum = cart?.meetsMinimum ?? true;
  const minimumShortfall = Math.max(0, Number(cart?.minimumOrderAmount ?? 0) - serverSubtotal);
  const hasDestinationQuote = Boolean(addrId && cart?.deliveryAddress?.id === addrId);
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
  const payByMmg = effectivePaySelection.method === 'MMG';

  function resetCheckoutReplay() {
    checkoutAttempt.current = null;
    clearCheckoutAttempt();
  }

  function cartMutationLockedByCheckout() {
    const pending = checkoutAttempt.current ?? readCheckoutAttempt();
    if (!pending) return false;
    checkoutAttempt.current = pending;
    setError('Your last order is still being confirmed. Check Your orders or retry it before changing your cart.');
    return true;
  }

  /** A different way to pay is a different order request: like the tip, it
   *  starts a fresh checkout attempt, and never under an unresolved one. */
  function choosePayment(method: CartPaymentSelection['method']) {
    if (checkoutBusy.current || cartMutationLockedByCheckout()) return;
    resetCheckoutReplay();
    setPaySelection(selectCartPaymentMethod(method, paymentCapabilities));
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
      try { await refresh(); } catch { /* Keep checkout blocked if reconciliation fails. */ }
      setError(cartErrorMessage(mutationError));
    } finally {
      checkoutBusy.current = false;
      setBusy(false);
    }
  }

  async function saveAddress() {
    if (checkoutBusy.current || cartMutationLockedByCheckout() || !selectedPlace) return;
    checkoutBusy.current = true;
    resetCheckoutReplay();
    setBusy(true); setError(null);
    try {
      const a = await addAddress({
        label: newAddr.label.trim(),
        addressLine1: selectedPlace.label,
        city: newAddr.city.trim(),
        region: newAddr.region.trim(),
        latitude: selectedPlace.lat,
        longitude: selectedPlace.lng,
        isDefault: addresses.length === 0,
      });
      setAddingAddr(false);
      setNewAddr({ label: '', addressLine1: '', city: '', region: '' });
      setAddressMatches([]);
      setSelectedPlace(null);
      await refresh();
      setAddrId(a.id ?? addrId);
    } catch (e: any) { setError(cartErrorMessage(e)); }
    finally { checkoutBusy.current = false; setBusy(false); }
  }

  async function searchAddress() {
    if (addressLookupBusy || newAddr.addressLine1.trim().length < 3) return;
    setAddressLookupBusy(true);
    setError(null);
    setSelectedPlace(null);
    try {
      const matches = await placesAutocomplete(newAddr.addressLine1.trim());
      setAddressMatches(matches);
      if (!matches.length) setError('Swift found no map matches for that destination. Add more detail and search again.');
    } catch (lookupError) {
      setAddressMatches([]);
      setError(cartErrorMessage(lookupError, 'Could not search for that address. Please try again.'));
    } finally {
      setAddressLookupBusy(false);
    }
  }

  async function chooseAddressMatch(place: Place) {
    if (addressLookupBusy) return;
    setAddressLookupBusy(true);
    setError(null);
    try {
      const details = await placeDetails(place.placeId);
      setSelectedPlace({ label: details.label, lat: details.lat, lng: details.lng });
      setNewAddr((current) => ({ ...current, addressLine1: details.label }));
      setAddressMatches([]);
    } catch (lookupError) {
      setSelectedPlace(null);
      setError(cartErrorMessage(lookupError, 'Could not confirm that address. Please try again.'));
    } finally {
      setAddressLookupBusy(false);
    }
  }

  async function recheckCartSafety() {
    try {
      await refresh({ announceChecking: false });
    } catch (refreshError) {
      setError(cartErrorMessage(refreshError));
    } finally {
      window.requestAnimationFrame(() => checkoutRail.current?.focus());
    }
  }

  async function placeOrder() {
    if (!cart?.items?.length || checkoutBusy.current || cartSafety !== 'safe' || !addrId || !meetsMinimum) return;
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
        const refreshedSubtotal = liveCart.subtotalCustomer
          ?? liveCart.subtotal
          ?? liveCart.items.reduce((sum, line) => sum + line.customerPrice * line.quantity, 0);
        const refreshedTotal = money(
          refreshedSubtotal
          + Number(liveCart.deliveryFee ?? 0)
          - Number(liveCart.discount ?? 0)
          + tip,
        );
        setError(`Your total changed to ${refreshedTotal}. Review your items and total, then place the order again.`);
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
      const body = {
        paymentMethod,
        tipAmount: tip,
        ...(liveCart.promoCode?.code ? { promoCode: liveCart.promoCode.code } : {}),
      };
      const signature = checkoutAttemptSignature(liveCart, body);
      const storedAttempt = checkoutAttempt.current ?? readCheckoutAttempt();
      if (storedAttempt && storedAttempt.signature !== signature) {
        checkoutAttempt.current = storedAttempt;
        setError('Your last order is still being confirmed. Check Your orders before changing your cart or placing another order.');
        return;
      }
      const attempt = storedAttempt;
      checkoutAttempt.current = attempt;
      const retrying = Boolean(attempt);
      if (!retrying) {
        const quotedCart = await setCartAddress(addrId);
        if (cartQuoteFingerprint(quotedCart) !== cartQuoteFingerprint(liveCart)) {
          setCart(quotedCart);
          const refreshedSubtotal = quotedCart.subtotalCustomer
            ?? quotedCart.subtotal
            ?? quotedCart.items.reduce((sum, line) => sum + line.customerPrice * line.quantity, 0);
          const refreshedTotal = money(
            refreshedSubtotal
            + Number(quotedCart.deliveryFee ?? 0)
            - Number(quotedCart.discount ?? 0)
            + tip,
          );
          await refresh({ announceChecking: false });
          setError(`Your total changed to ${refreshedTotal}. Review the new total, then place the order again.`);
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
        && e.status !== 408
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
      if (message.includes('No delivery riders') || message.includes('NO_RIDERS')) setNoRiders(true);
      else {
        setStockRefusal(cartStockRefusal(e, cart));
        setError(cartErrorMessage(e, 'Could not confirm your order. Check Your orders before trying again.', cart));
      }
      window.requestAnimationFrame(() => (errorMessage.current ?? checkoutRail.current)?.focus());
    } finally { checkoutBusy.current = false; setBusy(false); }
  }

  async function changeAddress(nextAddressId: string) {
    if (checkoutBusy.current || cartMutationLockedByCheckout()) return;
    const previous = addrId;
    checkoutBusy.current = true;
    resetCheckoutReplay();
    setBusy(true); setError(null); setAddrId(nextAddressId);
    try {
      await setCartAddress(nextAddressId);
      await refresh();
    } catch (addressError: any) {
      setAddrId(previous);
      setError(cartErrorMessage(addressError, 'Could not update your delivery address. Please try again.'));
    } finally {
      checkoutBusy.current = false;
      setBusy(false);
    }
  }

  if (!cart && error) return (
    <section className={styles.stateCard} role="alert">
      <h1 className={styles.stateTitle}>Swift could not load your cart</h1>
      <p className={styles.errorCopy}>{error}</p>
      <button type="button" onClick={() => void refresh().catch((refreshError) => setError(cartErrorMessage(refreshError)))} className={`${styles.button} ${styles.buttonPrimary} ${styles.retryButton}`}>Try again</button>
    </section>
  );
  if (!cart) return <CartSkeleton />;
  if (!cart.items?.length) return (
    <section className={styles.emptyState}>
      <h1 className={styles.stateTitle}>Your cart is empty</h1>
      <Link href="/" className={styles.emptyLink}>Browse Swift</Link>
    </section>
  );

  return (
    <div className={styles.page}>
      <section className={styles.itemsColumn} aria-labelledby="cart-title">
        <h1 id="cart-title" className={styles.title}>Your cart</h1>
        {mixedStores ? <p className={styles.stateCopy}>Your cart has items from {groups.length} stores. Check out one store at a time.</p> : null}
        {groups.map((group, index) => <section key={group.id ?? 'unknown'} aria-labelledby={`store-${index}`} className={styles.panelStack}>
          <h2 id={`store-${index}`} className={styles.panelTitle}>{group.name}</h2>
          {group.items.map((l) => (
          <article key={l.id} className={styles.itemCard} aria-describedby={stockRefusal?.itemId === l.itemId ? `stock-${l.id}` : undefined}>
            <div className={styles.itemCopy}>
              <p className={styles.itemName}>{l.name}</p>
              {stockRefusal?.itemId === l.itemId ? <p id={`stock-${l.id}`} className={styles.errorMessage}>{stockRefusal.message}</p> : null}
              {l.vendorName ? <p className={styles.itemMeta}>{l.vendorName}</p> : null}
              {(l.selectedOptionNames?.length ?? 0) > 0 ? <p className={styles.itemMeta}>{l.selectedOptionNames?.join(' · ')}</p> : null}
              <p className={styles.itemPrice}>{money(l.customerPrice)}</p>
            </div>
            <div className={styles.quantity} aria-label={`${l.name} quantity`}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void mutateCart(() => l.quantity <= 1 ? removeCartLine(l.id) : updateCartLine(l.id, l.quantity - 1))}
                aria-label={`Remove one ${l.name}`}
                className={styles.quantityButton}
              >−</button>
              <span className={styles.quantityCount} aria-live="polite">{l.quantity}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void mutateCart(() => updateCartLine(l.id, l.quantity + 1))}
                aria-label={`Add another ${l.name}`}
                className={styles.quantityButton}
              >+</button>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void mutateCart(() => removeCartLine(l.id))}
              aria-label={`Remove ${l.name} from cart`}
              className={styles.removeButton}
            ><Trash2 size={18} /></button>
          </article>
          ))}
          <div className={styles.panelStack}>
            {mixedStores ? <button type="button" disabled={busy || !group.id} className={`${styles.button} ${styles.buttonPrimary}`} onClick={() => setSelectedStore(group.id)}>Check out {group.name}</button> : null}
            {mixedStores && selectedStore === group.id ? <p role="status" className={styles.stateCopy}>To order from {group.name}, remove the other stores below first. Removed items will need to be added again later.</p> : null}
            <button type="button" disabled={busy} className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => void mutateCart(async () => {
              for (const item of group.items) await removeCartLine(item.id);
            })}>Remove {group.name} items</button>
            {group.id ? <Link className={styles.emptyLink} href={`/order/vendor/${encodeURIComponent(group.id)}`}>Visit {group.name}</Link> : null}
          </div>
        </section>)}
      </section>

      <aside ref={checkoutRail} tabIndex={-1} className={styles.rail} aria-label="Checkout">
        {cart.promoCode?.code ? (
          <section className={styles.panel} aria-labelledby="promo-title">
            <h2 id="promo-title" className={styles.panelTitle}>Promo code</h2>
            <p className={styles.stateCopy}>{cart.promoCode.code}</p>
            <button type="button" disabled={busy} onClick={() => void mutateCart(() => removeCartPromo())} className={`${styles.button} ${styles.buttonSecondary}`}>
              Remove promo code
            </button>
          </section>
        ) : null}
        {cartSafety !== 'safe' && !mixedStores ? (
          <div ref={safetyNotice} tabIndex={-1} className={`${styles.safety} ${cartSafety === 'blocked' ? styles.safetyBlocked : styles.safetyNotice}`} role={cartSafety === 'blocked' ? 'alert' : 'status'}>
            <div className={styles.panelStack}>
              <p>{cartSafetyMessage}</p>
              {cartSafety === 'blocked' && discount > 0 ? (
                <button type="button" disabled={busy} onClick={() => void mutateCart(() => clearCart())} className={`${styles.button} ${styles.buttonSecondary}`}>
                  Clear saved cart and promotion
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

        {!mixedStores ? <>
        <section className={styles.panel} aria-labelledby="delivery-address-title">
          <div className={styles.panelHeading}>
            <MapPin size={18} color="var(--swift-red)" aria-hidden="true" />
            <h2 id="delivery-address-title" className={styles.panelTitle}>Deliver to</h2>
          </div>
          {addressError ? (
            <div className={styles.panelStack} role="alert">
              <p className={styles.errorMessage}>{addressError}</p>
              <button type="button" className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => void refresh().catch((refreshError) => setError(cartErrorMessage(refreshError)))}>Try addresses again</button>
            </div>
          ) : addresses.length > 0 ? (
            <div className={styles.field}>
              <label htmlFor="cart-delivery-address" className={styles.label}>Saved delivery address</label>
              <select id="cart-delivery-address" value={addrId ?? ''} disabled={busy || (cartSafety !== 'safe' && !knownOutOfRange)} onChange={(e) => void changeAddress(e.target.value)} className={styles.input}>
                {addresses.map((a) => <option key={a.id} value={a.id}>{a.label} — {a.addressLine1}, {a.city}</option>)}
              </select>
            </div>
          ) : addingAddr ? (
            <div className={styles.formStack}>
              <div className={styles.field}><label htmlFor="address-label" className={styles.label}>Address label</label><input ref={addressLabelInput} id="address-label" value={newAddr.label} onChange={(e) => setNewAddr({ ...newAddr, label: e.target.value })} className={styles.input} /></div>
              <div className={styles.field}>
                <label htmlFor="address-street" className={styles.label}>Search the delivery destination</label>
                <input
                  id="address-street"
                  autoComplete="street-address"
                  value={newAddr.addressLine1}
                  aria-describedby="address-map-help"
                  onChange={(e) => {
                    setNewAddr({ ...newAddr, addressLine1: e.target.value });
                    setSelectedPlace(null);
                    setAddressMatches([]);
                  }}
                  className={styles.input}
                />
                <p id="address-map-help" className={styles.stateCopy}>Choose a Swift map result below. The selected pin—not this device’s current location—sets the delivery fee and rider destination.</p>
              </div>
              <button type="button" onClick={() => void searchAddress()} disabled={addressLookupBusy || newAddr.addressLine1.trim().length < 3} className={`${styles.button} ${styles.buttonSecondary}`}>
                {addressLookupBusy ? 'Searching map…' : 'Find this destination on the map'}
              </button>
              {addressMatches.length > 0 ? (
                <div className={styles.panelStack} role="group" aria-label="Mapped address matches">
                  {addressMatches.map((place) => (
                    <button key={place.placeId} type="button" disabled={addressLookupBusy} onClick={() => void chooseAddressMatch(place)} className={`${styles.button} ${styles.buttonSecondary}`}>
                      {place.primary}{place.secondary ? ` — ${place.secondary}` : ''}
                    </button>
                  ))}
                </div>
              ) : null}
              {selectedPlace ? <p className={styles.stateCopy} role="status">Mapped destination confirmed: {selectedPlace.label}</p> : null}
              <div className={styles.field}><label htmlFor="address-city" className={styles.label}>City or town</label><input id="address-city" autoComplete="address-level2" value={newAddr.city} onChange={(e) => setNewAddr({ ...newAddr, city: e.target.value })} className={styles.input} /></div>
              <div className={styles.field}><label htmlFor="address-region" className={styles.label}>Region</label><input id="address-region" autoComplete="address-level1" value={newAddr.region} onChange={(e) => setNewAddr({ ...newAddr, region: e.target.value })} className={styles.input} /></div>
              <button type="button" onClick={() => void saveAddress()} disabled={busy || !selectedPlace || !newAddr.label.trim() || !newAddr.city.trim() || !newAddr.region.trim()} className={`${styles.button} ${styles.buttonPrimary}`}>{busy ? 'Saving…' : 'Save mapped delivery address'}</button>
            </div>
          ) : (
            <button type="button" onClick={() => { setAddingAddr(true); window.requestAnimationFrame(() => addressLabelInput.current?.focus()); }} className={`${styles.button} ${styles.buttonSecondary}`}>Add a delivery address</button>
          )}
        </section>

        <section className={styles.panel} aria-labelledby="tip-title">
          <h2 id="tip-title" className={styles.panelTitle}>Tip your rider</h2>
          <div className={styles.tipGrid}>
            {TIPS.map((t) => (
              <button key={t} type="button" aria-pressed={tip === t} disabled={busy || cartSafety !== 'safe'} onClick={() => { if (checkoutBusy.current || cartMutationLockedByCheckout()) return; resetCheckoutReplay(); setTip(t); }} className={`${styles.tipButton} ${tip === t ? styles.tipSelected : ''}`}>{t === 0 ? 'No tip' : money(t)}</button>
            ))}
          </div>
        </section>

        <section className={styles.panel} aria-labelledby="payment-title">
          <h2 id="payment-title" className={styles.panelTitle}>Payment</h2>
          {paymentCapabilities.mmg.available ? (
            <div role="radiogroup" aria-labelledby="payment-title" className={styles.payOptions}>
              {cartPaymentOptions(paymentCapabilities, { appointmentOnly: false, pickup: false }).map((option) => (
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
              <p className={styles.cashTitle}>Cash at the door</p>
              <p className={styles.cashCopy}>Pay the rider directly when this delivery arrives. Swift never holds your order money.</p>
            </div>
          )}
        </section>

        {cartSafety === 'safe' ? <section className={styles.panel} aria-label="Order total">
          <div className={styles.breakdown}>
            <div className={styles.moneyLine}><span className={styles.moneyLabel}>Items</span><strong className={styles.moneyValue}>{money(serverSubtotal)}</strong></div>
            <div className={styles.moneyLine}><span className={styles.moneyLabel}>Delivery fee</span><strong className={styles.moneyValue}>{hasDestinationQuote ? money(deliveryFee) : 'Choose an address for a quote'}</strong></div>
            {discount > 0 ? <div className={styles.moneyLine}><span className={styles.moneyLabel}>Discount</span><strong className={styles.moneyValue}>−{money(discount)}</strong></div> : null}
            <div className={styles.moneyLine}><span className={styles.moneyLabel}>Rider tip</span><strong className={styles.moneyValue}>{money(tip)}</strong></div>
            <div className={styles.totalLine}><span>Total</span><strong>{moneyUnreadable ? MONEY_UNKNOWN : hasDestinationQuote ? money(total) : 'Quote needed'}</strong></div>
          </div>
          {/* [W-13] A total Swift cannot compute is not shown as a number and
              cannot be ordered against. The old line added a part it could not
              read as if it were zero, or concatenated it as a string. */}
          {moneyUnreadable ? (
            <p role="alert" className={styles.noRidersCopy}>
              Could not confirm your total. Refresh your cart before ordering, or contact support if this continues.
            </p>
          ) : null}
          {noRiders ? (
            <div className={styles.noRiders}>
              <p className={styles.noRidersCopy}>No delivery riders are online right now.</p>
              <button type="button" onClick={() => void placeOrder()} disabled={busy || moneyUnreadable} className={`${styles.button} ${styles.buttonPrimary}`}>{payByMmg ? 'Try delivery again' : 'Try cash delivery again'}</button>
            </div>
          ) : (
            <button type="button" onClick={() => void placeOrder()} disabled={busy || !addrId || !meetsMinimum || moneyUnreadable} className={`${styles.button} ${styles.buttonPrimary} ${styles.checkoutButton}`}>
              {busy ? 'Placing…' : !addrId ? 'Add a delivery address to order' : !meetsMinimum ? `Add ${money(minimumShortfall)} to reach the minimum` : hasDestinationQuote ? (payByMmg ? `Place order · ${money(total)} · pay by MMG` : `Place cash order · ${money(total)}`) : 'Get delivery quote'}
            </button>
          )}
        </section> : null}
        </> : null}
      </aside>
    </div>
  );
}
