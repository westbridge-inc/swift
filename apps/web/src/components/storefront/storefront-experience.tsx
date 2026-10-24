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
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
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
import { LIVE_MENU_MAX_AGE_MS, type ServerStoreMenu } from '@/lib/browse-keys';
import {
  OptionSelectionError,
  basePrice,
  fromPrice,
  isPlainLine,
  opensChoices,
  requiredChoiceSoldOut,
  requiredCount,
  selectionPrice,
  validateSelectedOptions,
} from '@/lib/menu-options';
import { useOptionalCustomerSession } from '@/components/customer-session';
import { useOrderingContext } from '@/components/ordering-context';
import { MODE_LOCKED } from '@/lib/ordering-mode-lock';
import { FulfilmentChoice } from '@/components/checkout/fulfilment-choice';
import { guestCart } from '@/lib/basket-projection';
import { useGuestBasket } from '@/lib/basket-state';
import { Photo } from '@/components/order-ui';
import Image from 'next/image';
import { photo } from '@/lib/media';
import { StoreActions } from './store-actions';
import styles from './storefront.module.css';
import { SellerInfo } from './seller-info';
import { AddPlusGlyph } from '@/components/add-plus';
import { STORE_PICK } from '@/lib/store-pick';

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

/**
 * How often an open store page re-reads the live store and menu in the
 * background. [PERF #2] Only while the page is on screen: a hidden page reads
 * nothing, and coming back after longer than this reads at once. Every Add
 * and every checkout is re-checked by the API whatever this copy says.
 */
export const CATALOG_REFRESH_MS = LIVE_MENU_MAX_AGE_MS;

/** [PERF #2] Server renders whose live menu this browser has already shown. */
const shownServerMenus = new Set<string>();
const noSubscription = () => () => {};

/**
 * [W6] An item's sheet (choices, quantity, Add) is only needed after a tap or
 * a link that names an item, so its code is not in the store page's first
 * load. In the browser it is fetched as soon as this page's own code has run
 * (after the first-load JavaScript, never before it) and kept here, so a tap
 * opens the sheet at once. A sheet asked for before its code has arrived
 * opens as soon as it does; nothing stands in for it meanwhile.
 */
let itemSheetModule: typeof import('./item-sheet') | null = null;
let itemSheetLoading: Promise<typeof import('./item-sheet')> | null = null;
/** Fetches the item sheet's code once (and again after a failed fetch). */
export function loadItemSheet(): Promise<typeof import('./item-sheet')> {
  itemSheetLoading ??= import('./item-sheet').then(
    (module) => (itemSheetModule = module),
    (error: unknown) => { itemSheetLoading = null; throw error; },
  );
  return itemSheetLoading;
}
if (typeof window !== 'undefined') void loadItemSheet().catch(() => undefined);
const ITEM_SHEET_UNAVAILABLE = 'Swift could not open this item. Check your connection and try again.';

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
      imageUrl: category.imageUrl ?? null,
      items: category.items.map((item) => ({
        ...item,
        description: item.description ?? undefined,
        customerPrice: item.basePrice,
        isAvailable: true,
      })),
    })),
  };
}

/** The store copy merged with the live menu: the menu (choices, availability,
 *  open and accepting) wins; the store copy keeps its address and minimum. */
function liveCatalog(store: StorefrontDetail, vendor: VendorDetail): DisplayVendor {
  const fromStore = publicCatalog(store);
  return {
    ...fromStore,
    ...(vendor as DisplayVendor),
    addressLine1: fromStore.addressLine1,
    minOrderAmount: fromStore.minOrderAmount,
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

/**
 * [#1590] A menu photo that fails to load falls back to the same pictogram
 * tile as an item without one; keyed by its address, it tries again when the
 * live menu sends a new one.
 */
/**
 * [IMAGES-E2E PR5 · COORD GO 21 Oct, owner rule "business pictures must reach customers"]
 * A menu section's own photo above its heading, as on the phone. Only a photo Swift keeps is
 * drawn (photo() picks the bounded /media route and its ladder loader for those alone); no
 * photo, an outside address or a photo that fails to load draws nothing: today's heading.
 */
function SectionPhoto({ imageUrl, first = false }: { imageUrl?: string | null; first?: boolean }) {
  const [failed, setFailed] = useState(false);
  const media = failed ? null : photo(imageUrl);
  if (!media?.loader) return null;
  return (
    <span className={styles.sectionPhoto}>
      {/* [REVIEW-F S4-2 on #1973] The first section can sit above the fold: its photo loads at once; the rest lazily. */}
      <Image {...media} alt="" fill sizes="(min-width: 760px) 640px, 100vw" loading={first ? 'eager' : 'lazy'} className="object-cover" onError={() => setFailed(true)} />
    </span>
  );
}

function ItemPhoto({ item, vendorType }: { item: DisplayItem; vendorType: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  return (
    <Photo
      src={failed ? null : item.imageUrl}
      alt={item.name}
      vendorType={vendorType}
      sizes="96px"
      iconSize={26}
      className={styles.itemImage}
      dim={!item.isAvailable}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * `verticalStyle` is the store's vertical tint, worked out on the server
 * (storefront-page.tsx) so the design-token tables stay out of the page's
 * first-load JavaScript.
 */
export function StorefrontExperience({ store, returnPath, fromQr = false, initialItemId, verticalStyle, liveMenu }: { store: StorefrontDetail; returnPath: string; fromQr?: boolean; initialItemId?: string; verticalStyle?: CSSProperties; liveMenu?: ServerStoreMenu | null }) {
  const router = useRouter();
  // [W6] The store page lives inside the customer app's frame (rail, dock,
  // session). Its session can renew an expired access cookie before sending a
  // guest to sign in, and its cart count is refreshed after every change made
  // here. Rendered on its own (tests), both are simply absent.
  const shellSession = useOptionalCustomerSession();
  const shellStatus = shellSession?.status;
  // [W5] Delivery or pickup — the one ordering context the checkout reads.
  const { mode: orderingMode, setMode: setOrderingMode } = useOrderingContext();
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
  // [PERF #2] A page that arrives with the server's recent live menu starts
  // ready to order from it. While React adopts the HTML the server just drew
  // for this visit, the menu is taken as the server judged it (at most
  // LIVE_MENU_MAX_AGE_MS old). A page drawn in the browser instead may be a
  // kept copy (Back/Forward, a load made earlier): its menu counts once per
  // server render, and only while it is at most LIVE_MENU_MAX_AGE_MS old by
  // this phone's clock. Otherwise the page reads the live menu before Add
  // works, as before.
  const adoptingServerHtml = useSyncExternalStore(noSubscription, () => false, () => true);
  const [serverMenu] = useState<ServerStoreMenu | null>(() => {
    if (!liveMenu || liveMenu.vendor.id !== store.id || shownServerMenus.has(liveMenu.renderId)) return null;
    return adoptingServerHtml || Date.now() - liveMenu.at <= LIVE_MENU_MAX_AGE_MS ? liveMenu : null;
  });
  const [catalog, setCatalog] = useState<DisplayVendor>(() => (serverMenu ? liveCatalog(store, serverMenu.vendor) : publicCatalog(store)));
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'unavailable'>(serverMenu ? 'ready' : 'loading');
  const [catalogCheckedAt, setCatalogCheckedAt] = useState<Date | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  // [Row 109] Until the server has answered (the shell says "checking", or this page's
  // own probe is out) the basket is neither the guest's nor the customer's: it says it
  // is checking, shows no guest copy and takes no adds — no signed-out flash.
  const [sessionKnown, setSessionKnown] = useState(false);
  const [cart, setCart] = useState<Cart | null>(null);
  const [loadingCart, setLoadingCart] = useState(false);
  const [cartHydrated, setCartHydrated] = useState(false);
  const [cartLoadVersion, setCartLoadVersion] = useState(0);
  useEffect(() => { if (!signedIn && sessionKnown) setCart(guestCart(guestBasket)); }, [signedIn, sessionKnown, guestBasket]);
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
  const [, setItemSheetLoaded] = useState(() => itemSheetModule !== null);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
  const mutationBusy = useRef(false);
  const restoringSession = useRef(false);
  const modalReturnFocus = useRef<HTMLElement | null>(null);
  const railHeading = useRef<HTMLHeadingElement | null>(null);
  const orderPanel = useRef<HTMLElement | null>(null);
  const page = useRef<HTMLDivElement | null>(null);
  const orderDock = useRef<HTMLAnchorElement | null>(null);
  // Keep the dock out of the way until the browser confirms the panel is off screen.
  const [checkoutVisible, setCheckoutVisible] = useState(true);

  useEffect(() => {
    if (!orderPanel.current || typeof IntersectionObserver === 'undefined') return;
    // One callback can carry several crossings, oldest first; only the newest says where the panel is now.
    const observer = new IntersectionObserver((entries) => {
      const latest = entries[entries.length - 1];
      if (latest) setCheckoutVisible(latest.isIntersecting);
    }, { threshold: 0 });
    observer.observe(orderPanel.current);
    return () => observer.disconnect();
  }, []);


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
    // [PERF #2] When the menu this page holds was read (or last tried), by this phone's clock.
    let lastRead = 0;

    const refreshCatalog = async () => {
      if (catalogRefreshInFlight) return;
      catalogRefreshInFlight = true;
      lastRead = Date.now();
      try {
        const [liveStore, vendor] = await Promise.all([
          getPublicStorefront(store.slug),
          getPublicVendor(store.id),
        ]);
        if (!alive) return;
        setCatalog(liveCatalog(liveStore, vendor));
        setCatalogState('ready');
        setCatalogCheckedAt(new Date());
      } catch {
        if (alive) setCatalogState('unavailable');
      } finally {
        catalogRefreshInFlight = false;
      }
    };
    const onScreen = () => document.visibilityState !== 'hidden';
    const tick = () => { if (onScreen()) void refreshCatalog(); };
    let catalogTimer: number | undefined;
    let firstTick: number | undefined;
    if (serverMenu) {
      // The server's read is this page's first: the next is due when it is
      // LIVE_MENU_MAX_AGE_MS old (the older of the two clocks' estimates).
      shownServerMenus.add(serverMenu.renderId);
      const age = Math.min(LIVE_MENU_MAX_AGE_MS, Math.max(serverMenu.ageMs, Date.now() - serverMenu.at));
      lastRead = Date.now() - age;
      setCatalogCheckedAt(new Date(lastRead));
      firstTick = window.setTimeout(() => {
        tick();
        catalogTimer = window.setInterval(tick, CATALOG_REFRESH_MS);
      }, CATALOG_REFRESH_MS - age);
    } else {
      setCatalogState('loading');
      void refreshCatalog();
      catalogTimer = window.setInterval(tick, CATALOG_REFRESH_MS);
    }
    const onVisibility = () => { if (onScreen() && Date.now() - lastRead >= CATALOG_REFRESH_MS) void refreshCatalog(); };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      alive = false;
      window.clearTimeout(firstTick);
      window.clearInterval(catalogTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [store.id, store.slug, serverMenu]);

  useEffect(() => {
    let alive = true;

    // [W-01] Signed-in is the server's answer about an HttpOnly cookie, not a
    // token this script can read. Start signed-OUT, ask, and hydrate the cart
    // only once the server has attested — so a signed-out visitor never fires
    // the authenticated cart load, exactly as the token check used to prevent.
    setSignedIn(false);
    setSessionKnown(false);
    if (shellStatus === 'checking') return () => { alive = false; };
    void (shellStatus !== undefined ? Promise.resolve({ ok: shellStatus === 'signed-in' }) : sessionProbe()).then((session) => {
      if (!alive) return;
      setSessionKnown(true);
      if (!session.ok) return;
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
  const cartHydrationPending = !sessionKnown || (signedIn && !cartHydrated);
  const itemCount = cartItems.reduce((sum, line) => sum + line.quantity, 0);
  useEffect(() => {
    const dock = orderDock.current;
    if (!dock) return;
    const measure = () => {
      const height = dock.getBoundingClientRect().height;
      // Retain the last visible height when hidden, including wrapped/zoomed text.
      if (height > 0) page.current?.style.setProperty('--swift-order-dock-height', `${height}px`);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    return () => observer.disconnect();
    // The dock also hides while an item's sheet is open: measure it again when it comes back.
  }, [itemCount, checkoutVisible, modalItem]);
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
  /**
   * [W6] The line the row's "−" takes one from: the item's plain line (no
   * choice, no note), which is exactly what "+" adds, and only while it is
   * the item's ONLY configuration in the order. Otherwise null: the row shows
   * no "−", and the order panel's × removes a chosen line by name.
   */
  const stepperLine = (itemId: string) => {
    const lines = cartItems.filter((line) => line.itemId === itemId);
    return lines.length > 0 && lines.every(isPlainLine) ? lines.at(-1)! : null;
  };

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
  // [PERF #2] And once the page knows who is visiting: the live menu can now
  // arrive with the page, before the session answer, and adds wait for that
  // answer [Row 109], so the sheet opens when its Add can work (and goes to a
  // signed-in person's saved cart, never this browser's basket).
  useEffect(() => {
    if (!initialItemId || deepLinkOpened.current || catalogState !== 'ready' || !sessionKnown) return;
    deepLinkOpened.current = true;
    const item = catalog.categories.flatMap(category => category.items).find(item => item.id === initialItemId);
    // A closed or paused store opens nothing: its Add could only refuse.
    if (item?.isAvailable && item.fulfillment === 'DELIVERY' && catalog.isCurrentlyOpen && catalog.acceptingOrders) {
      setSelectedOptions(selectedDefaults(item.optionGroups ?? []));
      setItemQuantity(1);
      setModalError(null);
      setModalItem(item);
    }
  }, [initialItemId, catalogState, catalog, sessionKnown]);

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

  // [W6] A sheet asked for before its code has arrived opens when it does. If
  // the code cannot be fetched, the customer is told instead of a tap doing
  // nothing (and the next tap fetches it again).
  useEffect(() => {
    if (!modalItem) return;
    // The code can land after the render that opened the sheet (a link or the
    // return from sign-in open it from an effect) but before this effect:
    // render again so the sheet shows now, not at the next unrelated update.
    if (itemSheetModule) { setItemSheetLoaded(true); return; }
    let alive = true;
    loadItemSheet().then(() => {
      if (!alive) return;
      setItemSheetLoaded(true);
      // An earlier failed fetch is no longer news once the sheet opens.
      setError((current) => (current === ITEM_SHEET_UNAVAILABLE ? null : current));
      setFloatingError((current) => (current === ITEM_SHEET_UNAVAILABLE ? null : current));
    }, () => {
      if (!alive) return;
      setModalItem(null);
      setError(ITEM_SHEET_UNAVAILABLE);
      setFloatingError(ITEM_SHEET_UNAVAILABLE);
      window.setTimeout(() => setFloatingError(null), 4200);
    });
    return () => { alive = false; };
  }, [modalItem]);

  const subtractItem = async (item: DisplayItem) => {
    // [W6] The row's "−" takes one from the item's plain line only (what "+"
    // adds) — in a guest's browser basket exactly as in a saved cart.
    const line = stepperLine(item.id);
    if (!line) return;
    if (!signedIn) {
      try { const { changeGuestQuantity } = await import('@/lib/basket'); changeGuestQuantity(line.id, line.quantity - 1); } catch (e) { setError((e as Error).message); }
      return;
    }
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
    <div ref={page} className={styles.page} style={verticalStyle}>
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

        {/* [PERF #2] A page that arrives with the live menu draws this line in
            the server's HTML too (the time follows once the phone's clock
            shows it), so it never pushes the whole menu down after the page
            appears (a layout shift of 0.2 on a 100-item store). */}
        {catalogState === 'ready' ? (
          <p className={styles.menuFreshness}>
            {catalogCheckedAt
              ? `Live menu checked at ${catalogCheckedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
              : 'Live menu checked'}
          </p>
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
            {sections.map((category, index) => (
              <section key={category.id} id={`section-${category.id}`} className={styles.section}>
                <SectionPhoto imageUrl={category.imageUrl} first={index === 0} />
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
                    const from = choices ? fromPrice(item) : null;
                    const choiceSoldOut = choices && item.isAvailable && requiredChoiceSoldOut(item);
                    const stepper = quantity > 0 && stepperLine(item.id) !== null;
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
                            {item.isPopular ? <span className={styles.popular}>{STORE_PICK}</span> : null}
                            {item.unit ? <span className={styles.unit}>per {item.unit}</span> : null}
                            {!item.isAvailable || choiceSoldOut ? <span className={styles.soldOut}>Sold out</span> : null}
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
                              {choices && from !== null ? <span className={styles.fromLabel}>From</span> : null}
                              <span>{gyMoney(choices ? from : itemPrice(item))}</span>
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
                            ) : stepper ? (
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
                                    ? quantity > 0 ? `Add another ${item.name}` : `Add ${item.name}`
                                    : !catalog.isCurrentlyOpen
                                      ? `${item.name} unavailable while the store is closed`
                                      : `${item.name} unavailable while the store has paused orders`}
                              >
                                <AddPlusGlyph />
                              </button>
                            ) : null}
                          </div>
                        </div>
                        <ItemPhoto key={item.imageUrl ?? ''} item={item} vendorType={catalog.vendorType} />
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <aside ref={orderPanel} id="checkout" className={styles.rail} aria-label="Your order and checkout">
            <div className={styles.railHeader}>
              <p className={styles.railEyebrow}>Your order</p>
              <h2 ref={railHeading} tabIndex={-1} className={styles.railTitle}><span className="sr-only">Your order, </span>{cartVendorMismatch ? 'Your saved cart' : catalog.name}</h2>
            </div>

            <div className={styles.railBody}>
              <FulfilmentChoice name="store-fulfilment" value={orderingMode} onChange={(mode) => setError(setOrderingMode(mode) ? null : MODE_LOCKED)} />
              {orderingMode === 'PICKUP' ? (
                <p className={styles.railNote}>Pickup from {storeLabel || catalog.name} · No delivery fee</p>
              ) : null}
              {!sessionKnown ? (
                <p className={styles.emptyRail} role="status" aria-busy="true">Checking your basket…</p>
              ) : cartItems.length === 0 ? (
                <p className={styles.emptyRail}>
                  {signedIn ? 'Add a menu item to start your order.' : 'Add a menu item to start your order. No account needed to fill your basket.'}
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
              {!signedIn && sessionKnown ? (
                <>
                  <button type="button" disabled={!itemCount} onClick={goToCheckout} className={styles.primaryButton}>Place order</button>
                  <p className={styles.guestCopy}>Sign in with your phone at Place order. We then price your basket, delivery or pickup, and the total.</p>
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
                We confirm delivery or pickup, the fee and the total at checkout.
              </p>
            </div>
          </aside>
        </div>

        {/* [R3 · CAA s.70] Who sells, how payment works and the store's refund rule, from the server render. */}
        {store.seller ? <SellerInfo seller={store.seller} /> : null}
      </div>

      {itemCount > 0 && !modalItem && !checkoutVisible ? (
        // [W4] One tap to the one checkout — never a jump to a panel the
        // phone's bars could cover. [#1590] Hidden while the order panel (with
        // its own Checkout button) is on screen; measured for the page's bottom space.
        <Link ref={orderDock} href="/checkout" className={styles.mobileDock}>
          <span>Checkout · {itemCount} item{itemCount === 1 ? '' : 's'}</span>
          <span className={styles.mobileTotal}>{basketLabel}</span>
        </Link>
      ) : null}

      {modalItem && itemSheetModule ? (
        <itemSheetModule.ItemSheet
          item={modalItem}
          vendorType={catalog.vendorType}
          selectedOptions={selectedOptions}
          onChoose={chooseOption}
          quantity={itemQuantity}
          onQuantity={setItemQuantity}
          error={modalError}
          busy={busyItem !== null}
          cartLoading={cartHydrationPending}
          unitPrice={modalUnitPrice}
          onConfirm={confirmOptions}
          onClose={closeOptions}
        />
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
