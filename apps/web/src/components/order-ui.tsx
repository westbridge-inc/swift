'use client';

import Link from 'next/link';
import Image from 'next/image';
import { ChevronRight, Star } from 'lucide-react';
import { Bone, LoadingRegion } from './customer-skeletons';
import { Pictogram, verticalPictogram } from './glyphs';
import { money, type Vendor } from '@/lib/customer';

/**
 * [WEB-REDESIGN] The store and item cards of the owner's design. Each card and
 * its loading placeholder share one set of geometry classes (the
 * `data-store-part` slots), so content lands in exactly the space its
 * placeholder held and nothing jumps as a list arrives.
 */

/** A store's rating as the phone app writes it: a figure, or "New". */
export function ratingText(v: Pick<Vendor, 'displayRating'>): string {
  return v.displayRating === null || v.displayRating === undefined ? 'New' : Number(v.displayRating).toFixed(1);
}

/** "25 min · 1.2 km", from what the server sent — nothing invented. */
export function storeMeta(v: Pick<Vendor, 'estimatedPrepTime' | 'etaMin' | 'distanceKm'>): string {
  const parts: string[] = [];
  const minutes = v.etaMin ?? v.estimatedPrepTime;
  if (minutes != null && Number.isFinite(Number(minutes))) parts.push(`${minutes} min`);
  if (v.distanceKm != null && Number.isFinite(Number(v.distanceKm))) parts.push(`${Number(v.distanceKm).toFixed(1)} km`);
  return parts.join(' · ');
}

/**
 * A photo, or — when the store has none — the design's tinted placeholder:
 * the vertical's pictogram on the soft brand tint, and optionally the name.
 */
export function Photo({
  src, alt = '', vendorType, name, sizes, priority = false, iconSize = 30, className = '', dim = false,
}: {
  src?: string | null; alt?: string; vendorType?: string | null; name?: string; sizes: string; priority?: boolean; iconSize?: number; className?: string; dim?: boolean;
}) {
  return (
    <span className={`sw-photo ${className}`} style={dim ? { opacity: 0.45 } : undefined}>
      {src ? (
        <Image src={src} alt={alt} fill unoptimized sizes={sizes} {...(priority ? { priority: true } : { loading: 'lazy' as const })} className="object-cover" />
      ) : (
        <span className="flex flex-col items-center justify-center gap-2 p-3 text-center">
          <Pictogram name={verticalPictogram(vendorType)} size={iconSize} />
          {name ? <span className="line-clamp-2 text-[11px] font-semibold uppercase leading-[14px] tracking-[0.6px] opacity-85">{name}</span> : null}
        </span>
      )}
    </span>
  );
}

function Rating({ v }: { v: Pick<Vendor, 'displayRating'> }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Star size={13} className="fill-[var(--swift-star)] text-[var(--swift-star)]" aria-hidden />
      {ratingText(v)}
    </span>
  );
}

const ROW_CARD = 'sw-card flex min-w-0 items-center gap-3 p-3 text-left text-[var(--swift-ink)]';
const ROW_THUMB = 'h-[84px] w-[84px] flex-none rounded-xl';
const ROW_COPY = 'flex min-w-0 flex-1 flex-col gap-1';
const ROW_META = 'flex flex-wrap items-center gap-1.5 text-[13px] leading-[18px] text-[var(--swift-muted)]';
/** The copy under a square card (items and stores share it). */
const SQUARE_COPY = 'flex min-w-0 flex-col gap-1 pt-2';

/** The list card ("Nearby", search, browse): photo, name, rating · time. */
export function VendorCard({ v }: { v: Vendor }) {
  const closed = !v.isCurrentlyOpen;
  const meta = storeMeta(v);
  return (
    <Link href={`/order/vendor/${v.id}`} className={`${ROW_CARD} transition-opacity active:opacity-85`}>
      <span data-store-part="image" className={`${ROW_THUMB} relative overflow-hidden`}>
        <Photo src={v.coverImageUrl} alt={v.name} vendorType={v.vendorType} sizes="84px" className="absolute inset-0 rounded-xl" dim={closed} />
      </span>
      <span data-store-part="copy" className={ROW_COPY}>
        <span className={`truncate text-[15px] font-semibold leading-[22px] ${closed ? 'text-[var(--swift-muted)]' : ''}`}>{v.name}</span>
        {closed ? (
          <span className="sw-eyebrow sw-eyebrow-soft">Closed right now</span>
        ) : (
          <span data-store-part="meta" className={ROW_META}>
            <Rating v={v} />
            {meta ? <><span aria-hidden className="h-[3px] w-[3px] rounded-full bg-[var(--swift-muted-soft)]" /><span>{meta}</span></> : null}
          </span>
        )}
      </span>
      <ChevronRight size={18} className="flex-none text-[var(--swift-muted-soft)]" aria-hidden />
    </Link>
  );
}

export function VendorCardSkeleton() {
  return (
    <div className={ROW_CARD}>
      <span data-store-part="image" className={`${ROW_THUMB} relative overflow-hidden`}><Bone className="h-full rounded-xl" /></span>
      <span data-store-part="copy" className={ROW_COPY}><Bone className="h-[22px] w-3/4" /><span data-store-part="meta" className={ROW_META}><Bone className="h-[18px] w-28" /></span></span>
    </div>
  );
}

export const VENDOR_GRID = 'grid grid-cols-1 gap-3 wide:grid-cols-2';

export function VendorGridSkeleton({ n = 6, label = 'Loading stores' }: { n?: number; label?: string }) {
  return (
    <LoadingRegion label={label} className={VENDOR_GRID}>
      {Array.from({ length: n }).map((_, i) => <VendorCardSkeleton key={i} />)}
    </LoadingRegion>
  );
}

/** The hero card ("Recommended for you"): a wide photo, the name over it. */
export function VendorHeroCard({ v }: { v: Vendor }) {
  const meta = storeMeta(v);
  return (
    <Link href={`/order/vendor/${v.id}`} className="sw-card relative block overflow-hidden transition-transform duration-200 hover:-translate-y-0.5">
      <Photo src={v.coverImageUrl} alt="" vendorType={v.vendorType} sizes="(min-width: 760px) 400px, 72vw" className="aspect-video w-full rounded-none" iconSize={40} />
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-[110px]" style={{ background: 'linear-gradient(180deg, rgba(33,26,26,0), rgba(33,26,26,0.62))' }} />
      <span className="absolute inset-x-4 bottom-3 flex flex-col gap-1">
        <span className="truncate font-display text-[22px] font-semibold leading-7 text-[var(--swift-white)]">{v.name}</span>
        <span className="flex gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-white/90 px-[7px] py-0.5 text-[11px] font-bold leading-[14px] text-[var(--swift-ink)]"><Star size={11} className="fill-[var(--swift-star)] text-[var(--swift-star)]" aria-hidden />{ratingText(v)}</span>
          {meta ? <span className="rounded-full bg-white/90 px-[7px] py-0.5 text-[11px] font-semibold leading-[14px] text-[var(--swift-ink)]">{meta}</span> : null}
        </span>
      </span>
    </Link>
  );
}

/** The square card ("Groceries & shops", "Order again"). */
export function VendorSquareCard({ v }: { v: Vendor }) {
  const meta = storeMeta(v);
  return (
    <Link href={`/order/vendor/${v.id}`} className="flex min-w-0 flex-col text-left text-[var(--swift-ink)] active:opacity-85">
      <span data-store-part="image" className="relative block aspect-square w-full overflow-hidden rounded-2xl">
        <Photo src={v.coverImageUrl} alt="" vendorType={v.vendorType} sizes="(min-width: 760px) 200px, 44vw" className="absolute inset-0" />
      </span>
      <span data-store-part="copy" className={SQUARE_COPY}>
        <span className="truncate text-[13px] font-semibold leading-[18px]">{v.name}</span>
        <span className="flex items-center gap-1.5 text-[13px] leading-[18px] text-[var(--swift-muted)]"><Rating v={v} />{meta ? <><span aria-hidden className="h-[3px] w-[3px] rounded-full bg-[var(--swift-muted-soft)]" />{meta}</> : null}</span>
      </span>
    </Link>
  );
}

/** An item card (Popular, Market): the dish's photo, its name, its price. */
export function ItemCard({
  href, name, price, imageUrl, vendorType, meta, isNew = false, action,
}: {
  href: string; name: string; price: unknown; imageUrl: string | null; vendorType?: string | null; meta?: string; isNew?: boolean; action?: React.ReactNode;
}) {
  return (
    <Link href={href} className="group flex min-w-0 flex-col text-left text-[var(--swift-ink)] active:opacity-85">
      <span data-store-part="image" className="relative block aspect-square w-full overflow-hidden rounded-2xl">
        <Photo src={imageUrl} alt="" vendorType={vendorType} name={name} sizes="(min-width: 760px) 200px, 44vw" className="absolute inset-0 transition-transform duration-200 group-hover:scale-[1.015]" />
        {isNew ? <span className="absolute left-2 top-2 rounded-full bg-[rgba(33,26,26,0.72)] px-3 py-[5px] text-[13px] font-semibold leading-[18px] text-[var(--swift-white)]">NEW</span> : null}
      </span>
      <span data-store-part="copy" className={SQUARE_COPY}>
        <span className="truncate text-[13px] font-semibold leading-[18px]">{name}</span>
        <span className="flex items-center justify-between gap-2"><span className="sw-money">{money(price)}</span>{action}</span>
        {meta ? <span className="truncate text-[13px] leading-[18px] text-[var(--swift-muted)]">{meta}</span> : null}
      </span>
    </Link>
  );
}

export function ItemCardSkeleton() {
  return (
    <div className="flex min-w-0 flex-col">
      <span data-store-part="image" className="relative block aspect-square w-full overflow-hidden rounded-2xl"><Bone className="h-full rounded-2xl" /></span>
      <span data-store-part="copy" className={SQUARE_COPY}><Bone className="h-[18px] w-3/4" /><Bone className="h-[22px] w-16" /><Bone className="h-[18px] w-2/3" /></span>
    </div>
  );
}

/** A section heading: the small eyebrow, the Bricolage title, "See all". */
export function SectionHead({ id, eyebrow, title, seeAll }: { id: string; eyebrow?: string; title: string; seeAll?: { href: string; label?: string } }) {
  return (
    <div className="flex flex-col">
      {eyebrow ? <span className="sw-eyebrow sw-eyebrow-soft mb-0.5">{eyebrow}</span> : null}
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="sw-title">{title}</h2>
        {seeAll ? <Link href={seeAll.href} prefetch={true} className="sw-link-btn">{seeAll.label ?? 'See all'}</Link> : null}
      </div>
    </div>
  );
}

/** An honest empty line inside a page. */
export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="rounded-2xl border border-dashed border-[var(--swift-border-strong)] px-4 py-6 text-center text-[13px] leading-[18px] text-[var(--swift-muted)]">{children}</p>;
}
