'use client';

import { formatAmount, parseAmount } from '@/lib/money';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { QueryClientContext } from '@tanstack/react-query';
import {
  Banknote,
  Clock3,
  Minus,
  Plus,
  X,
} from 'lucide-react';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiRequestError, sessionProbe } from '@/lib/auth';
import { clearStorefrontContinuation, queueStorefrontContinuation, takeStorefrontContinuation } from '@/lib/storefront-continuation';
import {
  addToCart,
  checkoutAttemptSignature,
  cartQuoteFingerprint,
  checkout,
  clearCart,
  clearCheckoutAttempt,
  getAddresses,
  getCart,
  getPublicStorefront,
  getPublicVendor,
  persistCheckoutAttempt,
  readCheckoutAttempt,
  removeCartLine,
  setCartAddress,
  updateCartLine,
  type Cart,
  type CheckoutAttempt,
  type MenuItem,
  type OptionGroup,
  type VendorDetail,
} from '@/lib/customer';
import type { StorefrontDetail } from '@/lib/api';
import { storefrontVerticalVariables } from '@/lib/design-tokens';
import {
  OptionSelectionError,
  basePrice,
  fromPrice,
  needsChoices,
  requiredCount,
  selectionPrice,
  validateSelectedOptions,
} from '@/lib/menu-options';
import { useCustomerSession } from '@/components/customer-session';
import { Photo } from '@/components/order-ui';
import { Sheet } from '@/components/sheet';
import { StoreActions } from './store-actions';
import styles from './storefront.module.css';

type Address = {
  id: string;
  label: string;
  addressLine1: string;
  city: string;
  isDefault?: boolean;
};

type DisplayItem = MenuItem & {
  description?: string;
  unit?: string | null;
  isPopular?: boolean;
};

type DisplayVendor = VendorDetail & {
  addressLine1?: string;
  city?: string;
  etaMin?: number | null;
  minOrderAmount?: number;
  acceptingOrders: boolean;
};

const CATALOG_REFRESH_MS = 30_000;

// `value || 0` used to turn NaN (a missing/unparsable server figure) into
// "GY$0" — an INVENTED zero, indistinguishable from a real one and the worst
// lie a price can tell. A non-finite figure now renders an em-dash; a genuine
// 0 still renders "GY$0". Same guarantee as `money()` on the vendor side.
// [W-13] One parser, one em-dash. `null` now reaches here from itemPrice and
// optionPrice — a price the server never sent, which must never render as free.
// [WEB-REDESIGN] Customer prices read like the rest of the app (and the phone
// app): `$2,500`, in Guyana dollars as the footer states.
const gyMoney = (value: unknown) => formatAmount(value, '$');

function publicCatalog(store: StorefrontDetail): DisplayVendor {
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    vendorType: store.vendorType,
    logoUrl: store.logoUrl,
    coverImageUrl: store.coverImageUrl,
    cuisineTypes: store.cuisineTypes,
    displayRating: store.displayRating,
    ratingBucket: store.ratingBucket,
    ratingCount: store.ratingCount,
    topRated: store.topRated,
    estimatedPrepTime: store.estimatedPrepTime,
    isCurrentlyOpen: store.isCurrentlyOpen,
    acceptingOrders: store.acceptingOrders,
    description: store.description ?? undefined,
    addressLine1: store.addressLine1,
    city: store.city,
    minOrderAmount: store.minOrderAmount,
    categories: store.categories.map((category) => ({
      id: category.id,
      name: category.name,
      items: category.items.map((item) => ({
        ...item,
        description: item.description ?? undefined,
        customerPrice: item.basePrice,
        isAvailable: true,
      })),
    })),
  };
}

// [W-13] A price the server did not send used to become ZERO here, so a broken
// item rendered as free and could still be added to a cart and ordered. An
// unparseable price is now null: the item shows an em-dash and cannot be added.
// [W6] Every figure on this page comes from lib/menu-options, which prices a
// selection with the API's own resolver and judges it with the API's own
// validator (the same one cart add, cart update and checkout run).
const itemPrice = (item: DisplayItem): number | null => basePrice(item);
const optionPrice = (item: DisplayItem, selected: Record<string, string[]>): number | null => selectionPrice(item, selected);

function selectedDefaults(groups: OptionGroup[]): Record<string, string[]> {
  return Object.fromEntries(
    groups.map((group) => [
      group.id,
      group.options
        .filter((option) => option.isAvailable !== false && option.isDefault)
        .slice(0, group.maxSelect)
        .map((option) => option.id),
    ]),
  );
}

function optionGuidance(group: OptionGroup): string {
  const minimum = group.isRequired ? Math.max(1, group.minSelect) : group.minSelect;
  if (group.maxSelect <= 1) return minimum > 0 ? 'Choose 1' : 'Optional';
  if (minimum === group.maxSelect) return `Choose ${group.maxSelect}`;
  if (minimum > 0) return `Choose ${minimum}–${group.maxSelect}`;
  return `Optional · up to ${group.maxSelect}`;
}

/** What the person is told when the validator refuses their choices. */
function choiceProblem(item: DisplayItem, error: unknown): { message: string; groupId: string | null } {
  if (!(error instanceof OptionSelectionError)) return { message: 'These choices have changed. Close this panel and check the menu again.', groupId: null };
  const group = (item.optionGroups ?? []).find((candidate) => candidate.name === error.groupName) ?? null;
  if (error.reason === 'OPTION_REQUIRED' && group) {
    if (!group.options.some((option) => option.isAvailable !== false)) return { message: `“${group.name}” is sold out right now.`, groupId: group.id };
    const needed = Math.max(requiredCount(group), group.minSelect, 1);
    return { message: `Choose ${needed === 1 ? 'an option' : `${needed} options`} for ${group.name}.`, groupId: group.id };
  }
  if (error.reason === 'OPTION_UNAVAILABLE' || error.reason === 'OPTION_LIMIT') return { message: `${error.message}.`, groupId: group?.id ?? null };
  return { message: 'These choices have changed. Close this panel and check the menu again.', groupId: group?.id ?? null };
}

/** The menu section the person is reading: the last whose heading has passed the chips. */
function useActiveSection(ids: string[]): [string | null, (_id: string) => void] {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join('|');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) visible.set(entry.target.id.replace(/^section-/, ''), entry.isIntersecting);
      const first = key.split('|').find((id) => visible.get(id));
      if (first) setActive(first);
    }, { rootMargin: '-120px 0px -55% 0px' });
    for (const id of key.split('|')) {
      const node = document.getElementById(`section-${id}`);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [key]);
  return [active, setActive];
}

export function StorefrontExperience({ store, returnPath, fromQr = false, initialItemId }: { store: StorefrontDetail; returnPath: string; fromQr?: boolean; initialItemId?: string }) {
  const router = useRouter();
  // [W6] The store page lives inside the customer app's frame (rail, dock,
  // session). Its session can renew an expired access cookie before sending a
  // guest to sign in, and its cart count is refreshed after every change made
  // here. Rendered on its own (tests), both are simply absent.
  const shellSession = useCustomerSession();
  const shellQueries = useContext(QueryClientContext);
  const [dismissedDiningStore, setDismissedDiningStore] = useState<string | null>(null);
  const diningNoticeDismissed = dismissedDiningStore === store.id;
  const diningNoticeStorageKey = `swift:dining-notice:${store.id}`;
  useEffect(() => {
    if (!fromQr) return;
    try {
      setDismissedDiningStore(sessionStorage.getItem(diningNoticeStorageKey) === 'dismissed' ? store.id : null);
    } catch {
      // Storage can be blocked. The notice remains dismissible in memory.
    }
  }, [fromQr, store.id, diningNoticeStorageKey]);
  const menu = useRef<HTMLDivElement | null>(null);
  const [catalog, setCatalog] = useState<DisplayVendor>(() => publicCatalog(store));
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [catalogCheckedAt, setCatalogCheckedAt] = useState<Date | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [cart, setCart] = useState<Cart | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressId, setAddressId] = useState('');
  const [loadingCart, setLoadingCart] = useState(false);
  const [cartHydrated, setCartHydrated] = useState(false);
  const [cartLoadVersion, setCartLoadVersion] = useState(0);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [quotingAddress, setQuotingAddress] = useState(false);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; added: boolean } | null>(null);
  const [floatingError, setFloatingError] = useState<string | null>(null);
  const [modalItem, setModalItem] = useState<DisplayItem | null>(null);
  const [itemQuantity, setItemQuantity] = useState(1);
  const deepLinkOpened = useRef(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
  const mutationBusy = useRef(false);
  const addressBusy = useRef(false);
  const placingOrderNow = useRef(false);
  const restoringSession = useRef(false);
  const checkoutKey = useRef<CheckoutAttempt | null>(null);
  const modalReturnFocus = useRef<HTMLElement | null>(null);
  const clearConfirmButton = useRef<HTMLButtonElement | null>(null);
  const clearReturnFocus = useRef<HTMLButtonElement | null>(null);
  const railHeading = useRef<HTMLHeadingElement | null>(null);

  const closeOptions = useCallback(() => {
    clearStorefrontContinuation();
    setModalItem(null);
    setModalError(null);
    window.requestAnimationFrame(() => modalReturnFocus.current?.focus());
  }, []);

  /** The rail's and the dock's cart count are the shell's read of the same server cart. */
  const refreshShellCart = useCallback(() => {
    void shellQueries?.invalidateQueries({ queryKey: ['customer', 'cart'] });
  }, [shellQueries]);

  const refreshCart = useCallback(async () => {
    const next = await getCart();
    setCart(next);
    return next;
  }, []);

  useEffect(() => {
    let alive = true;
    let catalogRefreshInFlight = false;
    setCatalogState('loading');

    const refreshCatalog = async () => {
      if (catalogRefreshInFlight) return;
      catalogRefreshInFlight = true;
      try {
        const [liveStore, vendor] = await Promise.all([
          getPublicStorefront(store.slug),
          getPublicVendor(store.id),
        ]);
        if (!alive) return;
        const liveCatalog = publicCatalog(liveStore);
        setCatalog({
          ...liveCatalog,
          ...(vendor as DisplayVendor),
          addressLine1: liveCatalog.addressLine1,
          minOrderAmount: liveCatalog.minOrderAmount,
        });
        setCatalogState('ready');
        setCatalogCheckedAt(new Date());
      } catch {
        if (alive) setCatalogState('unavailable');
      } finally {
        catalogRefreshInFlight = false;
      }
    };
    void refreshCatalog();
    const catalogTimer = window.setInterval(() => void refreshCatalog(), CATALOG_REFRESH_MS);

    // [W-01] Signed-in is the server's answer about an HttpOnly cookie, not a
    // token this script can read. Start signed-OUT, ask, and hydrate the cart
    // only once the server has attested — so a signed-out visitor never fires
    // the two authenticated loads, exactly as the token check used to prevent.
    setSignedIn(false);
    void sessionProbe().then((session) => {
      if (!alive || !session.ok) return;
      setSignedIn(true);
      setLoadingCart(true);
      setCartHydrated(false);
      return Promise.all([
        getCart({ redirectOnExpired: false }),
        getAddresses({ redirectOnExpired: false }),
      ])
        .then(([nextCart, nextAddresses]) => {
          if (!alive) return;
          const typedAddresses = nextAddresses as Address[];
          setCart(nextCart);
          setAddresses(typedAddresses);
          setCartHydrated(true);
          const selected =
            typedAddresses.find((address) => address.id === nextCart.deliveryAddress?.id) ??
            typedAddresses.find((address) => address.isDefault) ??
            typedAddresses[0];
          setAddressId(selected?.id ?? '');
        })
        .catch((loadError) => {
          if (!alive) return;
          // [W-01] The session can die between the probe and the load. With a
          // cookie there is nothing local to re-inspect, so the SERVER's 401 is
          // the signal — sign out quietly instead of showing a load error.
          if (loadError instanceof ApiRequestError && loadError.status === 401) {
            setSignedIn(false);
            setCart(null);
            setAddresses([]);
            setCartHydrated(false);
            return;
          }
          setError(loadError instanceof Error ? loadError.message : 'Could not load your order.');
        })
        .finally(() => {
          if (alive) setLoadingCart(false);
        });
    });

    return () => {
      alive = false;
      window.clearInterval(catalogTimer);
    };
  }, [cartLoadVersion, store.id, store.slug]);

  const storeAcceptsOrders = catalog.isCurrentlyOpen && catalog.acceptingOrders;
  const catalogVerified = catalogState === 'ready';
  const orderable = storeAcceptsOrders && catalogVerified;
  const cartItems = cart?.items ?? [];
  const cartHydrationPending = signedIn && !cartHydrated;
  const itemCount = cartItems.reduce((sum, line) => sum + line.quantity, 0);
  const fallbackSubtotal = cartItems.reduce(
    (sum, line) => sum + Number(line.customerPrice ?? 0) * line.quantity,
    0,
  );
  const subtotal = Number(cart?.subtotalCustomer ?? cart?.subtotal ?? fallbackSubtotal);
  const deliveryFee = typeof cart?.deliveryFee === 'number' ? cart.deliveryFee : null;
  const discount = Number(cart?.discount ?? 0);
  const riderTip = Number(cart?.tipAmount ?? 0);
  const total = Number(cart?.totalAmount ?? subtotal + (deliveryFee ?? 0) - discount + riderTip);
  const meetsMinimum = cart?.meetsMinimum ?? true;
  const minimumShortfall = Math.max(0, Number(cart?.minimumOrderAmount ?? 0) - subtotal);
  const selectedAddress = addresses.find((address) => address.id === addressId);
  const storeLabel = [catalog.addressLine1, catalog.city].filter(Boolean).join(', ');
  const categoryItems = catalog.categories.flatMap((category) => category.items as DisplayItem[]);
  const itemsById = new Map(categoryItems.map((item) => [item.id, item]));
  const catalogItemIds = new Set(categoryItems.map((item) => item.id));
  const cartVendorMismatch = cartItems.length > 0 && cart?.vendor?.id !== catalog.id;
  const lineNeedsReview = (line: Cart['items'][number]) => !catalogItemIds.has(line.itemId) || line.isAvailable === false;
  const cartHasUnverifiedLines = cartItems.some(lineNeedsReview);
  const cartNeedsReview = cartVendorMismatch || cartHasUnverifiedLines;
  const cartFulfillmentModes = new Set(
    cartItems.map((line) => itemsById.get(line.itemId)?.fulfillment).filter((value): value is string => Boolean(value)),
  );
  const cartHasAppointment = cartFulfillmentModes.has('APPOINTMENT');
  const cartHasPickup = cartFulfillmentModes.has('PICKUP');
  const cartHasMixedFulfillment = cartFulfillmentModes.size > 1;
  const cartHasUnknownFulfillment = cartItems.some((line) => {
    const mode = itemsById.get(line.itemId)?.fulfillment;
    return mode !== 'DELIVERY' && mode !== 'PICKUP' && mode !== 'APPOINTMENT';
  });
  const fulfillmentNeedsReview = cartHasPickup || cartHasMixedFulfillment || cartHasUnknownFulfillment;
  const deliveryDistance = Number(cart?.deliveryDistanceKm ?? cart?.vendor?.distanceKm);
  const deliveryRadius = Number(cart?.vendor?.deliveryRadius);
  const cartOutOfRange = cartItems.length > 0
    && cartFulfillmentModes.size === 1
    && cartFulfillmentModes.has('DELIVERY')
    && Number.isFinite(deliveryDistance)
    && Number.isFinite(deliveryRadius)
    && deliveryDistance > deliveryRadius;
  const cashPromoBlocked = cartItems.length > 0
    && discount > 0
    && cartFulfillmentModes.size === 1
    && cartFulfillmentModes.has('DELIVERY');
  const directCheckoutBlocked = !catalogVerified || cartNeedsReview || cartHasAppointment || fulfillmentNeedsReview || cartOutOfRange || cashPromoBlocked;
  const menuFulfillmentModes = new Set(categoryItems.map((item) => item.fulfillment).filter(Boolean));
  const storePickupOnly = menuFulfillmentModes.size === 1 && menuFulfillmentModes.has('PICKUP');
  const storeAppointmentOnly = menuFulfillmentModes.size === 1 && menuFulfillmentModes.has('APPOINTMENT');
  const needsDeliveryAddress = cartItems.length > 0
    ? cartFulfillmentModes.has('DELIVERY') && !cartHasMixedFulfillment
    : !storePickupOnly && !storeAppointmentOnly;
  const pickupContext = cartItems.length > 0 ? cartHasPickup && !cartHasMixedFulfillment : storePickupOnly;
  const appointmentContext = cartItems.length > 0 ? cartHasAppointment && !cartHasMixedFulfillment : storeAppointmentOnly;
  const hasDestinationQuote = cartItems.length === 0
    || !needsDeliveryAddress
    || Boolean(addressId && cart?.deliveryAddress?.id === addressId);
  const orderAmountLabel = hasDestinationQuote ? gyMoney(total) : 'Quote needed';
  const sections = catalog.categories.filter((category) => category.items.length > 0);
  const [activeSection, setActiveSection] = useActiveSection(sections.map((category) => category.id));

  const quantities = new Map<string, number>();
  for (const line of cartItems) quantities.set(line.itemId, (quantities.get(line.itemId) ?? 0) + line.quantity);

  const showNotice = (message: string, added = false) => {
    setNotice({ message, added });
    window.setTimeout(() => setNotice(null), 2600);
  };

  const showFloatingError = (message: string) => {
    setFloatingError(message);
    window.setTimeout(() => setFloatingError(null), 4200);
  };

  const resetCheckoutAttempt = () => {
    checkoutKey.current = null;
    clearCheckoutAttempt();
  };

  const cartMutationLockedByCheckout = () => {
    const pending = checkoutKey.current ?? readCheckoutAttempt();
    if (!pending) return false;
    checkoutKey.current = pending;
    const message = 'A checkout attempt still has an unresolved server outcome. Check Orders or retry the same order before changing this cart.';
    setError(message);
    showFloatingError(message);
    return true;
  };

  const closeClearConfirmation = () => {
    setConfirmingClear(false);
    window.requestAnimationFrame(() => clearReturnFocus.current?.focus());
  };

  /**
   * [Q7b] A guest browses freely and signs in to order. Inside the app, an
   * expired access cookie is renewed first (once per page load), so a
   * returning customer is never sent to sign in for nothing; the cart then
   * loads and the item they chose reopens from the sign-in continuation.
   */
  const requireCustomerSession = () => {
    if (signedIn) return true;
    if (restoringSession.current) return false;
    restoringSession.current = true;
    const toSignIn = () => router.push(`/login?next=${encodeURIComponent(returnPath)}`);
    void shellSession.ensureSignedIn().then((restored) => {
      restoringSession.current = false;
      if (restored) setCartLoadVersion((version) => version + 1);
      else toSignIn();
    }, () => {
      restoringSession.current = false;
      toSignIn();
    });
    return false;
  };

  const mutateItem = async (itemId: string, work: () => Promise<unknown>, message?: string, added = false) => {
    if (mutationBusy.current || placingOrderNow.current || cartHydrationPending || cartMutationLockedByCheckout()) return;
    mutationBusy.current = true;
    resetCheckoutAttempt();
    setBusyItem(itemId);
    setError(null);
    try {
      await work();
      await refreshCart();
      refreshShellCart();
      if (message) showNotice(message, added);
    } catch (mutationError) {
      const message = mutationError instanceof Error ? mutationError.message : 'Could not update your order.';
      setError(message);
      showFloatingError(message);
    } finally {
      mutationBusy.current = false;
      setBusyItem(null);
    }
  };

  const openOptions = (item: DisplayItem, trigger?: HTMLElement) => {
    modalReturnFocus.current = trigger ?? null;
    setSelectedOptions(selectedDefaults(item.optionGroups ?? []));
    setItemQuantity(1);
    setModalError(null);
    setModalItem(item);
  };

  const addItem = (item: DisplayItem, trigger?: HTMLElement) => {
    if (!orderable || !item.isAvailable || cartHydrationPending || cartMutationLockedByCheckout()) return;
    // [W6] One tap adds an item that needs no choice; an item with a required
    // choice opens its options instead.
    if (needsChoices(item)) {
      openOptions(item, trigger);
      return;
    }
    if (!signedIn) {
      queueStorefrontContinuation({ storeSlug: store.slug, itemId: item.id, selectedOptions: {}, returnPath });
    }
    if (!requireCustomerSession()) return;
    const existing = cartItems.find((line) => line.itemId === item.id);
    void mutateItem(
      item.id,
      () =>
        existing
          ? updateCartLine(existing.id, existing.quantity + 1)
          : addToCart({ vendorId: catalog.id, itemId: item.id, quantity: 1 }),
      `${item.name} added to your order.`,
      true,
    );
  };

  // [W6] `?item=` (Home's popular rail, the Market, a shared link) opens that
  // item's sheet once the live menu is verified — it never adds anything.
  useEffect(() => {
    if (!initialItemId || deepLinkOpened.current || catalogState !== 'ready') return;
    deepLinkOpened.current = true;
    const item = catalog.categories.flatMap(category => category.items).find(item => item.id === initialItemId);
    if (item?.isAvailable && item.fulfillment === 'DELIVERY') {
      setSelectedOptions(selectedDefaults(item.optionGroups ?? []));
      setItemQuantity(1);
      setModalError(null);
      setModalItem(item);
    }
  }, [initialItemId, catalogState, catalog]);

  useEffect(() => {
    if (!signedIn || !cartHydrated || catalogState !== 'ready') return;
    const intent = takeStorefrontContinuation(store.slug);
    if (!intent) return;
    const item = catalog.categories.flatMap(category => category.items).find(item => item.id === intent.itemId);
    if (!catalog.isCurrentlyOpen || !catalog.acceptingOrders || !item?.isAvailable
      || item.fulfillment !== 'DELIVERY' || itemPrice(item) === null) {
      setError('This item is not available to order right now. Please check the menu.');
      return;
    }
    // Reopen even items without options: resuming sign-in never silently
    // changes a cart, and the customer sees the current server price.
    const choices = Object.fromEntries((item.optionGroups ?? []).map(group => [group.id,
      (intent.selectedOptions[group.id] ?? []).filter(id => group.options.some(option => option.id === id && option.isAvailable)).slice(0, group.maxSelect),
    ]));
    setSelectedOptions(choices);
    setItemQuantity(1);
    setModalError(null);
    setModalItem(item);
  }, [signedIn, cartHydrated, catalogState, catalog, store.slug]);

  const subtractItem = (item: DisplayItem) => {
    if (!requireCustomerSession()) return;
    const matching = cartItems.filter((line) => line.itemId === item.id);
    const line = matching.at(-1);
    if (!line) return;
    void mutateItem(
      item.id,
      () => (line.quantity <= 1 ? removeCartLine(line.id) : updateCartLine(line.id, line.quantity - 1)),
    );
  };

  const chooseOption = (group: OptionGroup, optionId: string) => {
    setModalError(null);
    setSelectedOptions((current) => {
      const selected = current[group.id] ?? [];
      if (group.maxSelect <= 1) {
        const canClear = !group.isRequired && group.minSelect === 0;
        return {
          ...current,
          [group.id]: canClear && selected.includes(optionId) ? [] : [optionId],
        };
      }
      if (selected.includes(optionId)) {
        return { ...current, [group.id]: selected.filter((id) => id !== optionId) };
      }
      if (selected.length >= group.maxSelect) return current;
      return { ...current, [group.id]: [...selected, optionId] };
    });
  };

  const confirmOptions = () => {
    if (!modalItem) return;
    const liveItem = categoryItems.find((item) => item.id === modalItem.id);
    if (!orderable || !liveItem?.isAvailable || liveItem.fulfillment !== 'DELIVERY' || optionPrice(liveItem, selectedOptions) === null) {
      setModalError('This item is no longer verified as orderable on the live menu. Close this panel and check the menu again.');
      return;
    }
    // [W6] Required choices block the Add: the API's own validator (the one
    // cart add, cart update and checkout run) must accept the selection first.
    let selected: Record<string, string | string[]>;
    try {
      const validated = validateSelectedOptions(liveItem, selectedOptions).selection;
      // The shape the apps send: one id for a pick-one group, a list otherwise.
      selected = Object.fromEntries(Object.entries(validated).map(([groupId, ids]) => {
        const single = (liveItem.optionGroups?.find(group => group.id === groupId)?.maxSelect ?? 1) <= 1;
        return [groupId, single && Array.isArray(ids) ? ids[0]! : ids];
      }));
    } catch (choiceError) {
      const problem = choiceProblem(liveItem, choiceError);
      setModalError(problem.message);
      if (problem.groupId) {
        window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-option-group="${problem.groupId}"] input:not(:disabled)`)?.focus());
      }
      return;
    }
    if (!signedIn) {
      queueStorefrontContinuation({ storeSlug: store.slug, itemId: modalItem.id, selectedOptions, returnPath });
      requireCustomerSession();
      return;
    }
    const item = modalItem;
    const quantity = itemQuantity;
    closeOptions();
    void mutateItem(
      item.id,
      () => addToCart({ vendorId: catalog.id, itemId: item.id, quantity, selectedOptions: selected }),
      `${item.name} added to your order.`,
      true,
    );
  };

  const changeAddress = async (nextAddressId: string) => {
    if (addressBusy.current || mutationBusy.current || placingOrderNow.current || cartMutationLockedByCheckout()) return;
    addressBusy.current = true;
    resetCheckoutAttempt();
    const previousAddressId = addressId;
    setQuotingAddress(true);
    setAddressId(nextAddressId);
    setError(null);
    try {
      await setCartAddress(nextAddressId);
      await refreshCart();
    } catch (addressError) {
      setAddressId(previousAddressId);
      setError(addressError instanceof Error ? addressError.message : 'Could not quote delivery to that address.');
    } finally {
      addressBusy.current = false;
      setQuotingAddress(false);
    }
  };

  const clearSavedCart = async () => {
    if (mutationBusy.current || placingOrderNow.current || cartMutationLockedByCheckout()) return;
    mutationBusy.current = true;
    resetCheckoutAttempt();
    setBusyItem('saved-cart');
    setError(null);
    try {
      await clearCart();
      await refreshCart();
      refreshShellCart();
      setConfirmingClear(false);
      showNotice('Saved cart cleared. Start a fresh order from this store.');
      window.requestAnimationFrame(() => railHeading.current?.focus());
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : 'Could not clear the saved cart.');
    } finally {
      mutationBusy.current = false;
      setBusyItem(null);
    }
  };

  const placeOrder = async () => {
    if (
      placingOrderNow.current ||
      mutationBusy.current ||
      addressBusy.current ||
      !requireCustomerSession() ||
      !cartHydrated ||
      !cart ||
      !cartItems.length ||
      !orderable ||
      directCheckoutBlocked
    ) return;
    if (needsDeliveryAddress && !addressId) {
      setError('Add a delivery address before placing this order.');
      return;
    }
    placingOrderNow.current = true;
    setPlacingOrder(true);
    setError(null);
    try {
      const latestCart = await refreshCart();
      if (!latestCart.items.length) {
        resetCheckoutAttempt();
        router.push('/orders');
        return;
      }
      const quotedCart = needsDeliveryAddress ? await setCartAddress(addressId) : latestCart;
      setCart(quotedCart);
      if (quotedCart.vendor?.id !== catalog.id) {
        setError('The server quote is no longer tied to this store. Checkout stays locked so no mixed-store order is placed.');
        return;
      }
      if (quotedCart.vendor.isCurrentlyOpen === false || quotedCart.vendor.acceptingOrders === false) {
        setError(quotedCart.vendor.isCurrentlyOpen === false
          ? 'This store is closed now. No order was placed; checkout stays locked until it reopens.'
          : 'This store has paused orders. No order was placed; checkout stays locked until it resumes.');
        return;
      }
      if (quotedCart.items.some((line) => !catalogItemIds.has(line.itemId) || line.isAvailable === false || line.fulfillment !== 'DELIVERY')) {
        setError('A saved listing changed or no longer belongs to this live delivery menu. Checkout is locked until the cart is reviewed.');
        return;
      }
      if (Number(quotedCart.discount ?? 0) > 0) {
        setError('The server does not allow this discounted cart to use cash delivery. Clear the saved cart and promotion before starting again.');
        return;
      }
      const quotedDistance = Number(quotedCart.deliveryDistanceKm ?? quotedCart.vendor.distanceKm);
      const quotedRadius = Number(quotedCart.vendor.deliveryRadius);
      if (Number.isFinite(quotedDistance) && Number.isFinite(quotedRadius) && quotedDistance > quotedRadius) {
        setError(`This address is ${quotedDistance.toFixed(1)} km from the store, outside its ${quotedRadius.toFixed(1)} km delivery radius. Choose another address.`);
        return;
      }
      if (quotedCart.meetsMinimum === false) {
        setError('The refreshed server quote is below this store’s minimum. Add more items before ordering.');
        return;
      }
      const body = {
        paymentMethod: 'CASH' as const,
        tipAmount: riderTip,
        ...(quotedCart.promoCode?.code ? { promoCode: quotedCart.promoCode.code } : {}),
      };
      const signature = checkoutAttemptSignature(quotedCart, body);
      const attempt = checkoutKey.current ?? readCheckoutAttempt();
      if (attempt && attempt.signature !== signature) {
        checkoutKey.current = attempt;
        setError('An earlier checkout attempt still has an unresolved server outcome. Check Orders before changing or placing this cart; Swift will not create a second attempt with a new key.');
        return;
      }
      checkoutKey.current = attempt;
      const retryKey = attempt?.key ?? null;
      if (!retryKey && cartQuoteFingerprint(quotedCart) !== cartQuoteFingerprint(cart)) {
        const refreshedTotal = typeof quotedCart.totalAmount === 'number'
          ? gyMoney(quotedCart.totalAmount)
          : 'a new server total';
        setError(`Swift refreshed this order to ${refreshedTotal}. Review the new server total, then place the order again.`);
        return;
      }
      const idempotencyKey = retryKey ?? crypto.randomUUID();
      checkoutKey.current = { signature, key: idempotencyKey };
      persistCheckoutAttempt(checkoutKey.current);
      const result = await checkout(body, idempotencyKey);
      resetCheckoutAttempt();
      refreshShellCart();
      const orderId = result.order?.id ?? result.orders?.[0]?.id;
      router.push(orderId ? `/orders/${orderId}` : '/orders');
    } catch (checkoutError) {
      const message = checkoutError instanceof Error ? checkoutError.message : 'Could not place this order.';
      if (/selfie|profile photo/i.test(message)) {
        resetCheckoutAttempt();
        router.push(`/selfie?next=${encodeURIComponent(returnPath)}`);
        return;
      }
      const definiteRejection = checkoutError instanceof ApiRequestError
        && checkoutError.status >= 400
        && checkoutError.status < 500
        && checkoutError.code !== 'DUPLICATE_REQUEST';
      try {
        const reconciledCart = await refreshCart();
        if (reconciledCart.items.length === 0) {
          resetCheckoutAttempt();
          router.push('/orders');
          return;
        }
        if (definiteRejection) resetCheckoutAttempt();
      } catch {
        // Preserve the key when the cart cannot confirm whether an order was
        // committed. Retrying that same key is the only duplicate-safe action.
      }
      setError(message);
    } finally {
      placingOrderNow.current = false;
      setPlacingOrder(false);
    }
  };

  const minutes = catalog.etaMin ? `About ${catalog.etaMin} min` : `${catalog.estimatedPrepTime} min prep`;
  const rating = catalog.displayRating !== null ? `${catalog.displayRating.toFixed(1)} ${catalog.ratingBucket}`.trim() : 'No ratings yet';
  const storeMeta = [catalog.cuisineTypes?.[0], storeLabel, rating].filter(Boolean).join(' · ');
  const modalUnitPrice = modalItem ? optionPrice(modalItem, selectedOptions) : null;

  return (
    <div className={styles.page} style={storefrontVerticalVariables(catalog.vendorType)}>
      <div className={styles.content}>
        <section className={styles.storeHead} aria-labelledby="store-name">
          {!fromQr ? (
            <Photo
              src={catalog.coverImageUrl}
              alt={`${catalog.name} storefront`}
              vendorType={catalog.vendorType}
              sizes="(min-width: 760px) 900px, 100vw"
              priority
              iconSize={44}
              className={styles.cover}
            />
          ) : null}
          <div className={styles.titleRow}>
            <div className={styles.titleCopy}>
              <h1 id="store-name" className={styles.storeName}>{catalog.name}</h1>
              {storeMeta ? <p className={styles.storeMeta}>{storeMeta}</p> : null}
            </div>
            {shellQueries ? (
              <StoreActions vendorId={catalog.id} slug={catalog.slug} name={catalog.name} onMessage={(message) => showNotice(message)} />
            ) : null}
          </div>
          <ul className={styles.facts} aria-label="Store status">
            <li className={`${styles.fact} ${catalog.isCurrentlyOpen ? styles.factOpen : styles.factClosed}`}>
              {catalog.isCurrentlyOpen ? 'Open' : 'Closed'}
            </li>
            {!catalog.acceptingOrders ? <li className={`${styles.fact} ${styles.factPaused}`}>Orders paused</li> : null}
            <li className={styles.fact}><Clock3 size={14} aria-hidden="true" />{minutes}</li>
            {Number(catalog.minOrderAmount ?? 0) > 0 ? (
              <li className={styles.fact}>Minimum {gyMoney(Number(catalog.minOrderAmount))}</li>
            ) : null}
          </ul>
        </section>

        {fromQr ? (
          // Present in the server render. Hiding keeps its space, so neither
          // hydration nor dismissal moves the menu under a visitor's finger.
          <div className={styles.diningNotice} aria-hidden={diningNoticeDismissed ? true : undefined}>
            <p role="status" aria-live="polite">Dining in? Browse our menu here and place your order with your server.</p>
            <button
              type="button"
              className={styles.diningDismiss}
              aria-label="Dismiss dining-in message"
              onClick={() => {
                setDismissedDiningStore(store.id);
                try {
                  sessionStorage.setItem(diningNoticeStorageKey, 'dismissed');
                } catch {
                  // Browsing and ordering must also work without storage.
                }
                menu.current?.focus({ preventScroll: true });
              }}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {catalog.description ? <p className={styles.description}>{catalog.description}</p> : null}

        {catalogState === 'ready' && catalogCheckedAt ? (
          <p className={styles.menuFreshness}>Live menu checked at {catalogCheckedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</p>
        ) : null}

        {catalogState !== 'ready' ? (
          <p
            className={`${styles.catalogNotice} ${catalogState === 'unavailable' ? styles.catalogUnavailable : ''}`}
            role={catalogState === 'unavailable' ? 'alert' : 'status'}
          >
            {catalogState === 'loading'
              ? 'Checking this live menu’s required choices before ordering…'
              : 'The live menu is available to browse, but Swift could not verify its required choices. Ordering is paused on this page; no incomplete item will be added.'}
          </p>
        ) : null}

        {sections.length > 0 ? (
          <nav className={styles.categoryNav} aria-label="Menu sections">
            {sections.map((category) => (
              <a
                key={category.id}
                href={`#section-${category.id}`}
                className={styles.categoryLink}
                aria-current={activeSection === category.id ? 'true' : undefined}
                onClick={() => setActiveSection(category.id)}
              >
                {category.name}
              </a>
            ))}
          </nav>
        ) : null}

        <div className={styles.layout}>
          <div ref={menu} className={styles.menu} role="region" aria-label="Menu" tabIndex={-1}>
            {catalog.categories.length === 0 || categoryItems.length === 0 ? (
              <p className={styles.emptyMenu}>
                This store has no orderable menu items right now. Check again later.
              </p>
            ) : null}
            {sections.map((category) => (
              <section key={category.id} id={`section-${category.id}`} className={styles.section}>
                <h2 className={styles.sectionTitle}>{category.name}</h2>
                <div className={styles.rows}>
                  {(category.items as DisplayItem[]).map((item) => {
                    const quantity = quantities.get(item.id) ?? 0;
                    const fulfillmentVerified = item.fulfillment === 'DELIVERY' || item.fulfillment === 'PICKUP' || item.fulfillment === 'APPOINTMENT';
                    // [W-13] A price Swift cannot read is not an orderable item. It used
                    // to become GY$0 and stay addable, so a broken row shipped as free.
                    const priced = itemPrice(item) !== null;
                    const available = item.isAvailable && orderable && item.fulfillment === 'DELIVERY' && priced;
                    const choices = needsChoices(item);
                    const optional = !choices && (item.optionGroups?.length ?? 0) > 0;
                    return (
                      <article
                        key={item.id}
                        className={`${styles.menuRow} ${!item.isAvailable ? styles.menuRowUnavailable : ''}`}
                      >
                        {quantity > 0 ? (
                          <span className={styles.qtyBadge}>
                            <span aria-hidden="true">{quantity}</span>
                            <span className="sr-only">{quantity} in your order</span>
                          </span>
                        ) : null}
                        <div className={styles.itemCopy}>
                          <h3 className={styles.itemName}>{item.name}</h3>
                          {item.description ? <p className={styles.itemDescription}>{item.description}</p> : null}
                          <div className={styles.itemMeta}>
                            {item.isPopular ? <span className={styles.popular}>Popular</span> : null}
                            {item.unit ? <span className={styles.unit}>per {item.unit}</span> : null}
                            {!item.isAvailable ? <span className={styles.soldOut}>Sold out</span> : null}
                            {item.isAvailable && !priced ? (
                              <span className={styles.soldOut}>Price unavailable</span>
                            ) : null}
                            {optional && available ? (
                              <button
                                type="button"
                                className={styles.textButton}
                                onClick={(event) => openOptions(item, event.currentTarget)}
                                disabled={cartHydrationPending || busyItem !== null || quotingAddress || placingOrder}
                                aria-label={`Choose options for ${item.name}`}
                              >
                                Customise
                              </button>
                            ) : null}
                          </div>
                          <div className={styles.itemFoot}>
                            <span className={styles.itemPrice}>
                              {choices ? <span className={styles.fromLabel}>From</span> : null}
                              <span>{gyMoney(choices ? fromPrice(item) : itemPrice(item))}</span>
                            </span>
                            {!fulfillmentVerified ? (
                              <span className={styles.unavailableAction}>Ordering unavailable</span>
                            ) : item.fulfillment === 'PICKUP' ? (
                              <span className={styles.unavailableAction}>Pickup checkout unavailable</span>
                            ) : item.fulfillment === 'APPOINTMENT' ? (
                              <span className={styles.unavailableAction}>Appointment checkout unavailable</span>
                            ) : choices ? (
                              <button
                                type="button"
                                className={styles.chooseButton}
                                onClick={(event) => addItem(item, event.currentTarget)}
                                disabled={cartHydrationPending || busyItem !== null || quotingAddress || placingOrder || !available}
                                aria-label={quantity > 0 ? `Customize another ${item.name}; ${quantity} currently in your order` : `Choose options for ${item.name}`}
                              >
                                Choose
                              </button>
                            ) : quantity > 0 ? (
                              <div className={styles.quantity} aria-label={`${item.name} quantity`}>
                                <button
                                  type="button"
                                  className={styles.quantityButton}
                                  onClick={() => subtractItem(item)}
                                  disabled={cartHydrationPending || busyItem !== null || quotingAddress || placingOrder}
                                  aria-label={`Remove one ${item.name}`}
                                >
                                  <Minus size={18} aria-hidden="true" />
                                </button>
                                <span className={styles.quantityCount} aria-live="polite">{quantity}</span>
                                <button
                                  type="button"
                                  className={styles.quantityButton}
                                  onClick={(event) => addItem(item, event.currentTarget)}
                                  disabled={cartHydrationPending || busyItem !== null || quotingAddress || placingOrder || !available}
                                  aria-label={`Add another ${item.name}`}
                                >
                                  <Plus size={18} aria-hidden="true" />
                                </button>
                              </div>
                            ) : item.isAvailable ? (
                              <button
                                type="button"
                                className={styles.addButton}
                                onClick={(event) => addItem(item, event.currentTarget)}
                                disabled={cartHydrationPending || busyItem !== null || quotingAddress || placingOrder || !available}
                                aria-label={!fulfillmentVerified
                                  ? `${item.name} unavailable because fulfilment could not be verified`
                                  : storeAcceptsOrders && !catalogVerified
                                  ? `${item.name} unavailable until menu choices are verified`
                                  : orderable
                                    ? `Add ${item.name}`
                                    : !catalog.isCurrentlyOpen
                                      ? `${item.name} unavailable while the store is closed`
                                      : `${item.name} unavailable while the store has paused orders`}
                              >
                                Add
                              </button>
                            ) : null}
                          </div>
                        </div>
                        <Photo
                          src={item.imageUrl}
                          alt={item.name}
                          vendorType={catalog.vendorType}
                          sizes="96px"
                          iconSize={26}
                          className={styles.itemImage}
                          dim={!item.isAvailable}
                        />
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <aside id="checkout" className={styles.rail} aria-label="Your order and checkout">
            <div className={styles.railHeader}>
              <p className={styles.railEyebrow}>
                Your order{selectedAddress ? ` · delivery to ${selectedAddress.label}` : ''}
              </p>
              <h2 ref={railHeading} tabIndex={-1} className={styles.railTitle}>{itemCount > 0 && directCheckoutBlocked ? 'Review saved cart' : catalog.name}</h2>
            </div>

            <div className={styles.railBody}>
              {cartItems.length === 0 ? (
                <p className={styles.emptyRail}>
                  {signedIn ? 'Add a menu item to start your order.' : 'Sign in with your phone to order here on the web. No app install needed.'}
                </p>
              ) : (
                <>
                  <div className={styles.railLines}>
                    {cartItems.map((line) => {
                      const needsReview = lineNeedsReview(line);
                      return (
                        <div key={line.id} className={`${styles.railLine} ${needsReview ? styles.reviewLine : ''}`}>
                          <span className={styles.railLineCopy}>
                            <span className={styles.railLineName}>
                              {line.quantity}× {line.name}
                            </span>
                            {(line.selectedOptionNames?.length ?? 0) > 0 ? (
                              <span className={styles.variantNames}>{line.selectedOptionNames?.join(' · ')}</span>
                            ) : null}
                            {needsReview ? <span className={styles.reviewTag}>Needs review</span> : null}
                          </span>
                          <span className={styles.railPrice}>{gyMoney(line.lineTotal ?? line.customerPrice * line.quantity)}</span>
                          <button
                            type="button"
                            className={styles.removeLineButton}
                            disabled={busyItem !== null || quotingAddress || placingOrder}
                            onClick={() => void mutateItem(line.itemId, () => removeCartLine(line.id), `${line.name} removed.`)}
                            aria-label={`Remove ${line.name}${line.selectedOptionNames?.length ? ` with ${line.selectedOptionNames.join(', ')}` : ''} from your order`}
                          >
                            <X size={16} aria-hidden="true" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {!directCheckoutBlocked ? <div className={styles.breakdown}>
                    <div className={styles.railLine}>
                      <span className={styles.railLineName}>Items</span>
                      <span className={styles.railPrice}>{gyMoney(subtotal)}</span>
                    </div>
                    <div className={styles.railLine}>
                      <span className={styles.railLineName}>Delivery fee</span>
                      <span className={styles.railPrice}>
                        {!hasDestinationQuote || deliveryFee == null ? 'Choose an address for a quote' : gyMoney(deliveryFee)}
                      </span>
                    </div>
                    {discount > 0 ? (
                      <div className={styles.railLine}>
                        <span className={styles.railLineName}>Discount</span>
                        <span className={styles.railPrice}>−{gyMoney(discount)}</span>
                      </div>
                    ) : null}
                    {riderTip > 0 ? (
                      <div className={styles.railLine}>
                        <span className={styles.railLineName}>Rider tip</span>
                        <span className={styles.railPrice}>{gyMoney(riderTip)}</span>
                      </div>
                    ) : null}
                    <div className={styles.totalLine}>
                      <span>Total</span>
                      <span className={styles.totalPrice}>{orderAmountLabel}</span>
                    </div>
                  </div> : null}
                </>
              )}

              {itemCount > 0 && directCheckoutBlocked ? (
                <div className={styles.reviewNotice} role={catalogState === 'unavailable' ? 'alert' : 'note'}>
                  <p>
                    {!catalogVerified
                      ? catalogState === 'loading'
                        ? 'Swift is still checking this menu’s required choices. Checkout stays locked until that server catalog is ready.'
                        : 'Swift could not verify this menu’s required choices. Checkout stays locked so no incomplete order is placed.'
                      : cartVendorMismatch
                        ? 'This saved cart is tied to another store quote. Swift cannot safely re-price its remaining items as this store without starting a fresh cart.'
                        : cartHasUnverifiedLines
                          ? 'Remove each item marked Needs review. Swift will not show or submit a total that includes an unavailable or unverified line.'
                          : cartOutOfRange
                            ? `This address is ${deliveryDistance.toFixed(1)} km from the store, outside its ${deliveryRadius.toFixed(1)} km delivery radius. Choose another saved address before ordering.`
                          : cashPromoBlocked
                            ? 'This saved cart has a delivery discount, but the server does not allow discounted cash delivery. Swift cannot remove only the promotion on the web yet; clear this cart to start again without it.'
                          : cartHasUnknownFulfillment
                            ? 'Swift could not verify how one of these items is fulfilled. Checkout stays locked until the live catalog provides that server truth.'
                          : cartHasMixedFulfillment
                            ? 'This cart mixes delivery and pickup items. The web API cannot provide one truthful pre-order quote for both modes.'
                            : cartHasPickup
                              ? 'This is a pickup order. Swift supports pickup server-side, but this web API does not provide its final pre-order pickup quote yet.'
                              : cartHasAppointment
                                ? 'Appointment checkout is not available on the web yet. Remove that line to continue with a delivery order.'
                                : 'Swift cannot verify this saved cart for direct checkout.'}
                  </p>
                  {catalogVerified && (cartVendorMismatch || cashPromoBlocked) ? (
                    confirmingClear ? (
                      <div className={styles.clearActions}>
                        <button ref={clearConfirmButton} type="button" className={styles.primaryButton} disabled={busyItem !== null} onClick={() => void clearSavedCart()}>
                          Clear saved cart
                        </button>
                        <button type="button" className={styles.secondaryButton} disabled={busyItem !== null} onClick={closeClearConfirmation}>
                          Keep saved items
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={(event) => {
                          clearReturnFocus.current = event.currentTarget;
                          setConfirmingClear(true);
                          window.requestAnimationFrame(() => clearConfirmButton.current?.focus());
                        }}
                      >
                        {cashPromoBlocked ? 'Start again without this promotion' : 'Start a fresh cart from this store'}
                      </button>
                    )
                  ) : null}
                </div>
              ) : null}

              {signedIn && cartItems.length > 0 && needsDeliveryAddress ? (
                <div className={styles.field}>
                  <label htmlFor="delivery-address" className={styles.microLabel}>Delivery address</label>
                  {addresses.length > 0 ? (
                    <select
                      id="delivery-address"
                      className={styles.select}
                      value={addressId}
                      disabled={quotingAddress || busyItem !== null || placingOrder}
                      onChange={(event) => void changeAddress(event.target.value)}
                    >
                      {addresses.map((address) => (
                        <option key={address.id} value={address.id}>
                          {address.label} — {address.addressLine1}, {address.city}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Link href="/cart" className={styles.secondaryButton}>Add a delivery address</Link>
                  )}
                </div>
              ) : null}

              <div className={styles.cashTruth}>
                <Banknote size={22} aria-hidden="true" />
                <div>
                  <p className={styles.cashTitle}>
                    {pickupContext ? 'Cash at pickup' : appointmentContext ? 'Pay the business directly' : 'Cash at the door'}
                  </p>
                  <p className={styles.cashCopy}>
                    {pickupContext
                      ? 'Pay the business when you collect. Swift does not hold your money.'
                      : appointmentContext
                        ? 'Payment goes directly to the business for your appointment. Swift does not hold your money.'
                        : cartHasMixedFulfillment || cartHasUnknownFulfillment
                          ? 'Swift does not hold order money. A single cash total is unavailable until the fulfilment mix is resolved.'
                        : cartItems.length > 0 && !directCheckoutBlocked && hasDestinationQuote
                      ? `Pay the rider ${gyMoney(total)} when your order arrives. Swift does not hold your money.`
                      : hasDestinationQuote
                        ? 'Pay the rider in cash when your order arrives. Swift does not hold your money.'
                        : 'Choose a delivery address for a real cash quote. Swift does not hold your money.'}
                  </p>
                </div>
              </div>

              {error ? (
                <div className={styles.alert} role="alert">
                  <p>{error}</p>
                  {signedIn && !cartHydrated ? (
                    <button type="button" className={styles.secondaryButton} disabled={loadingCart} onClick={() => { setError(null); setCartLoadVersion((version) => version + 1); }}>
                      Try loading your saved cart again
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className={styles.railFooter}>
              {!signedIn ? (
                <>
                  <Link
                    href={`/login?next=${encodeURIComponent(returnPath)}`}
                    className={styles.primaryButton}
                  >
                    Sign in to order
                  </Link>
                  <p className={styles.guestCopy}>
                    New to Swift?{' '}
                    <Link href={`/signup?next=${encodeURIComponent(returnPath)}`}>Create your web account</Link>.
                  </p>
                </>
              ) : cartItems.length === 0 ? (
                <button type="button" className={styles.primaryButton} disabled>Add an item to continue</button>
              ) : directCheckoutBlocked ? (
                <span className={styles.blockedCheckout}>Resolve the saved order above to continue</span>
              ) : (
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => void placeOrder()}
                  disabled={placingOrder || busyItem !== null || quotingAddress || (needsDeliveryAddress && !addressId) || !orderable || !meetsMinimum}
                >
                  {placingOrder
                    ? 'Placing order…'
                    : !orderable
                      ? 'Store is not taking orders'
                      : !meetsMinimum
                        ? `Add ${gyMoney(minimumShortfall)} to reach the minimum`
                        : 'Place cash order'}
                </button>
              )}
              <p className={styles.railNote}>
                Menu and checkout prices come from Swift’s server. After you order, any server-set hold and live tracking follow.
              </p>
            </div>
          </aside>
        </div>
      </div>

      {itemCount > 0 && !modalItem ? (
        <a href="#checkout" className={styles.mobileDock}>
          <span>View your order · {itemCount} item{itemCount === 1 ? '' : 's'}</span>
          <span className={styles.mobileTotal}>{directCheckoutBlocked ? 'Review' : orderAmountLabel}</span>
        </a>
      ) : null}

      {modalItem ? (
        <Sheet labelledBy="menu-options-title" onClose={closeOptions} className={styles.sheet}>
          <div className={styles.sheetHeader}>
            <Photo src={modalItem.imageUrl} alt="" vendorType={catalog.vendorType} sizes="72px" iconSize={26} className={styles.sheetPhoto} />
            <div className={styles.sheetHeading}>
              <h2 id="menu-options-title" className={styles.modalTitle}>{modalItem.name}</h2>
              {modalItem.description ? <p className={styles.modalDescription}>{modalItem.description}</p> : null}
            </div>
            <button data-modal-initial-focus type="button" className={styles.closeButton} onClick={closeOptions} aria-label="Close item options">
              <X size={20} aria-hidden="true" />
            </button>
          </div>

          <div className={styles.options}>
            {(modalItem.optionGroups ?? []).map((group) => {
              const selectedCount = (selectedOptions[group.id] ?? []).length;
              const multiLimitReached = group.maxSelect > 1 && selectedCount >= group.maxSelect;
              const onSale = group.options.filter((option) => option.isAvailable !== false);
              return (
                <div key={group.id} className={styles.optionBlock}>
                  <fieldset className={styles.optionGroup} data-option-group={group.id}>
                    <legend className={styles.optionHeading}>
                      <span className={styles.optionTitle}>{group.name}</span>
                      <span className={styles.optionMeta}>
                        {group.isRequired ? <span className={styles.required}>Required</span> : <span className={styles.optionGuidance}>{optionGuidance(group)}</span>}
                      </span>
                    </legend>
                    {group.isRequired && group.maxSelect > 1 ? <p className={styles.optionGuidance}>{optionGuidance(group)}</p> : null}
                    {onSale.length === 0 ? <p className={styles.optionGuidance}>Every choice here is sold out right now.</p> : null}
                    {onSale.map((option) => {
                      const checked = (selectedOptions[group.id] ?? []).includes(option.id);
                      const single = group.maxSelect <= 1;
                      const clearableSingle = single && !group.isRequired && group.minSelect === 0;
                      const blockedByLimit = multiLimitReached && !checked;
                      const extra = parseAmount(option.additionalPrice);
                      return (
                        <label key={option.id} className={`${styles.optionLabel} ${blockedByLimit ? styles.optionLabelDisabled : ''}`}>
                          <span className={styles.optionChoice}>
                            <input
                              type={single && !clearableSingle ? 'radio' : 'checkbox'}
                              name={group.id}
                              checked={checked}
                              disabled={blockedByLimit}
                              onChange={() => chooseOption(group, option.id)}
                            />
                            {option.name}
                          </span>
                          {extra === null ? (
                            <span className={styles.optionPrice}>Price unavailable</span>
                          ) : extra > 0 ? (
                            <span className={styles.optionPrice}>+{gyMoney(extra)}</span>
                          ) : null}
                        </label>
                      );
                    })}
                  </fieldset>
                </div>
              );
            })}
          </div>

          <div className={styles.sheetFooter}>
            {modalError ? <p id="menu-options-error" className={styles.modalAlert} role="alert">{modalError}</p> : null}
            <div className={styles.sheetFooterRow}>
              <div className={styles.quantity} role="group" aria-label="Quantity">
                <button type="button" className={styles.quantityButton} aria-label="Decrease quantity" disabled={itemQuantity <= 1 || busyItem !== null} onClick={() => setItemQuantity((count) => Math.max(1, count - 1))}><Minus size={18} aria-hidden="true" /></button>
                <span className={styles.quantityCount} role="status" aria-label={`Quantity ${itemQuantity}`}>{itemQuantity}</span>
                <button type="button" className={styles.quantityButton} aria-label="Increase quantity" disabled={itemQuantity >= 99 || busyItem !== null} onClick={() => setItemQuantity((count) => Math.min(99, count + 1))}><Plus size={18} aria-hidden="true" /></button>
              </div>
              <button
                type="button"
                className={`${styles.primaryButton} ${styles.sheetAdd}`}
                disabled={busyItem !== null || modalUnitPrice === null}
                aria-describedby={modalError ? 'menu-options-error' : undefined}
                onClick={confirmOptions}
              >
                Add to order · {gyMoney(modalUnitPrice === null ? null : modalUnitPrice * itemQuantity)}
              </button>
            </div>
          </div>
        </Sheet>
      ) : null}

      {notice ? (
        <div className={styles.notice} role="status">
          <span>{notice.message}</span>
          {notice.added ? <a href="#checkout" className={styles.noticeLink}>View order</a> : null}
        </div>
      ) : null}
      {floatingError ? <p className={styles.errorNotice} role="alert">{floatingError}</p> : null}
    </div>
  );
}
