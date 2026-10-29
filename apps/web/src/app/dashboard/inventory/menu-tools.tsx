'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { Modal } from '@/components/modal';
import { storeKey } from '@/lib/store-scope';
import Image from 'next/image';
import { photo as storePhoto } from '@/lib/media';
import { GRA_VAT_URL } from '@/lib/gra-vat-url';
import type { CatalogItem, VatClass } from '@/lib/vendor-api';
import {
  addOption, addOptionGroup, createItem, createSection, deleteItem, deleteOption, deleteOptionGroup, deleteSection,
  refusalWords, renameSection, saveItem, sizedPhoto, uploadItemPhoto,
  type BulkWord, type ItemBody, type MenuItem, type OptionGroupRow, type Section,
} from '@/lib/menu-api';
import { vatClassWords } from './vat-class-words';
import { adjustStock } from '@/lib/stock-adjust';
// The app's own words for the store's pick tick (a plain file, imported as is).
import { STORE_PICK } from '../../../../../mobile/src/lib/storePick';
import { SOLD_IN_STORE } from '../../../../../mobile/src/lib/inStoreSale';
// [BOOK-S5b · owner A4/C2] A bookable service's hours per day, gap, notice and "Confirm bookings automatically":
// the partner app's own rules (#2196), imported as is (a plain file with no imports).
import {
  BUFFER_CHOICES, NOTICE_CHOICES, choicesWith, minutesLabel, nextWindow, openingBookingSettings,
  slotsFromWeekHours, weekHoursFromSlots, weekHoursProblem, type WeekHours,
} from '../../../../../mobile/src/lib/bookingHours';
// [IN-STORE-SALE] A tracked row's "Sold in store −1" (drawn from this chunk, like the row's other tools).
export { SaleStock } from './sold-in-store';

// [TAP-AUDIT 27 Oct · owner rule 11 Oct: the website copies the app] The Products page's item editor and section
// tools, copied from the phone (VendorItemEditorScreen, VendorMenuScreen's section header and delete asks): the same
// fields, words, order and server calls. Before this the web said "Photos, descriptions, options and new single items
// are managed in the Swift app". This file is its own chunk: the page fetches it in the background at mount, so the
// first load does not carry it and a tap finds it here.

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const BULK_WORDS: Record<BulkWord, string> = {
  normal: 'Fits in a delivery bag with room to spare.',
  bulky: 'Like a crate of drinks or a large box.',
  very_bulky: 'Like a 20 kg bag of rice or a case of water. Only riders with a bigger vehicle will be offered it.',
};
/** The app's section-name hints by store type (apps/mobile/src/modules/vendor/shared.tsx CATALOGUE_META). */
const SECTION_HINT: Record<string, string> = {
  RESTAURANT: 'e.g. Mains, Drinks',
  SUPERMARKET: 'e.g. Produce, Dairy, Household',
  STORE: 'e.g. Apparel, Accessories',
  SERVICE: 'e.g. Haircuts, Nails, Spa',
};

type Keys = { items: QueryKey; itemsAll: QueryKey; sections: QueryKey };
const keysFor = (storeId: string | null): Keys => ({
  items: storeKey(storeId, 'items'), itemsAll: storeKey(storeId, 'items', 'all'), sections: storeKey(storeId, 'categories'),
});
/** A wire price (a Decimal string) as the number the list read makes it (lib/vendor-api toAmount), or null. Kept here so
 *  this chunk does not import the list module (that would move shared code into every dashboard page's first load). */
const price = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** The server's answer for one item, written into the list on screen (price made a number as the list read makes it). */
function writeItem(qc: QueryClient, keys: Keys, answer: MenuItem) {
  const row = { ...answer, basePrice: price(answer.basePrice) } as CatalogItem;
  qc.setQueryData<CatalogItem[]>(keys.itemsAll, (rows) => {
    if (!rows) return rows;
    return rows.some((r) => r.id === row.id) ? rows.map((r) => (r.id === row.id ? { ...r, ...row } : r)) : [...rows, row];
  });
}
/** Then the one re-read that settles everything else (orders counts, the sections' item counts). */
function reread(qc: QueryClient, keys: Keys) {
  void qc.invalidateQueries({ queryKey: keys.items });
  void qc.invalidateQueries({ queryKey: keys.sections });
}

// ── Parts of a row drawn from this chunk (the page's first load does not carry them) ─────────────────────────

/** The item's photo: a 96 px copy through the store-photo route. [REVIEW-G #2142 S4-3] Only a photo Swift keeps, as
 *  the editor and the app draw it: an outside address saved before photos were uploaded draws nothing. */
export function Thumb({ url, fallback = null }: { url: string; fallback?: ReactNode }) {
  const shot = storePhoto(url);
  const src = shot?.loader ? shot.loader({ src: shot.src, width: 96 }) : null;
  // eslint-disable-next-line @next/next/no-img-element -- a 96 px copy from the store-photo route; next/image is not in the page's first load
  return src ? <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" /> : <>{fallback}</>;
}

/** [REVIEW-F #2142 S4-1] The app's words (VendorMenuScreen OUTSIDE_PHOTO_NOTE) for a photo address saved before photos
 *  were uploaded: Swift does not draw it for customers, so the owner is told what to do. */
export const OUTSIDE_PHOTO_NOTE = "Its old photo link isn't shown to customers. Upload the photo again.";

/** The note under a row or in the editor, only for an outside address (a photo Swift keeps, or none, says nothing). */
export function PhotoNote({ url }: { url: string | null | undefined }) {
  return url && !storePhoto(url)?.loader ? <p className="sw-caption font-semibold text-amber-700">{OUTSIDE_PHOTO_NOTE}</p> : null;
}

/** [STORE-VAT · owner O-5] The owner of a VAT-registered store gives each item its VAT class. */
export function VatSelect({ item, vatRate, vatEffective, pending, onVatClass }: { item: CatalogItem; vatRate: number; vatEffective: boolean; pending: boolean; onVatClass: (_id: string, _vatClass: VatClass) => void }) {
  return (
    <select
      aria-label={`VAT class: ${item.name}`}
      value={item.vatClass ?? 'STANDARD'}
      disabled={pending}
      onChange={(e) => onVatClass(item.id, e.target.value as VatClass)}
      className="min-h-8 rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-2 text-[13px]"
    >
      {vatClassWords(vatRate, vatEffective).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
    </select>
  );
}

export function VatNote() {
  return (
    <p className="text-sm text-[var(--swift-muted)]">
      You choose each item&apos;s VAT class, and you are responsible for it. Most goods are standard-rated; some basic
      foods and household goods are zero-rated, and some supplies are exempt. Check with the{' '}
      <a href={GRA_VAT_URL} target="_blank" rel="noreferrer" className="font-semibold text-[var(--swift-red)]">GRA</a>.
    </p>
  );
}

// ── A row's price box and stock adjuster (moved here from the page: shown only on the row that opens them) ───

type AdjustReason = 'RECEIVED' | 'DAMAGED' | 'MANUAL' | 'RECONCILE' | 'RETURN';

export function StockAdjust({ item, onDone }: { item: CatalogItem; onDone: () => void }) {
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState<AdjustReason>('RECEIVED');
  const [error, setError] = useState<string | null>(null);
  // [MASTER-025] One key per adjustment as entered: retrying the same entry
  // after a failure cannot move stock twice; changing it is a new adjustment.
  const [commandKey, setCommandKey] = useState(() => crypto.randomUUID());
  const mut = useMutation({
    mutationFn: () => adjustStock(item.id, delta, reason, commandKey),
    onSuccess: () => { setCommandKey(crypto.randomUUID()); onDone(); },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--swift-subtle)] p-3">
      <span className="text-sm font-semibold">{item.name}</span>
      <input
        type="number"
        value={delta || ''}
        onChange={(e) => { setDelta(Number(e.target.value)); setCommandKey(crypto.randomUUID()); }}
        placeholder="+/- qty"
        className="w-24 rounded-lg border border-[var(--swift-border)] px-2 py-1.5 text-sm"
      />
      <select
        value={reason}
        onChange={(e) => { setReason(e.target.value as AdjustReason); setCommandKey(crypto.randomUUID()); }}
        className="rounded-lg border border-[var(--swift-border)] px-2 py-1.5 text-sm"
      >
        <option value="RECEIVED">Received stock</option>
        <option value="DAMAGED">Damaged</option>
        <option value="MANUAL">Manual correction</option>
        <option value="RECONCILE">Count reconcile</option>
        <option value="RETURN">Customer return</option>
      </select>
      <button
        onClick={() => mut.mutate()}
        disabled={mut.isPending || delta === 0}
        className="rounded-lg bg-[var(--swift-red)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
      >
        Apply
      </button>
      <button onClick={onDone} className="text-sm text-[var(--swift-muted)]">Cancel</button>
      {error && <span className="text-sm text-[var(--swift-red)]">{error}</span>}
    </div>
  );
}

export function PriceEdit({ item, onSave, onDone }: { item: CatalogItem; onSave: (_price: number) => void; onDone: () => void }) {
  // `basePrice` is null when the server did not send a usable price: start the
  // editor EMPTY rather than seeding it with the string "null" (or a 0 the
  // vendor might save over their real price).
  const [price, setPrice] = useState(item.basePrice == null ? '' : String(item.basePrice));
  // [TAP-AUDIT] The new price shows on the row at the tap; the page sends it (and puts the old one back if the
  // server refuses, saying why).
  const save = () => { if (Number(price) > 0) { onSave(Number(price)); onDone(); } };
  return (
    <span className="flex items-center gap-1">
      <input
        type="number"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        autoFocus
        aria-label={`Price: ${item.name}`}
        className="w-24 rounded-lg border border-[var(--swift-red)] px-2 py-1 text-sm"
      />
      <button onClick={save} disabled={!(Number(price) > 0)} className="text-xs font-bold text-[var(--swift-red)]">
        Save
      </button>
      <button onClick={onDone} className="text-xs text-[var(--swift-muted)]">✕</button>
    </span>
  );
}

// ── Item editor ──────────────────────────────────────────────────────────────

type DraftGroup = { key: string; name: string; isRequired: boolean; maxSelect: number; options: Array<{ key: string; name: string; additionalPrice: number }> };
let draftKeys = 0;
const nextKey = () => `draft-${++draftKeys}`;

export function ItemEditor({
  storeId, item, sections, vendorType, instantAvailable = false, vatRate, vatEffective, onClose,
}: {
  storeId: string | null;
  /** The item to edit (a GET /items row), or null for a new item. */
  item: MenuItem | null;
  sections: Array<{ id: string; name: string }>;
  vendorType: string | undefined;
  /** [BOOK-S5b] The profile's word that "Confirm bookings automatically" can be chosen (INSTANT_BOOKING on). */
  instantAvailable?: boolean;
  /** Set only for the owner of a store that told Swift it is VAT-registered. */
  vatRate: number | null;
  vatEffective: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const keys = keysFor(storeId);
  const isService = vendorType === 'SERVICE';
  const booking = item?.bookingConfig ?? {};
  const [name, setName] = useState(item?.name ?? '');
  const [price, setPrice] = useState(item?.basePrice == null ? '' : String(item.basePrice));
  const [description, setDescription] = useState(item?.description ?? '');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? item?.category?.id ?? sections[0]?.id ?? '');
  const [available, setAvailable] = useState(item ? item.isAvailable !== false : true);
  const [popular, setPopular] = useState(!!item?.isPopular);
  const [sku, setSku] = useState(item?.sku ?? '');
  const [unit, setUnit] = useState(item?.unit ?? '');
  const [bulk, setBulk] = useState<BulkWord>(item?.bulk ?? 'normal');
  const [stock, setStock] = useState(item?.stockQuantity != null ? String(item.stockQuantity) : '');
  const [lowStock, setLowStock] = useState(item?.lowStockThreshold != null ? String(item.lowStockThreshold) : '');
  const [vatClass, setVatClass] = useState<VatClass>(item?.vatClass ?? 'STANDARD');
  const [duration, setDuration] = useState<number>(booking.durationMinutes ?? 30);
  // [BOOK-S5b · as #2196] Hours per day, more than one window a day (a break is the gap between two). Every stored
  // window is kept: this editor used to put the first window's times on every chosen day when it saved.
  const [week, setWeek] = useState<WeekHours>(() => weekHoursFromSlots(booking.slots));
  // [BOOK-S5b · owner A4/C2] The gap after each booking, the minimum notice and "Confirm bookings automatically".
  // null = not touched: the opening value follows the server (the profile's word can arrive after the editor opens).
  const offerInstant = isService && instantAvailable;
  const opening = openingBookingSettings(item?.bookingConfig ?? null, offerInstant);
  const [instantTouched, setInstant] = useState<boolean | null>(null);
  const [bufferTouched, setBuffer] = useState<number | null>(null);
  const [noticeTouched, setNoticeMinutes] = useState<number | null>(null);
  const instant = instantTouched ?? opening.instantBooking;
  const buffer = bufferTouched ?? opening.bufferMinutes;
  const minNotice = noticeTouched ?? opening.minNoticeMinutes;
  const hoursProblem = isService ? weekHoursProblem(week) : null;
  const setDayWindows = (day: number, update: (_windows: WeekHours[number]) => WeekHours[number]) =>
    setWeek((w) => w.map((windows, d) => (d === day ? update(windows) : windows)));
  const [mode, setMode] = useState<'AT_BUSINESS' | 'MOBILE' | 'BOTH'>(booking.serviceMode ?? 'AT_BUSINESS');
  const [radiusKm, setRadiusKm] = useState(booking.serviceRadiusKm != null ? String(booking.serviceRadiusKm) : '5');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [draftGroups, setDraftGroups] = useState<DraftGroup[]>([]);
  const [discardAsk, setDiscardAsk] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview); }, [photoPreview]);

  // [UI-SWEEP U67, as the app] A change is a difference from how the editor opened; closing with one asks first.
  const formNow = JSON.stringify([name, price, description, categoryId, available, popular, sku, unit, bulk, stock, lowStock, vatClass,
    duration, week, instantTouched, bufferTouched, noticeTouched, mode, radiusKm, draftGroups.map((g) => [g.name, g.isRequired, g.maxSelect, g.options])]);
  const [formAtOpen] = useState(formNow);
  const unsaved = formNow !== formAtOpen || photo !== null;
  const tryClose = () => (unsaved ? setDiscardAsk(true) : onClose());

  const priceNum = Number(price);
  const valid = name.trim().length >= 1 && price.trim() !== '' && Number.isFinite(priceNum) && priceNum >= 0 && !!categoryId && (!isService || hoursProblem == null);
  const label = !name.trim() ? 'Name the item first'
    : !(price.trim() !== '' && Number.isFinite(priceNum) && priceNum >= 0) ? 'Set a price'
      : !categoryId ? 'Pick a category'
        : isService && hoursProblem ? 'Fix the hours'
          : item ? 'Save changes' : 'Add item';

  const save = useMutation({
    mutationFn: async () => {
      const stockNum = stock.trim() === '' ? undefined : Number(stock);
      const body: ItemBody = {
        categoryId,
        name: name.trim(),
        description: description.trim() || undefined,
        basePrice: priceNum,
        isAvailable: available,
        isPopular: popular,
        ...(isService
          ? {
              fulfillment: 'APPOINTMENT',
              bookingConfig: {
                durationMinutes: duration,
                slots: slotsFromWeekHours(week),
                bufferMinutes: buffer,
                minNoticeMinutes: minNotice,
                // [BOOK-S5b] Sent only while the server says it can be chosen; otherwise the listing keeps what it stores.
                ...(offerInstant ? { instantBooking: instant } : {}),
                serviceMode: mode,
                ...(mode !== 'AT_BUSINESS' ? { serviceRadiusKm: Number(radiusKm) || 0 } : {}),
              },
            }
          : {
              sku: sku.trim() || undefined,
              unit: unit.trim() || undefined,
              bulk,
              ...(vatRate != null ? { vatClass } : {}),
              stockQuantity: stock.trim() === '' ? null : Number.isFinite(stockNum as number) ? stockNum : undefined,
              lowStockThreshold: lowStock.trim() === '' ? null : Number(lowStock) >= 0 ? Number(lowStock) : undefined,
              // A new item's groups and choices go with it, in the one request (as the app sends them).
              ...(!item && draftGroups.length > 0 ? {
                optionGroups: draftGroups.map((g) => ({
                  name: g.name, isRequired: g.isRequired, minSelect: g.isRequired ? 1 : 0, maxSelect: g.maxSelect,
                  options: g.options.map((o) => ({ name: o.name, additionalPrice: o.additionalPrice })),
                })),
              } : {}),
            }),
      };
      const saved = item ? await saveItem(item.id, body) : await createItem(body);
      writeItem(qc, keys, saved);
      if (photo && saved?.id) {
        // The item is saved; a failed photo must not lose it, but the store must KNOW (as the app says).
        try {
          const sized = await sizedPhoto(photo);
          const answer = await uploadItemPhoto(saved.id, sized.blob, sized.name);
          writeItem(qc, keys, { ...saved, imageUrl: answer.imageUrl });
        } catch {
          return { photoFailed: true };
        }
      }
      return { photoFailed: false };
    },
    onSuccess: ({ photoFailed }) => {
      reread(qc, keys);
      if (photoFailed) setNotice("Item saved, but the photo didn't upload — open the item and add it again.");
      else onClose();
    },
  });

  // [REVIEW-F #2142 S4-4] Only a preview made here from the chosen file, or a photo Swift keeps (the store-photo route,
  // as the row and the app draw it); an outside address saved before photos were uploaded is not drawn.
  const kept = storePhoto(item?.imageUrl ?? null);
  const keptPhoto = kept?.loader ? kept : null;
  const hasPhoto = !!photoPreview || !!keptPhoto;
  // The file just chosen is a local blob: nothing for the image optimiser to resize (the store's photo goes through it).
  const previewIsLocal = !!photoPreview && photoPreview.startsWith('blob:');
  const pickPhoto = (file: File | undefined) => {
    if (!file) return;
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhoto(file);
    setPhotoPreview(typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null);
  };

  return (
    <Modal labelledBy="item-editor-title" onClose={tryClose} className="max-h-[92vh] w-full max-w-xl overflow-y-auto bg-[var(--swift-card)] px-6 pb-6 pt-5">
      <h2 id="item-editor-title" className="sw-title">{item ? 'Edit Item' : 'New Item'}</h2>

      <div className="mt-4 flex items-center gap-4">
        <div className="grid h-24 w-24 flex-none place-items-center overflow-hidden rounded-xl bg-[var(--swift-sunken)]">
          {photoPreview
            ? <Image src={photoPreview} alt={`${name || 'Item'} photo`} width={96} height={96} unoptimized={previewIsLocal} className="h-full w-full object-cover" />
            : keptPhoto
              ? <Image {...keptPhoto} alt={`${name || 'Item'} photo`} width={96} height={96} className="h-full w-full object-cover" />
              : <span className="text-xs text-[var(--swift-muted)]">No photo</span>}
        </div>
        <div className="min-w-0">
          <label className="sw-btn-outline inline-flex min-h-11 cursor-pointer items-center rounded-lg px-4 text-sm font-semibold">
            {hasPhoto ? 'Change photo' : 'Add a photo'}
            <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Item photo" onChange={(e) => pickPhoto(e.target.files?.[0])} />
          </label>
          {photo ? <button type="button" className="ml-3 text-sm font-semibold text-[var(--swift-muted)]" onClick={() => { setPhoto(null); setPhotoPreview(null); }}>Remove selected photo</button> : null}
          <p className="sw-caption mt-1">Bright and straight-on — customers choose with their eyes</p>
          {photoPreview ? null : <PhotoNote url={item?.imageUrl} />}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <input className="sw-input" aria-label="Item name" placeholder="Item name" value={name} onChange={(e) => setName(e.target.value)} data-modal-initial-focus />
        <input className="sw-input" aria-label="Price (GYD)" placeholder="Price (GYD)" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        <textarea className="sw-input min-h-20" aria-label="Description (optional)" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      {isService ? (
        <div className="mt-5 rounded-xl border border-[var(--swift-border)] p-4">
          <h3 className="font-bold">Appointment booking</h3>
          <p className="sw-field-label mt-3">Appointment length</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {[15, 30, 45, 60, 90, 120].map((m) => <Chip key={m} label={`${m} min`} on={duration === m} onClick={() => setDuration(m)} />)}
          </div>
          {/* [BOOK-S5b · as #2196] Hours per day. A day with no hours is closed; a break is the gap between two windows. */}
          <p className="sw-field-label mt-3">Hours each day</p>
          <div className="mt-1 space-y-2">
            {DAY_LABELS.map((label, d) => {
              const windows = week[d] ?? [];
              const open = windows.length > 0;
              return (
                <div key={label} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip label={open ? label : `${label} · closed`} on={open} onClick={() => setDayWindows(d, (w) => (w.length > 0 ? [] : [nextWindow([])]))} />
                    {open ? (
                      <button type="button" className="text-sm font-semibold text-[var(--swift-red)]" aria-label={`Add hours on ${label}`} onClick={() => setDayWindows(d, (w) => [...w, nextWindow(w)])}>Add hours</button>
                    ) : null}
                  </div>
                  {windows.map((w, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input type="time" className="sw-input" aria-label={`${label} opens at${windows.length > 1 ? ` (${i + 1})` : ''}`} value={w.start}
                        onChange={(e) => setDayWindows(d, (ws) => ws.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                      <span className="text-sm text-[var(--swift-muted)]">to</span>
                      <input type="time" className="sw-input" aria-label={`${label} closes at${windows.length > 1 ? ` (${i + 1})` : ''}`} value={w.end}
                        onChange={(e) => setDayWindows(d, (ws) => ws.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                      <button type="button" className="grid h-11 w-11 flex-none place-items-center text-[var(--swift-muted)]" aria-label={`Remove ${label} ${w.start}–${w.end}`}
                        onClick={() => setDayWindows(d, (ws) => ws.filter((_, j) => j !== i))}>×</button>
                    </div>
                  ))}
                </div>
              );
            })}
            {hoursProblem ? <p role="alert" className="text-sm text-[var(--swift-red)]">{hoursProblem}</p> : null}
          </div>
          <p className="sw-field-label mt-3">Gap after each booking</p>
          <div className="mt-1 flex flex-wrap gap-2" role="group" aria-label="Gap after each booking">
            {choicesWith(BUFFER_CHOICES, buffer).map((m) => <Chip key={m} label={minutesLabel(m)} on={buffer === m} onClick={() => setBuffer(m)} />)}
          </div>
          <p className="sw-field-label mt-3">Minimum notice</p>
          <p className="sw-caption">How close to its start a customer can still book a time.</p>
          <div className="mt-1 flex flex-wrap gap-2" role="group" aria-label="Minimum notice">
            {choicesWith(NOTICE_CHOICES, minNotice).map((m) => <Chip key={m} label={minutesLabel(m)} on={minNotice === m} onClick={() => setNoticeMinutes(m)} />)}
          </div>
          {/* [BOOK-S5b · owner A3/A4] Shown only while the server says it can be chosen. */}
          {offerInstant ? (
            <div className="mt-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p id="confirm-automatically" className="text-sm font-semibold">Confirm bookings automatically</p>
                <p className="sw-caption">
                  {instant
                    ? 'Bookings paid in cash at the appointment are confirmed as soon as the customer books. MMG bookings still wait for you to accept.'
                    : 'Every booking waits for you to accept it.'}
                </p>
              </div>
              <button type="button" role="switch" aria-labelledby="confirm-automatically" aria-checked={instant} onClick={() => setInstant(!instant)}
                className="grid h-11 w-16 flex-none place-items-center">
                <span className={`sw-stock-switch ${instant ? 'bg-[var(--swift-red)]' : 'bg-[var(--swift-border-strong)]'}`}><span className={`sw-stock-knob ${instant ? 'translate-x-5' : ''}`} /></span>
              </button>
            </div>
          ) : null}
          <p className="sw-field-label mt-3">Where does it happen?</p>
          <div className="mt-1 flex flex-wrap gap-2">
            <Chip label="At my place" on={mode === 'AT_BUSINESS'} onClick={() => setMode('AT_BUSINESS')} />
            <Chip label="I travel to them" on={mode === 'MOBILE'} onClick={() => setMode('MOBILE')} />
            <Chip label="Both" on={mode === 'BOTH'} onClick={() => setMode('BOTH')} />
          </div>
          {mode !== 'AT_BUSINESS' ? (
            <label className="mt-3 block">
              <span className="sw-field-label">How far will you travel from your store? (km)</span>
              <input className="sw-input" inputMode="numeric" value={radiusKm} onChange={(e) => setRadiusKm(e.target.value)} />
            </label>
          ) : null}
        </div>
      ) : (
        <>
          <p className="sw-field-label mt-5">Inventory (optional)</p>
          <div className="mt-1 space-y-3">
            <div className="flex gap-3">
              <input className="sw-input" aria-label="Stock qty" placeholder="Stock qty" inputMode="numeric" value={stock} onChange={(e) => setStock(e.target.value)} />
              <input className="sw-input" aria-label="Unit (kg, ea)" placeholder="Unit (kg, ea)" value={unit} onChange={(e) => setUnit(e.target.value)} />
            </div>
            <div>
              <p className="sw-field-label">How bulky is one of these to carry?</p>
              <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label="How bulky is one of these to carry?">
                {(['normal', 'bulky', 'very_bulky'] as const).map((b) => (
                  <button key={b} type="button" role="radio" aria-checked={bulk === b} className="sw-chip" onClick={() => setBulk(b)}>
                    {b === 'normal' ? 'Normal' : b === 'bulky' ? 'Bulky' : 'Very bulky'}
                  </button>
                ))}
              </div>
              <p className="sw-caption mt-1">{BULK_WORDS[bulk]}</p>
            </div>
            {vatRate != null ? (
              <label className="block">
                <span className="sw-field-label">VAT on this item</span>
                <select className="sw-input" value={vatClass} onChange={(e) => setVatClass(e.target.value as VatClass)}>
                  {vatClassWords(vatRate, vatEffective).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
                <span className="sw-caption">You choose each item’s VAT class and are responsible for it; check with the GRA.</span>
              </label>
            ) : null}
            <input className="sw-input" aria-label="SKU / barcode (optional)" placeholder="SKU / barcode (optional)" value={sku} onChange={(e) => setSku(e.target.value)} />
            <input className="sw-input" aria-label="Low-stock alert at (e.g. 5)" placeholder="Low-stock alert at (e.g. 5)" inputMode="numeric" value={lowStock} onChange={(e) => setLowStock(e.target.value)} />
            {stock.trim() !== '' ? <p className="sw-caption">Tracked items sell down automatically and hide at 0. You’ll get an alert at your low-stock level.</p>
              : <p className="sw-caption">{SOLD_IN_STORE.untracked}</p>}
          </div>
          <OptionsSection storeId={storeId} item={item} drafts={draftGroups} setDrafts={setDraftGroups} />
        </>
      )}

      <p className="sw-field-label mt-5">Category</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {sections.map((c) => <Chip key={c.id} label={c.name} on={c.id === categoryId} onClick={() => setCategoryId(c.id)} />)}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Chip label={available ? 'Available' : 'Sold out'} on={available} onClick={() => setAvailable((v) => !v)} />
        <Chip label={`★ ${STORE_PICK}`} on={popular} onClick={() => setPopular((v) => !v)} />
      </div>

      {save.isError ? (
        <p role="alert" className="mt-4 text-sm font-semibold text-[var(--swift-red)]">{refusalWords(save.error) ?? "Couldn't save. Check the details and try again."}</p>
      ) : null}
      {notice ? <p role="status" className="mt-4 text-sm font-semibold text-amber-700">{notice}</p> : null}
      <div className="mt-5 flex gap-3">
        <button type="button" className="sw-btn sw-btn-md flex-1" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : label}
        </button>
        <button type="button" className="sw-btn-outline min-h-11 rounded-lg px-4 text-sm font-semibold" onClick={notice ? onClose : tryClose}>
          {notice ? 'Done' : 'Cancel'}
        </button>
      </div>

      {discardAsk ? (
        <div role="dialog" aria-label="Discard your changes?" className="mt-4 rounded-xl border border-[var(--swift-border)] p-4">
          <p className="font-bold">Discard your changes?</p>
          <p className="sw-caption mt-1">What you changed on this item is not saved.</p>
          <div className="mt-3 flex gap-3">
            <button type="button" className="sw-btn sw-btn-md" onClick={onClose}>Discard</button>
            <button type="button" className="sw-btn-outline min-h-11 rounded-lg px-4 text-sm font-semibold" onClick={() => setDiscardAsk(false)}>Keep editing</button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function Chip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return <button type="button" className="sw-chip" aria-pressed={on} onClick={onClick}>{label}</button>;
}

/** Options & add-ons (sizes, toppings, extras). A new item keeps them here and sends them with it; an existing item's
 *  changes go one at a time, each shown from the server's answer (as the app's ModifiersSection). */
function OptionsSection({ storeId, item, drafts, setDrafts }: {
  storeId: string | null;
  item: MenuItem | null;
  drafts: DraftGroup[];
  setDrafts: (_update: (_groups: DraftGroup[]) => DraftGroup[]) => void;
}) {
  const qc = useQueryClient();
  const keys = keysFor(storeId);
  const [saved, setSaved] = useState<OptionGroupRow[]>(item?.optionGroups ?? []);
  const [groupName, setGroupName] = useState('');
  const [required, setRequired] = useState(false);
  const [multi, setMulti] = useState(false);
  const [choice, setChoice] = useState<Record<string, { name: string; price: string }>>({});
  const [removeGroupId, setRemoveGroupId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => (item
    ? saved.map((g) => ({ id: g.id, name: g.name, isRequired: g.isRequired, maxSelect: g.maxSelect, options: g.options.map((o) => ({ id: o.id, name: o.name, additionalPrice: Number(o.additionalPrice) || 0 })) }))
    : drafts.map((g) => ({ id: g.key, name: g.name, isRequired: g.isRequired, maxSelect: g.maxSelect, options: g.options.map((o) => ({ id: o.key, name: o.name, additionalPrice: o.additionalPrice })) }))), [item, saved, drafts]);
  const keepGroups = (next: OptionGroupRow[]) => {
    setSaved(next);
    if (item) qc.setQueryData<CatalogItem[]>(keys.itemsAll, (rows) => rows?.map((r) => (r.id === item.id ? { ...r, optionGroups: next } as CatalogItem : r)));
  };
  const failed = (e: unknown) => setError(refusalWords(e) ?? "That didn't save. Check your connection and try again.");

  const addGroup = useMutation({
    mutationFn: (body: { name: string; isRequired: boolean; minSelect: number; maxSelect: number }) => addOptionGroup(item!.id, body),
    onMutate: () => setError(null),
    onSuccess: (g) => { keepGroups([...saved, { ...g, options: g.options ?? [] }]); setGroupName(''); setRequired(false); setMulti(false); },
    onError: failed,
  });
  const removeGroup = useMutation({
    mutationFn: (id: string) => deleteOptionGroup(id),
    onMutate: () => setError(null),
    onSuccess: (_answer, id) => keepGroups(saved.filter((g) => g.id !== id)),
    onError: failed,
  });
  const add = useMutation({
    mutationFn: ({ groupId, name, additionalPrice }: { groupId: string; name: string; additionalPrice: number }) => addOption(groupId, { name, additionalPrice }),
    onMutate: () => setError(null),
    onSuccess: (o, { groupId }) => { keepGroups(saved.map((g) => (g.id === groupId ? { ...g, options: [...g.options, o] } : g))); setChoice((c) => ({ ...c, [groupId]: { name: '', price: '' } })); },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: ({ id }: { groupId: string; id: string }) => deleteOption(id),
    onMutate: () => setError(null),
    onSuccess: (_answer, { groupId, id }) => keepGroups(saved.map((g) => (g.id === groupId ? { ...g, options: g.options.filter((o) => o.id !== id) } : g))),
    onError: failed,
  });
  const busy = addGroup.isPending || removeGroup.isPending || add.isPending || remove.isPending;

  const submitGroup = () => {
    const name = groupName.trim();
    if (!name || busy) return;
    const body = { name, isRequired: required, minSelect: required ? 1 : 0, maxSelect: multi ? 10 : 1 };
    if (!item) {
      setDrafts((gs) => [...gs, { key: nextKey(), name, isRequired: required, maxSelect: body.maxSelect, options: [] }]);
      setGroupName(''); setRequired(false); setMulti(false);
      return;
    }
    addGroup.mutate(body);
  };
  const submitChoice = (groupId: string) => {
    const typed = choice[groupId] ?? { name: '', price: '' };
    const name = typed.name.trim();
    if (!name || busy) return;
    const additionalPrice = Number(typed.price) || 0;
    if (!item) {
      setDrafts((gs) => gs.map((g) => (g.key === groupId ? { ...g, options: [...g.options, { key: nextKey(), name, additionalPrice }] } : g)));
      setChoice((c) => ({ ...c, [groupId]: { name: '', price: '' } }));
      return;
    }
    add.mutate({ groupId, name, additionalPrice });
  };
  const removeChoice = (groupId: string, id: string) => {
    if (busy) return;
    if (!item) { setDrafts((gs) => gs.map((g) => (g.key === groupId ? { ...g, options: g.options.filter((o) => o.key !== id) } : g))); return; }
    remove.mutate({ groupId, id });
  };
  const askRemoveGroup = (id: string) => {
    if (!item) { setDrafts((gs) => gs.filter((g) => g.key !== id)); return; }
    setRemoveGroupId(id);
  };

  return (
    <section className="mt-5 rounded-xl border border-[var(--swift-border)] p-4" aria-label="Options & add-ons">
      <h3 className="font-bold">Options &amp; add-ons</h3>
      <p className="sw-caption mt-1">Sizes, toppings, extras — customers pick these when ordering.</p>
      {!item && groups.length > 0 ? <p className="sw-caption mt-1">Saved with the item when you tap Add item.</p> : null}
      {error ? <p role="alert" className="mt-2 text-sm font-semibold text-[var(--swift-red)]">{error}</p> : null}
      {groups.map((g) => (
        <div key={g.id} className="mt-3 rounded-lg bg-[var(--swift-subtle)] p-3" aria-label={`Group ${g.name}`} role="group">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{g.name}</p>
              <p className="sw-caption">{g.isRequired ? 'Required' : 'Optional'} · {g.maxSelect > 1 ? `up to ${g.maxSelect}` : 'pick one'}</p>
            </div>
            <button type="button" className="min-h-9 px-2 text-sm font-semibold text-[var(--swift-muted)]" aria-label={`Remove ${g.name}`} disabled={busy} onClick={() => askRemoveGroup(g.id)}>Remove</button>
          </div>
          {g.options.map((o) => (
            <div key={o.id} className="mt-2 flex items-center gap-2 text-sm">
              <span className="flex-1">{o.name}</span>
              <span className="text-[var(--swift-muted)]">{o.additionalPrice > 0 ? `+GYD ${o.additionalPrice.toLocaleString('en-US')}` : 'Free'}</span>
              <button type="button" className="min-h-9 px-2 text-[var(--swift-muted)]" aria-label={`Remove ${o.name}`} disabled={busy} onClick={() => removeChoice(g.id, o.id)}>✕</button>
            </div>
          ))}
          <div className="mt-2 flex items-center gap-2">
            <input className="sw-input" aria-label={`Choice for ${g.name}`} placeholder="Choice (e.g. Large)" value={choice[g.id]?.name ?? ''}
              onChange={(e) => setChoice((c) => ({ ...c, [g.id]: { name: e.target.value, price: c[g.id]?.price ?? '' } }))}
              onKeyDown={(e) => { if (e.key === 'Enter') submitChoice(g.id); }} />
            <input className="sw-input w-28" aria-label={`Extra price for ${g.name}`} placeholder="+GYD" inputMode="numeric" value={choice[g.id]?.price ?? ''}
              onChange={(e) => setChoice((c) => ({ ...c, [g.id]: { name: c[g.id]?.name ?? '', price: e.target.value } }))}
              onKeyDown={(e) => { if (e.key === 'Enter') submitChoice(g.id); }} />
            <button type="button" className="sw-btn sw-btn-sm" aria-label={`Add choice to ${g.name}`} disabled={busy || !(choice[g.id]?.name ?? '').trim()} onClick={() => submitChoice(g.id)}>+</button>
          </div>
        </div>
      ))}
      <div className="mt-3">
        <input className="sw-input" aria-label="New group (e.g. Size, Toppings)" placeholder="New group (e.g. Size, Toppings)" value={groupName} onChange={(e) => setGroupName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitGroup(); }} />
        <div className="mt-2 flex gap-2">
          <Chip label="Required" on={required} onClick={() => setRequired((v) => !v)} />
          <Chip label="Multiple picks" on={multi} onClick={() => setMulti((v) => !v)} />
        </div>
        <button type="button" className="sw-btn-outline mt-2 min-h-11 rounded-lg px-4 text-sm font-semibold" disabled={busy || !groupName.trim()} onClick={submitGroup}>
          {addGroup.isPending ? 'Adding…' : 'Add option group'}
        </button>
      </div>
      {removeGroupId ? (
        <div role="dialog" aria-label="Remove group?" className="mt-3 rounded-xl border border-[var(--swift-border)] p-4">
          <p className="font-bold">Remove group?</p>
          <p className="sw-caption mt-1">Delete this option group and all its choices.</p>
          <div className="mt-3 flex gap-3">
            <button type="button" className="sw-btn sw-btn-md" disabled={removeGroup.isPending} onClick={() => { const id = removeGroupId; setRemoveGroupId(null); removeGroup.mutate(id); }}>Delete</button>
            <button type="button" className="sw-btn-outline min-h-11 rounded-lg px-4 text-sm font-semibold" onClick={() => setRemoveGroupId(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────────

/** Add, rename or delete a section (the app's "Add section", pencil and trash on a section header). */
export function SectionDialog({ storeId, vendorType, section, itemCount, mode, onClose }: {
  storeId: string | null;
  vendorType: string | undefined;
  section: { id: string; name: string } | null;
  itemCount: number;
  mode: 'add' | 'rename' | 'delete';
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const keys = keysFor(storeId);
  const [name, setName] = useState(mode === 'rename' ? section?.name ?? '' : '');
  const write = useMutation({
    mutationFn: async () => {
      if (mode === 'delete') { await deleteSection(section!.id); return null; }
      return mode === 'add' ? createSection(name.trim()) : renameSection(section!.id, name.trim());
    },
    onSuccess: (answer: Section | null) => {
      qc.setQueryData<Section[]>(keys.sections, (rows) => {
        if (!rows) return rows;
        if (mode === 'delete') return rows.filter((r) => r.id !== section!.id);
        if (!answer) return rows;
        return rows.some((r) => r.id === answer.id) ? rows.map((r) => (r.id === answer.id ? { ...r, name: answer.name } : r)) : [...rows, { ...answer, items: [] }];
      });
      if (mode === 'delete') qc.setQueryData<CatalogItem[]>(keys.itemsAll, (rows) => rows?.filter((r) => r.category?.id !== section!.id));
      if (mode === 'rename' && answer) qc.setQueryData<CatalogItem[]>(keys.itemsAll, (rows) => rows?.map((r) => (r.category?.id === answer.id ? { ...r, category: { id: answer.id, name: answer.name } } : r)));
      reread(qc, keys);
      onClose();
    },
  });
  const failure = write.isError ? refusalWords(write.error) ?? "That didn't save. Check your connection and try again." : null;
  if (mode === 'delete' && section) {
    return (
      <Modal labelledBy="section-delete-title" onClose={onClose} className="bg-[var(--swift-card)] px-6 pb-6 pt-5">
        <h2 id="section-delete-title" className="sw-title text-center">Delete “{section.name}”?</h2>
        <p className="sw-caption mt-2 text-center">
          {itemCount > 0 ? `This removes the section AND its ${itemCount} item${itemCount === 1 ? '' : 's'} from your menu.` : 'This removes the empty section from your menu.'}
        </p>
        {failure ? <p role="alert" className="mt-2 text-center text-sm font-semibold text-[var(--swift-red)]">{failure}</p> : null}
        <button type="button" className="sw-btn sw-btn-md sw-btn-block mt-5" disabled={write.isPending} onClick={() => write.mutate()}>
          {itemCount > 0 ? `Delete section + ${itemCount} item${itemCount === 1 ? '' : 's'}` : 'Delete section'}
        </button>
        <button type="button" className="sw-btn-outline mt-3 min-h-11 w-full rounded-lg text-sm font-semibold" onClick={onClose} data-modal-initial-focus>Keep it</button>
      </Modal>
    );
  }
  return (
    <Modal labelledBy="section-name-title" onClose={onClose} className="bg-[var(--swift-card)] px-6 pb-6 pt-5">
      <h2 id="section-name-title" className="sw-title">{mode === 'add' ? 'New section' : `Rename “${section?.name ?? ''}”`}</h2>
      <input className="sw-input mt-4" aria-label="Section name" placeholder={mode === 'add' ? SECTION_HINT[vendorType ?? 'RESTAURANT'] ?? SECTION_HINT['RESTAURANT'] : 'Category name'}
        value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !write.isPending) write.mutate(); }} data-modal-initial-focus />
      {failure ? <p role="alert" className="mt-2 text-sm font-semibold text-[var(--swift-red)]">{failure}</p> : null}
      <div className="mt-4 flex gap-3">
        <button type="button" className="sw-btn sw-btn-md flex-1" disabled={!name.trim() || write.isPending} onClick={() => write.mutate()}>
          {mode === 'add' ? 'Add section' : 'Save'}
        </button>
        <button type="button" className="sw-btn-outline min-h-11 rounded-lg px-4 text-sm font-semibold" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/** "Delete item?" — the app's ask (an item is archived: off the menu for good). */
export function DeleteItemDialog({ storeId, item, onClose }: { storeId: string | null; item: { id: string; name: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const keys = keysFor(storeId);
  const del = useMutation({
    mutationFn: () => deleteItem(item.id),
    onSuccess: () => {
      qc.setQueryData<CatalogItem[]>(keys.itemsAll, (rows) => rows?.filter((r) => r.id !== item.id));
      reread(qc, keys);
      onClose();
    },
  });
  return (
    <Modal labelledBy="item-delete-title" onClose={onClose} className="bg-[var(--swift-card)] px-6 pb-6 pt-5">
      <h2 id="item-delete-title" className="sw-title text-center">Delete item?</h2>
      <p className="sw-caption mt-2 text-center">Remove &quot;{item.name}&quot; from your menu.</p>
      {del.isError ? <p role="alert" className="mt-2 text-center text-sm font-semibold text-[var(--swift-red)]">{refusalWords(del.error) ?? "That didn't go through. Try again."}</p> : null}
      <button type="button" className="sw-btn sw-btn-md sw-btn-block mt-5" disabled={del.isPending} onClick={() => del.mutate()}>Delete</button>
      <button type="button" className="sw-btn-outline mt-3 min-h-11 w-full rounded-lg text-sm font-semibold" onClick={onClose} data-modal-initial-focus>Cancel</button>
    </Modal>
  );
}

/** Which of the page's asks is open: the item editor, a section's add/rename/delete, or an item's delete. */
export type MenuDialogState =
  | { kind: 'item'; item: CatalogItem | null }
  | { kind: 'section'; mode: 'add' | 'rename' | 'delete'; section: { id: string; name: string } | null }
  | { kind: 'delete'; item: CatalogItem };

export function MenuDialog({ dialog, storeId, sections, counts, vendorType, instantAvailable, vatRate, vatEffective, onClose }: {
  dialog: MenuDialogState;
  storeId: string | null;
  sections: Array<{ id: string; name: string }>;
  counts: Map<string, number>;
  vendorType: string | undefined;
  instantAvailable?: boolean;
  vatRate: number | null;
  vatEffective: boolean;
  onClose: () => void;
}) {
  if (dialog.kind === 'item') {
    return <ItemEditor storeId={storeId} item={dialog.item} sections={sections} vendorType={vendorType} instantAvailable={instantAvailable} vatRate={vatRate} vatEffective={vatEffective} onClose={onClose} />;
  }
  if (dialog.kind === 'section') {
    return <SectionDialog storeId={storeId} vendorType={vendorType} section={dialog.section} mode={dialog.mode}
      itemCount={dialog.section ? counts.get(dialog.section.id) ?? 0 : 0} onClose={onClose} />;
  }
  return <DeleteItemDialog storeId={storeId} item={dialog.item} onClose={onClose} />;
}
