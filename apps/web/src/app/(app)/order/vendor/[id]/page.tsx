'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bike, Clock, Heart, Info, MapPin, Minus, Plus, Share2, Star, X } from 'lucide-react';
import { getVendor, addToCart, getItemSlots, savePendingAppointment, money, type VendorDetail, type MenuItem, type OptionGroup } from '@/lib/customer';
import { addAppointmentDays, appointmentDayKey, formatAppointmentClock, formatAppointmentDay, formatAppointmentSlot } from '@/lib/appointmentTime';
import { useCustomerSession } from '@/components/customer-session';
import { MenuSkeleton, STORE_HERO } from '@/components/customer-skeletons';
import { BackButton, useOwnBackButton } from '@/components/customer-shell';
import { DataUnavailable } from '@/components/data-unavailable';
import { Photo, ratingText } from '@/components/order-ui';
import { accountApi } from '@/components/account/account-api';
import { useAccountQuery } from '@/components/account/account-frame';
import { Modal } from '@/components/modal';
import { signInPath } from '@/lib/customer-routes';
import { cartItemCount, customerCartKey, readShellCart } from '@/lib/shell-data';
import { parseAmount } from '@/lib/money';
import { photo } from '@/lib/media';
import { fromPage, vendorDetailKey } from '@/lib/browse-keys';
import { useStoreSeed } from '@/components/browse-seed';

/** The store, reopened at one item: `?item=` from Home's popular rail, the
 *  Market, or a guest coming back from signing in to add it. */
function requestedItemId(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('item');
}

function nextDays(n: number) {
  const out: { key: string; label: string }[] = [];
  const base = appointmentDayKey(new Date());
  for (let i = 0; i < n; i++) {
    const key = addAppointmentDays(base, i);
    out.push({ key, label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : formatAppointmentDay(key) });
  }
  return out;
}

/** [F4] A choice the store has marked sold out is never offered, pre-selected
 *  or sent (the server refuses it too, for every app). */
function liveOptions(group: OptionGroup) {
  return group.options.filter((o) => o.isAvailable !== false);
}

function itemPrice(item: MenuItem, sel: Record<string, string>) {
  let p = item.customerPrice ?? item.basePrice;
  for (const g of item.optionGroups ?? []) {
    const opt = g.options.find((o) => o.id === sel[g.id]);
    if (opt) p += Number(opt.additionalPrice || 0);
  }
  return p;
}

export default function VendorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const session = useCustomerSession();
  // [Q7b] Cached per store, so going back to it is instant; refreshed in the
  // background. A menu is the same for everyone who opens it.
  // [W2] The server drew this menu into the page (layout.tsx); it is the
  // first answer, re-read here once it is a few seconds old.
  const seed = useStoreSeed(id);
  const store = useQuery<VendorDetail>({ queryKey: vendorDetailKey(id), queryFn: () => getVendor(id), ...fromPage(seed) });
  const v = store.data ?? null;
  const [modal, setModal] = useState<MenuItem | null>(null);
  const [sel, setSel] = useState<Record<string, string>>({});
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [section, setSection] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // Back sits over the store's photo once the store is drawn; while it loads
  // or fails, the shell's own Back row stays.
  useOwnBackButton(v !== null);
  // [WEB-REDESIGN] The cart bar shows the account's real cart — the count and
  // subtotal the server holds — not a tally of this visit's taps.
  const signedIn = session.status === 'signed-in';
  const cart = useQuery({ queryKey: customerCartKey(session.scope, session.epoch), queryFn: readShellCart, enabled: signedIn, staleTime: 30_000, retry: false });
  const cartCount = signedIn ? cartItemCount(cart.data) : 0;
  const cartSubtotal = parseAmount(cart.data?.subtotalCustomer);
  // The heart is the account's favourites list — the SAME query Account's
  // Favourites page reads and refreshes (one key, never cached as fresh), so a
  // change made there is the state shown here.
  const favourites = useAccountQuery('favourites', accountApi.favourites);
  const saved = Boolean(favourites.data?.some((f) => f.id === id));
  const [savingFav, setSavingFav] = useState(false);
  // Service booking (fulfillment=APPOINTMENT)
  const [book, setBook] = useState<MenuItem | null>(null);
  const [bday, setBday] = useState(() => appointmentDayKey(new Date()));
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState<string | null>(null);

  useEffect(() => {
    if (!book) return;
    setSlots(null); setSlot(null);
    getItemSlots(book.id, bday).then((r) => setSlots(r.slots ?? [])).catch(() => setSlots([]));
  }, [book, bday]);

  // Open the item the link asked for, once the menu is here — once per visit.
  const openedRequested = useRef(false);
  useEffect(() => {
    if (!v || openedRequested.current) return;
    openedRequested.current = true;
    const wanted = requestedItemId();
    const item = wanted ? v.categories.flatMap((category) => category.items).find((candidate) => candidate.id === wanted) : undefined;
    if (item) openItem(item);
    // openItem reads only the item it is given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);

  /**
   * [Q7b] A guest browses freely and signs in to order — the phone app's rule
   * (its cart lives on the account). Signing in brings them straight back to
   * this item. An expired access cookie is renewed first, so a returning
   * customer is never sent to sign in again for nothing.
   */
  async function signedInToOrder(item: MenuItem): Promise<boolean> {
    if (await session.ensureSignedIn()) return true;
    router.push(signInPath(`/order/vendor/${encodeURIComponent(id)}?item=${encodeURIComponent(item.id)}`));
    return false;
  }

  async function confirmBook() {
    if (!book || !v || !slot) return;
    setBusy(true);
    try {
      if (!(await signedInToOrder(book))) return;
      await addToCart({ vendorId: v.id, itemId: book.id, quantity: 1 });
      savePendingAppointment({ itemId: book.id, slotStart: slot, label: `${book.name} — ${formatAppointmentSlot(slot)}` });
      setBook(null); setToast('Booking added to your cart');
      void queryClient.invalidateQueries({ queryKey: ['customer', 'cart'] });
      setTimeout(() => setToast(null), 2500);
    } catch (e: any) { setToast(e.message || 'Could not book'); }
    finally { setBusy(false); }
  }

  function openItem(item: MenuItem) {
    if (!item.isAvailable) return;
    if (item.fulfillment === 'APPOINTMENT') { setBday(appointmentDayKey(new Date())); setBook(item); return; }
    // A required group starts on the store's default only while it is on
    // sale; a sold-out default is never chosen for the customer, and neither
    // is some other choice they did not pick: the group waits for them.
    const defaults: Record<string, string> = {};
    for (const g of item.optionGroups ?? []) {
      const d = liveOptions(g).find((o) => o.isDefault);
      if (g.isRequired && d) defaults[g.id] = d.id;
    }
    setSel(defaults); setQty(1); setModal(item);
  }

  async function confirmAdd() {
    if (!modal || !v) return;
    // Only choices still on sale in this menu are sent.
    const chosen: Record<string, string> = {};
    for (const g of modal.optionGroups ?? []) {
      const pick = liveOptions(g).find((o) => o.id === sel[g.id]);
      if (pick) chosen[g.id] = pick.id;
      else if (g.isRequired) {
        setToast(liveOptions(g).length ? `Choose an option for “${g.name}”.` : `“${g.name}” is sold out right now.`);
        return;
      }
    }
    setBusy(true);
    try {
      if (!(await signedInToOrder(modal))) return;
      await addToCart({ vendorId: v.id, itemId: modal.id, quantity: qty, selectedOptions: chosen });
      setModal(null); setToast('Added to your cart');
      void queryClient.invalidateQueries({ queryKey: ['customer', 'cart'] });
      setTimeout(() => setToast(null), 2500);
    } catch (e: any) { setToast(e.message || 'Could not add item'); }
    finally { setBusy(false); }
  }

  async function toggleFavourite() {
    if (!v || savingFav) return;
    if (!(await session.ensureSignedIn())) { router.push(signInPath(`/order/vendor/${encodeURIComponent(id)}`)); return; }
    // What the person asked for is the opposite of the heart they see. The
    // write is chosen from the server's list read NOW, never from a cached one:
    // a stale "saved" would send a removal for a store they meant to save.
    const wantSaved = !saved;
    setSavingFav(true);
    try {
      const fresh = await favourites.refetch();
      if (fresh.isError || !fresh.data) throw new Error('Could not check your favourites. Try again.');
      const isSaved = fresh.data.some((f) => f.id === v.id);
      if (isSaved !== wantSaved) {
        await accountApi.favourite(v.id, isSaved);
        await queryClient.invalidateQueries({ queryKey: ['account'] });
      }
      flash(wantSaved ? 'Saved to favourites' : 'Removed from favourites');
    } catch (e: any) { flash(e.message || 'Could not update your favourites'); }
    finally { setSavingFav(false); }
  }

  async function shareStore() {
    if (!v) return;
    const url = `${window.location.origin}/order/vendor/${encodeURIComponent(v.id)}`;
    try {
      if (navigator.share) { await navigator.share({ title: v.name, url }); return; }
      await navigator.clipboard.writeText(url);
      flash('Link copied');
    } catch { /* the person closed the share sheet */ }
  }

  function flash(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 2500);
  }

  if (!v && store.isError) return <div className="pt-2"><DataUnavailable what="this store" error={store.error} onRetry={() => void store.refetch()} /></div>;
  if (!v) return <MenuSkeleton />;

  const items = v.categories.flatMap((category) => category.items);
  const picks = items.filter((item) => item.isAvailable).slice(0, 5);
  const shown = v.categories.filter((category) => category.items.length > 0 && (!section || section === category.id));
  const minutes = v.etaMin ?? v.estimatedPrepTime;
  const deliveryFee = v.deliveryFee != null ? parseAmount(v.deliveryFee) : null;

  return (
    <div className="pb-24">
      <div className={STORE_HERO}>
        <Photo src={v.coverImageUrl} alt={v.name} vendorType={v.vendorType} sizes="(min-width: 760px) 1200px, 100vw" priority className="absolute inset-0 rounded-none" iconSize={34} />
        <span aria-hidden className="absolute inset-x-0 top-0 h-24" style={{ background: 'linear-gradient(180deg, rgba(33,26,26,0.45), rgba(33,26,26,0))' }} />
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-[170px]" style={{ background: 'linear-gradient(180deg, rgba(33,26,26,0), rgba(33,26,26,0.62))' }} />
        <div className="absolute inset-x-0 top-3 flex items-center gap-3 px-6 wide:px-10">
          <BackButton />
          <div className="flex-1" />
          <button type="button" onClick={() => void toggleFavourite()} disabled={savingFav || (signedIn && favourites.isFetching)} aria-pressed={saved} aria-label={saved ? 'Remove from favourites' : 'Save to favourites'} className="sw-icon-btn border-0 shadow-[var(--swift-elevation-card)]">
            <Heart size={20} className={saved ? 'fill-[var(--swift-red)] text-[var(--swift-red)]' : 'text-[var(--swift-muted-soft)]'} aria-hidden />
          </button>
          <button type="button" onClick={() => void shareStore()} aria-label="Share" className="sw-icon-btn"><Share2 size={20} aria-hidden /></button>
        </div>
        <div className="swift-menu-heading absolute inset-x-0 bottom-9 flex flex-col gap-2 px-6 wide:px-10">
          <h1 className="sw-title text-[var(--swift-white)]">{v.name}</h1>
          <div className="flex flex-wrap gap-2">
            {v.isCurrentlyOpen ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-white/90 px-[9px] py-[3px] text-[11px] font-bold uppercase leading-[14px] tracking-[0.6px] text-[var(--swift-success)]"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--swift-success)]" />Open</span>
            ) : (
              <span className="rounded-full bg-[var(--swift-red-600)] px-[9px] py-[3px] text-[11px] font-bold uppercase leading-[14px] tracking-[0.6px] text-[var(--swift-white)]">Closed right now</span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full bg-white/90 px-[9px] py-[3px] text-[11px] font-bold leading-[14px] text-[var(--swift-ink)]"><Star size={11} className="fill-[var(--swift-star)] text-[var(--swift-star)]" aria-hidden />{ratingText(v)}</span>
            {v.cuisineTypes?.[0] ? <span className="rounded-full bg-white/90 px-[9px] py-[3px] text-[11px] font-semibold uppercase leading-[14px] tracking-[0.6px] text-[var(--swift-ink)]">{v.cuisineTypes[0]}</span> : null}
          </div>
        </div>
      </div>

      <div className="relative -mx-6 -mt-5 rounded-t-[20px] bg-[var(--swift-canvas)] px-6 pt-6 wide:-mx-10 wide:px-10">
        <dl className="flex">
          <div className="flex flex-1 flex-col gap-1 border-r border-[var(--swift-border)] pr-2">
            <dt className="order-2 text-[13px] leading-[18px] text-[var(--swift-muted)]">{v.ratingCount > 0 ? `${v.ratingCount} rating${v.ratingCount === 1 ? '' : 's'}` : 'Rating'}</dt>
            <dd className="flex items-center gap-1 text-[13px] font-semibold leading-[18px]"><Star size={14} className="text-[var(--swift-star)]" aria-hidden />{v.displayRating === null ? 'New' : `${ratingText(v)} ${v.ratingBucket ?? ''}`.trim()}</dd>
          </div>
          {v.distanceKm != null ? (
            <div className="flex flex-1 flex-col gap-1 border-r border-[var(--swift-border)] px-2">
              <dt className="order-2 text-[13px] leading-[18px] text-[var(--swift-muted)]">Distance</dt>
              <dd className="flex items-center gap-1 text-[13px] font-semibold leading-[18px]"><MapPin size={14} className="text-[var(--swift-red)]" aria-hidden />{Number(v.distanceKm).toFixed(1)} km</dd>
            </div>
          ) : null}
          <div className="flex flex-1 flex-col gap-1 border-r border-[var(--swift-border)] px-2 last:border-r-0">
            <dt className="order-2 text-[13px] leading-[18px] text-[var(--swift-muted)]">Prep time</dt>
            <dd className="flex items-center gap-1 text-[13px] font-semibold leading-[18px]"><Clock size={14} className="text-[var(--swift-red)]" aria-hidden />~{minutes} min</dd>
          </div>
          {deliveryFee !== null ? (
            <div className="flex flex-1 flex-col gap-1 px-2">
              <dt className="order-2 text-[13px] leading-[18px] text-[var(--swift-muted)]">Delivery</dt>
              <dd className="flex items-center gap-1 text-[13px] font-semibold leading-[18px]"><Bike size={14} className="text-[var(--swift-red)]" aria-hidden />{money(deliveryFee)}</dd>
            </div>
          ) : null}
        </dl>
        {v.description ? <p className="mt-4 max-w-2xl text-[13px] leading-[18px] text-[var(--swift-muted)]">{v.description}</p> : null}
        {!v.isCurrentlyOpen ? (
          <p className="sw-note mt-5"><Info size={16} className="mt-px flex-none" aria-hidden />Closed right now — browse the menu; ordering opens with the store.</p>
        ) : null}

        {picks.length > 1 ? (
          <section aria-labelledby="picks-title" className="mt-8">
            <h2 id="picks-title" className="sw-heading">From the menu</h2>
            <ul className="sw-bleed sw-rail-scroll auto-cols-[200px] pt-4">
              {picks.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => openItem(item)} className="flex w-[200px] cursor-pointer flex-col border-0 bg-transparent p-0 text-left text-[var(--swift-ink)] active:opacity-85">
                    <Photo src={item.imageUrl} vendorType={v.vendorType} name={item.name} sizes="200px" className="h-[200px] w-[200px]" />
                    <span className="truncate pt-2 text-[13px] font-semibold leading-[18px]">{item.name}</span>
                    <span className="sw-money mt-1">{money(item.customerPrice ?? item.basePrice)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {v.categories.length > 1 ? (
          <nav aria-label="Menu sections" className="sw-bleed sticky top-0 z-10 mt-6 flex gap-3 overflow-x-auto bg-[var(--swift-canvas)] py-2 [scrollbar-width:none]">
            <button type="button" aria-pressed={section === null} onClick={() => setSection(null)} className="sw-chip">Full menu</button>
            {v.categories.filter((category) => category.items.length > 0).map((category) => (
              <button key={category.id} type="button" aria-pressed={section === category.id} onClick={() => setSection(category.id)} className="sw-chip">{category.name}</button>
            ))}
          </nav>
        ) : null}

        <div className="grid grid-cols-1 items-start gap-x-6 wide:grid-cols-2">
          {shown.map((cat) => (
            <section key={cat.id} aria-labelledby={`menu-${cat.id}`}>
              <h2 id={`menu-${cat.id}`} className="sw-heading mt-6">{cat.name}</h2>
              <div className="sw-panel mt-3 px-4">
                {cat.items.map((it) => (
                  <button key={it.id} type="button" onClick={() => openItem(it)} disabled={!it.isAvailable}
                    className="swift-menu-item flex w-full cursor-pointer gap-3 border-0 border-b border-[var(--swift-border)] bg-transparent py-4 text-left text-[var(--swift-ink)] last:border-b-0 active:opacity-85 disabled:cursor-not-allowed disabled:opacity-50">
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[17px] font-semibold leading-6">{it.name}</span>
                      {it.description ? <span className="line-clamp-2 text-[13px] leading-[18px] text-[var(--swift-muted)]">{it.description}</span> : null}
                      {photo(it.imageUrl) ? <span className="relative mt-2 block h-16 w-16 overflow-hidden rounded-xl"><Image {...photo(it.imageUrl)!} alt="" fill sizes="64px" loading="lazy" className="object-cover" /></span> : null}
                    </span>
                    <span className="flex flex-col items-end justify-between gap-2">
                      <span className="sw-money text-[var(--swift-red)]">{money(it.customerPrice ?? it.basePrice)}</span>
                      {it.isAvailable ? (
                        <span aria-hidden className="grid h-8 w-8 place-items-center rounded-full bg-[var(--swift-red)] text-[var(--swift-white)]"><Plus size={16} /></span>
                      ) : (
                        <span className="sw-eyebrow text-[var(--swift-warning)]">Sold out</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      {/* Above the app's dock on phones (--swift-dock), above the home bar
          from 760 px up. */}
      {cartCount > 0 && !modal && !book ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--swift-dock,0px)_+_16px)] z-30 flex justify-center px-6 wide:left-[280px]">
          <Link href="/cart" className="pointer-events-auto flex h-[52px] w-full max-w-[520px] items-center justify-between rounded-full bg-[var(--swift-red)] px-5 text-[15px] font-bold leading-[22px] text-[var(--swift-white)] shadow-[var(--swift-elevation-floating)] active:scale-[0.98]">
            <span>View cart</span>
            <span className="flex items-center gap-1">{cartCount} item{cartCount === 1 ? '' : 's'}{cartSubtotal !== null ? <> · <span className="sw-money">{money(cartSubtotal)}</span></> : null}</span>
          </Link>
        </div>
      ) : null}

      {modal && (
        <Modal label={modal.name} onClose={() => setModal(null)}>
            <div className="relative">
              <Photo src={modal.imageUrl} vendorType={v.vendorType} name={modal.name} sizes="480px" className="aspect-[4/3] max-h-[300px] w-full rounded-none" iconSize={40} />
              <button type="button" onClick={() => setModal(null)} aria-label="Close" data-modal-initial-focus className="sw-icon-btn absolute right-3 top-3"><X size={20} aria-hidden /></button>
            </div>
            <div className="flex flex-col gap-4 px-6 pb-6 pt-5">
              <div>
                <h3 className="sw-title">{modal.name}</h3>
                {modal.description ? <p className="mt-1 text-[15px] leading-[22px] text-[var(--swift-muted)]">{modal.description}</p> : null}
                <p className="sw-money-lg mt-2">{money(itemPrice(modal, sel))}</p>
                <p className="mt-0.5 text-[13px] leading-[18px] text-[var(--swift-muted)]">{v.name}</p>
              </div>
              {(modal.optionGroups ?? []).map((g) => (
                <fieldset key={g.id}>
                  <legend className="sw-heading">{g.name} {g.isRequired ? <span className="text-[13px] font-semibold text-[var(--swift-red)]">Required</span> : null}</legend>
                  {liveOptions(g).map((o) => (
                    <label key={o.id} className="flex min-h-14 cursor-pointer items-center gap-3 border-b border-[var(--swift-border)] py-2">
                      <input type="radio" name={g.id} checked={sel[g.id] === o.id} onChange={() => setSel((cur) => ({ ...cur, [g.id]: o.id }))} className="h-5 w-5 accent-[var(--swift-red)]" />
                      <span className="flex-1 text-[15px] font-semibold leading-5">{o.name}</span>
                      <span className="text-[13px] leading-[18px] text-[var(--swift-muted)]">{Number(o.additionalPrice) > 0 ? `+${money(Number(o.additionalPrice))}` : 'Included'}</span>
                    </label>
                  ))}
                </fieldset>
              ))}
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-3">
                  <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Decrease quantity" className="sw-icon-btn border-[var(--swift-border-strong)]"><Minus size={16} aria-hidden /></button>
                  <span className="min-w-5 text-center text-[15px] font-semibold leading-[22px]" aria-live="polite">{qty}</span>
                  <button type="button" onClick={() => setQty((q) => q + 1)} aria-label="Increase quantity" className="sw-icon-btn border-[var(--swift-border-strong)]"><Plus size={18} aria-hidden /></button>
                </span>
                <button type="button" onClick={confirmAdd} disabled={busy} className="sw-btn flex-1">
                  {busy ? 'Adding…' : `${session.status === 'guest' ? 'Sign in to add' : 'Add'} · ${money(itemPrice(modal, sel) * qty)}`}
                </button>
              </div>
            </div>
        </Modal>
      )}

      {book && (
        <Modal label={`Book ${book.name}`} onClose={() => setBook(null)} className="px-6 pb-6 pt-5">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <h3 className="sw-title">Book {book.name}</h3>
                <p className="sw-money-lg mt-1">{money(book.customerPrice ?? book.basePrice)}</p>
              </div>
              <button type="button" onClick={() => setBook(null)} aria-label="Close" data-modal-initial-focus className="sw-icon-btn"><X size={20} aria-hidden /></button>
            </div>
            <p className="sw-heading mt-5">Pick a day</p>
            <div className="sw-chip-row mt-2 pb-1">
              {nextDays(7).map((d) => (
                <button key={d.key} type="button" aria-pressed={bday === d.key} onClick={() => setBday(d.key)} className="sw-chip">{d.label}</button>
              ))}
            </div>
            <p className="sw-heading mt-5">Pick a time</p>
            {slots === null ? <p className="sw-caption mt-2">Loading times…</p>
              : slots.length === 0 ? <p className="sw-caption mt-2">No times available on this day — try another.</p>
              : <div className="mt-2 grid grid-cols-3 gap-2">
                  {slots.map((slotStart) => <button key={slotStart} type="button" aria-pressed={slot === slotStart} onClick={() => setSlot(slotStart)} className="sw-chip w-full">{formatAppointmentClock(slotStart)}</button>)}
                </div>}
            <button type="button" onClick={confirmBook} disabled={busy || !slot} className="sw-btn sw-btn-block mt-6">{busy ? 'Booking…' : !slot ? 'Choose a time' : session.status === 'guest' ? 'Sign in to book' : 'Add booking to cart'}</button>
        </Modal>
      )}

      {toast && <div role="status" className="sw-toast">{toast}</div>}
    </div>
  );
}
