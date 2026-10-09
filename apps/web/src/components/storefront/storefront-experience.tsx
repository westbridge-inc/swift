'use client';

import { formatAmount } from '@/lib/money';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { QueryClientContext } from '@tanstack/react-query';
import {
  Clock3,
  Minus,
  Plus,
  X,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiRequestError, sessionProbe } from '@/lib/auth';
import { clearStorefrontContinuation, takeStorefrontContinuation } from '@/lib/storefront-continuation';
import {
  addToCart,
  getCart,
  getPublicStorefront,
  getPublicVendor,
  readCheckoutAttempt,
  removeCartLine,
  updateCartLine,
  type Cart,
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
  opensChoices,
  requiredCount,
  selectionPrice,
  validateSelectedOptions,
} from '@/lib/menu-options';
import { useOptionalCustomerSession } from '@/components/customer-session';
import { guestCart } from '@/lib/basket-projection';
import { useGuestBasket } from '@/lib/basket-state';
import { Photo } from '@/components/order-ui';
const ItemOptionsPanel = lazy(() => import('./item-options-panel').then(module => ({ default: module.ItemOptionsPanel })));
import { StoreActions } from './store-actions';
import styles from './storefront.module.css';

export type DisplayItem = MenuItem & {
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
  const shellSession = useOptionalCustomerSession();
  const shellStatus = shellSession?.status;
  const guestBasket = useGuestBasket();
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
  const [loadingCart, setLoadingCart] = useState(false);
  const [cartHydrated, setCartHydrated] = useState(false);
  const [cartLoadVersion, setCartLoadVersion] = useState(0);
  useEffect(() => { if (!signedIn) setCart(guestCart(guestBasket)); }, [signedIn, guestBasket]);
  useEffect(() => {
    const changed = () => setCartLoadVersion(v => v + 1);
    window.addEventListener('swift-guest-merged', changed);
    return () => window.removeEventListener('swift-guest-merged', changed);
  }, []);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; added: boolean } | null>(null);
  const [floatingError, setFloatingError] = useState<string | null>(null);
  const [modalItem, setModalItem] = useState<DisplayItem | null>(null);
  const [itemQuantity, setItemQuantity] = useState(1);
  const deepLinkOpened = useRef(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
  const mutationBusy = useRef(false);
  const restoringSession = useRef(false);
  const modalReturnFocus = useRef<HTMLElement | null>(null);
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

    return () => {
      alive = false;
      window.clearInterval(catalogTimer);
    };
  }, [store.id, store.slug]);

  useEffect(() => {
    let alive = true;

    // [W-01] Signed-in is the server's answer about an HttpOnly cookie, not a
    // token this script can read. Start signed-OUT, ask, and hydrate the cart
    // only once the server has attested — so a signed-out visitor never fires
    // the authenticated cart load, exactly as the token check used to prevent.
    setSignedIn(false);
    void (shellStatus !== undefined ? Promise.resolve({ ok: shellStatus === 'signed-in' }) : sessionProbe()).then((session) => {
      if (!alive || !session.ok) return;
      setSignedIn(true);
      setLoadingCart(true);
      setCartHydrated(false);
      // [W4] The store page shows the cart; the one checkout page prices the
      // delivery or pickup and places the order, so no address is read here.
      return getCart({ redirectOnExpired: false })
        .then((nextCart) => {
          if (!alive) return;
          setCart(nextCart);
          setCartHydrated(true);
        })
        .catch((loadError) => {
          if (!alive) return;
          // [W-01] The session can die between the probe and the load. With a
          // cookie there is nothing local to re-inspect, so the SERVER's 401 is
          // the signal — sign out quietly instead of showing a load error.
          if (loadError instanceof ApiRequestError && loadError.status === 401) {
            setSignedIn(false);
            setCart(null);
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
    };
  }, [cartLoadVersion, store.id, store.slug, shellStatus, shellSession?.scope, shellSession?.epoch]);

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
  const storeLabel = [catalog.addressLine1, catalog.city].filter(Boolean).join(', ');
  const categoryItems = catalog.categories.flatMap((category) => category.items as DisplayItem[]);
  const catalogItemIds = new Set(categoryItems.map((item) => item.id));
  const cartVendorMismatch = cartItems.length > 0 && cart?.vendor?.id !== catalog.id;
  const lineNeedsReview = (line: Cart['items'][number]) => !catalogItemIds.has(line.itemId) || line.isAvailable === false;
  // [W4] The rail shows what is in the basket; prices, fees and the total are
  // the checkout's (the server's quote, for delivery or pickup).
  const basketLabel = gyMoney(subtotal);
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

  // An order the checkout sent but could not confirm keeps this cart frozen
  // until that same order is retried or confirmed on the checkout page.
  const cartMutationLockedByCheckout = () => {
    if (!readCheckoutAttempt()) return false;
    const message = 'A checkout attempt still has an unresolved server outcome. Check Orders or retry the same order before changing this cart.';
    setError(message);
    showFloatingError(message);
    return true;
  };

  /**
   * [W4] Every order is placed on the one checkout page. A guest signs in at
   * Place order: an expired access cookie is renewed first, so a returning
   * customer is never sent to sign in for nothing, and the code brings them
   * straight to the checkout, where the browser basket is uploaded.
   */
  const goToCheckout = () => {
    if (signedIn) { router.push('/checkout'); return; }
    if (restoringSession.current) return;
    restoringSession.current = true;
    const toSignIn = () => router.push(`/login?next=${encodeURIComponent('/checkout')}`);
    void (shellSession?.ensureSignedIn() ?? Promise.resolve(false)).then((restored) => {
      restoringSession.current = false;
      if (restored) router.push('/checkout');
      else toSignIn();
    }, () => {
      restoringSession.current = false;
      toSignIn();
    });
  };

  const mutateItem = async (itemId: string, work: () => Promise<unknown>, message?: string, added = false) => {
    if (mutationBusy.current || cartHydrationPending || cartMutationLockedByCheckout()) return;
    mutationBusy.current = true;
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

  const addLocal = async (item: DisplayItem, quantity: number, selectedOptions: Record<string, string | string[]>) => {
    try {
      const { addGuestLine, clearGuestBasket } = await import('@/lib/basket');
      const unitPrice = selectionPrice(item, Object.fromEntries(Object.entries(selectedOptions).map(([k, v]) => [k, typeof v === 'string' ? [v] : v])));
      if (unitPrice === null) throw new Error('Check the live item price before adding it.');
      const result = addGuestLine({ vendorId: catalog.id, storeSlug: store.slug, vendorName: catalog.name, itemId: item.id,
        name: item.name, quantity, unitPrice, selectedOptions, fulfillment: item.fulfillment, returnPath });
      if (result === 'DIFFERENT_STORE') {
        if (window.confirm('Your basket is from another store. Replace it with this store’s basket?')) {
          clearGuestBasket(); await addLocal(item, quantity, selectedOptions);
        }
        return;
      }
      if (result === 'QUANTITY_LIMIT') throw new Error('You can add up to 99 of one item and choice.');
      showNotice(`${item.name} added to your order.`, true);
    } catch (e) { setError((e as Error).message); }
  };

  const addItem = (item: DisplayItem, trigger?: HTMLElement) => {
    if (!orderable || !item.isAvailable || cartHydrationPending || cartMutationLockedByCheckout()) return;
    // [W6] One tap adds an item that needs no choice; an item with a required
    // choice, or one the store pre-selects, opens its options instead.
    if (opensChoices(item)) {
      openOptions(item, trigger);
      return;
    }
    if (!signedIn) { addLocal(item, 1, {}); return; }
    // Add sends the complete base selection to the server.
    void mutateItem(
      item.id,
      () => addToCart({ vendorId: catalog.id, itemId: item.id, quantity: 1 }),
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
    // A closed or paused store opens nothing: its Add could only refuse.
    if (item?.isAvailable && item.fulfillment === 'DELIVERY' && catalog.isCurrentlyOpen && catalog.acceptingOrders) {
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
    setItemQuantity(intent.quantity ?? 1);
    setModalError(null);
    setModalItem(item);
  }, [signedIn, cartHydrated, catalogState, catalog, store.slug]);

  const subtractItem = async (item: DisplayItem) => {
    if (!signedIn) {
      const line = guestBasket.lines.filter(l => l.itemId === item.id).at(-1);
      if (line) { try { const { changeGuestQuantity } = await import('@/lib/basket'); changeGuestQuantity(line.clientLineId, line.quantity - 1); } catch (e) { setError((e as Error).message); } }
      return;
    }
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
    if (cartHydrationPending) { setModalError('Your cart is still loading. Keep this item open and try again.'); return; }
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
      addLocal(liveItem, itemQuantity, selected); closeOptions(); return;
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
                    const choices = opensChoices(item);
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
                                disabled={cartHydrationPending || busyItem !== null}
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
                                disabled={cartHydrationPending || busyItem !== null || !available}
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
                                  disabled={cartHydrationPending || busyItem !== null}
                                  aria-label={`Remove one ${item.name}`}
                                >
                                  <Minus size={18} aria-hidden="true" />
                                </button>
                                <span className={styles.quantityCount} aria-live="polite">{quantity}</span>
                                <button
                                  type="button"
                                  className={styles.quantityButton}
                                  onClick={(event) => addItem(item, event.currentTarget)}
                                  disabled={cartHydrationPending || busyItem !== null || !available}
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
                                disabled={cartHydrationPending || busyItem !== null || !available}
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
              <p className={styles.railEyebrow}>Your order</p>
              <h2 ref={railHeading} tabIndex={-1} className={styles.railTitle}>{cartVendorMismatch ? 'Your saved cart' : catalog.name}</h2>
            </div>

            <div className={styles.railBody}>
              {cartItems.length === 0 ? (
                <p className={styles.emptyRail}>
                  Add a menu item to start your order. No account needed to fill your basket.
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
                            disabled={busyItem !== null}
                            onClick={() => { if (!signedIn) { try { void import('@/lib/basket').then(({ changeGuestQuantity }) => changeGuestQuantity(line.id, 0)).catch(e => setError(e.message)); } catch (e) { setError((e as Error).message); } } else void mutateItem(line.itemId, () => removeCartLine(line.id), `${line.name} removed.`); }}
                            aria-label={`Remove ${line.name}${line.selectedOptionNames?.length ? ` with ${line.selectedOptionNames.join(', ')}` : ''} from your order`}
                          >
                            <X size={16} aria-hidden="true" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <div className={styles.breakdown}>
                    <div className={styles.totalLine}>
                      <span>{signedIn ? 'Items' : 'Items (estimate)'}</span>
                      <span className={styles.totalPrice}>{basketLabel}</span>
                    </div>
                  </div>
                  {cartVendorMismatch ? (
                    <p className={styles.reviewNotice} role="note">
                      Your saved cart has items from another store. Review it at checkout: finish or clear that order before ordering here.
                    </p>
                  ) : null}
                </>
              )}

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
                  <button type="button" disabled={!itemCount} onClick={goToCheckout} className={styles.primaryButton}>Place order</button>
                  <p className={styles.guestCopy}>Sign in with your phone at Place order. Swift’s server then prices your basket, delivery or pickup, and the total.</p>
                  <p className={styles.guestCopy}>
                    New to Swift?{' '}
                    <Link href={`/signup?next=${encodeURIComponent('/checkout')}`}>Create your web account</Link>.
                  </p>
                </>
              ) : (
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={goToCheckout}
                  disabled={!itemCount || busyItem !== null || cartHydrationPending}
                >
                  {itemCount ? `Checkout · ${basketLabel}` : 'Add an item to continue'}
                </button>
              )}
              <p className={styles.railNote}>
                Delivery or pickup, the fee and the total are confirmed by Swift’s server at checkout.
              </p>
            </div>
          </aside>
        </div>
      </div>

      {itemCount > 0 && !modalItem ? (
        // [W4] One tap to the one checkout — never a jump to a panel the
        // phone's bars could cover.
        <Link href="/checkout" className={styles.mobileDock}>
          <span>Checkout · {itemCount} item{itemCount === 1 ? '' : 's'}</span>
          <span className={styles.mobileTotal}>{basketLabel}</span>
        </Link>
      ) : null}

      {modalItem ? (
        <Suspense fallback={<p role="status">Loading item options…</p>}><ItemOptionsPanel modalItem={modalItem} vendorType={catalog.vendorType} selectedOptions={selectedOptions} chooseOption={chooseOption} itemQuantity={itemQuantity} setItemQuantity={setItemQuantity} busyItem={busyItem} modalError={modalError} modalUnitPrice={modalUnitPrice} cartHydrationPending={cartHydrationPending} closeOptions={closeOptions} confirmOptions={confirmOptions} /></Suspense>
      ) : null}

      {notice ? (
        <div className={styles.notice} role="status">
          <span>{notice.message}</span>
          {notice.added ? <Link href="/checkout" className={styles.noticeLink}>Checkout</Link> : null}
        </div>
      ) : null}
      {floatingError ? <p className={styles.errorNotice} role="alert">{floatingError}</p> : null}
    </div>
  );
}
