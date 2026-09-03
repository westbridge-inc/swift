'use client';

import { useEffect, useRef, useState } from 'react';
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
  setCartAddress,
  updateCartLine,
  type Cart,
  type Place,
} from '@/lib/customer';
import { MONEY_UNKNOWN, parseAmount, sumAmounts } from '@/lib/money';
import { ApiRequestError } from '@/lib/auth';
import styles from './cart.module.css';

const TIPS = [0, 200, 500, 1000];

export default function CartPage() {
  const router = useRouter();
  const [cart, setCart] = useState<Cart | null>(null);
  const [addresses, setAddresses] = useState<any[]>([]);
  const [addrId, setAddrId] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [tip, setTip] = useState(0); // SWIFT-071: no pre-selected tip — the rider tip is opt-in
  const [cartSafety, setCartSafety] = useState<'checking' | 'safe' | 'blocked'>('checking');
  const [cartSafetyMessage, setCartSafetyMessage] = useState('Swift is checking this saved cart against the live store menu.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      const message = cartResult.reason instanceof Error ? cartResult.reason.message : 'Could not load the live cart.';
      setCartSafety('blocked');
      setCartSafetyMessage('Swift could not refresh the live cart. Checkout stays locked until the server responds; use Check cart again below.');
      setError(message);
      throw cartResult.reason;
    }
    const c = cartResult.value;
    const a = addressResult.status === 'fulfilled' ? addressResult.value : [];
    setCart(c); setAddresses(a); setError(null);
    setAddressError(addressResult.status === 'rejected'
      ? addressResult.reason instanceof Error ? addressResult.reason.message : 'Could not load your delivery addresses.'
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
    if (!c.vendor?.id || !c.vendor.slug) {
      return block('Swift cannot identify one live store quote for this saved cart. Remove its items and start again from a store page.');
    }
    if (c.items.some((line) => line.isAvailable === false)) {
      return block('At least one saved item is no longer available. Remove unavailable items before ordering.');
    }
    const fulfillmentModes = new Set(c.items.map((line) => line.fulfillment));
    if (fulfillmentModes.size !== 1 || !fulfillmentModes.has('DELIVERY')) {
      return block(fulfillmentModes.has('PICKUP')
        ? 'Pickup does not have a truthful pre-order quote on this web screen yet. Remove those lines and order delivery from the live store page.'
        : fulfillmentModes.has('APPOINTMENT')
          ? 'Appointment checkout is not available on the web yet. Remove those lines to continue with a delivery order.'
          : 'This cart mixes or omits fulfilment modes, so Swift will not show or submit one aggregate total.');
    }
    if (Number(c.discount ?? 0) > 0) {
      return block('This saved cart has a delivery discount, but the server does not allow discounted cash delivery. Swift cannot remove only the promotion on the web yet; clear this cart to start again without it.');
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
        return block('The public store no longer matches this saved cart. Remove its items and start again from a live store page.');
      }
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
  useEffect(() => { refresh().catch((e) => setError(e.message)); }, []);

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
    } catch (e: any) { setError(e.message); }
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
      setError(lookupError instanceof Error ? lookupError.message : 'Swift could not search the destination map.');
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
      setError(lookupError instanceof Error ? lookupError.message : 'Swift could not confirm that mapped destination.');
    } finally {
      setAddressLookupBusy(false);
    }
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
        setError(`Swift refreshed this saved cart to ${refreshedTotal}. Review the live lines and server quote, then place the order again.`);
        return;
      }
      const body = {
        paymentMethod: 'CASH' as const,
        tipAmount: tip,
        ...(liveCart.promoCode?.code ? { promoCode: liveCart.promoCode.code } : {}),
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
          setError(`Swift refreshed this order to ${refreshedTotal}. Review the new server total, then place the order again.`);
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
      if (message.includes('No delivery riders') || message.includes('NO_RIDERS')) setNoRiders(true);
      else setError(message);
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
      setError(addressError.message);
    } finally {
      checkoutBusy.current = false;
      setBusy(false);
    }
  }

  if (!cart && error) return (
    <section className={styles.stateCard} role="alert">
      <h1 className={styles.stateTitle}>Swift could not load your cart</h1>
      <p className={styles.errorCopy}>{error}</p>
      <button type="button" onClick={() => void refresh().catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : 'Could not load your cart.'))} className={`${styles.button} ${styles.buttonPrimary} ${styles.retryButton}`}>Try again</button>
    </section>
  );
  if (!cart) return <div className={styles.loading} aria-label="Loading your cart" />;
  if (!cart.items?.length) return (
    <section className={styles.emptyState}>
      <h1 className={styles.stateTitle}>Your cart is empty</h1>
      <Link href="/order" className={styles.emptyLink}>Browse Swift</Link>
    </section>
  );

  return (
    <main className={styles.page}>
      <section className={styles.itemsColumn} aria-labelledby="cart-title">
        <h1 id="cart-title" className={styles.title}>Your cart</h1>
        {cart.items.map((l) => (
          <article key={l.id} className={styles.itemCard}>
            <div className={styles.itemCopy}>
              <p className={styles.itemName}>{l.name}</p>
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
      </section>

      <aside ref={checkoutRail} tabIndex={-1} className={styles.rail} aria-label="Checkout">
        {cartSafety !== 'safe' ? (
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

        <section className={styles.panel} aria-labelledby="delivery-address-title">
          <div className={styles.panelHeading}>
            <MapPin size={18} color="var(--swift-red)" aria-hidden="true" />
            <h2 id="delivery-address-title" className={styles.panelTitle}>Deliver to</h2>
          </div>
          {addressError ? (
            <div className={styles.panelStack} role="alert">
              <p className={styles.errorMessage}>{addressError}</p>
              <button type="button" className={`${styles.button} ${styles.buttonSecondary}`} onClick={() => void refresh().catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : 'Could not reload your cart.'))}>Try addresses again</button>
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
          <div className={styles.cashPanel}>
            <p className={styles.cashTitle}>Cash at the door</p>
            <p className={styles.cashCopy}>Pay the rider directly when this delivery arrives. Swift never holds your order money.</p>
          </div>
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
              Swift cannot read this order&apos;s figures from the server. Checkout stays locked until the total is
              certain — refresh, and contact support if it persists.
            </p>
          ) : null}
          {noRiders ? (
            <div className={styles.noRiders}>
              <p className={styles.noRidersCopy}>No delivery riders are online right now.</p>
              <button type="button" onClick={() => void placeOrder()} disabled={busy || moneyUnreadable} className={`${styles.button} ${styles.buttonPrimary}`}>Try cash delivery again</button>
            </div>
          ) : (
            <button type="button" onClick={() => void placeOrder()} disabled={busy || !addrId || !meetsMinimum || moneyUnreadable} className={`${styles.button} ${styles.buttonPrimary} ${styles.checkoutButton}`}>
              {busy ? 'Placing…' : !addrId ? 'Add a delivery address to order' : !meetsMinimum ? `Add ${money(minimumShortfall)} to reach the minimum` : hasDestinationQuote ? `Place cash order · ${money(total)}` : 'Get delivery quote'}
            </button>
          )}
        </section> : null}
      </aside>
    </main>
  );
}
