import type { Metadata } from 'next';
import type { StaticImageData } from 'next/image';
import Link from 'next/link';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { ArrowRight, Banknote, LifeBuoy, ShieldCheck } from 'lucide-react';
import { StoreButtons } from '@/components/app-store-links';
import { site, SITE_ORIGIN } from '@/site.config';
import { launchCity } from '@/lib/web-ordering';
// Real screens of the Swift phone app, cut so that no shop price, rating, review, earning or person's name shows:
//  - Home (the App Store screenshot), cut above the sample "Popular" row; the greeting shows no name and the
//    monogram is the app's own no-name "S" (HomeScreen.tsx greetingLine + monogram), as for an account with no
//    first name;
//  - live order tracking, cut above the timeline's store name;
//  - the taxi booking screen: the destination on the map, and the pickup and destination, cut above the ride choices so no
//    fare shows (owner 30 Oct: "dont show prices");
//  - the rider's home, offline, cut above the earnings card.
import appHome600 from './app-home-600.webp';
import appHome880 from './app-home-880.webp';
import appTracking from './app-tracking.webp';
import appTaxi from './app-taxi.webp';
import appPartner from './app-partner.webp';
import appTracking1206 from './app-tracking-1206.webp';
import appTaxi1206 from './app-taxi-1206.webp';
import appPartner1206 from './app-partner-1206.webp';

/**
 * [Item 7] The front door the public site shows before ordering opens on the web: src/middleware.ts answers
 * every ordering address with this page (the address bar keeps the address asked for), so it is canonical at
 * the root.
 *
 * [WEBSITE 30 Oct · owner] A real launch page: one headline, the app itself, Order / Ride / Earn, and a short
 * trust strip. Every sentence is true on main today:
 *  - the business, rider or driver is paid directly, in cash or by MMG where they take it, and Swift holds no
 *    money: Terms §4 (the courier and taxi screens say the same);
 *  - fares shown before you book, the PIN check and the live trip: Terms §4 and §10;
 *  - partners' documents checked by a person before they operate: Terms §11 and the Privacy Policy
 *    (GUARDRAILS §7(4): "checked by a person", never a standing "verified" badge);
 *  - keep 100%, one flat weekly fee, no commission: Terms §11;
 *  - support days and hours: site.supportDays.
 * The company and policy links live once, in the footer every marketing page carries. The store area follows
 * the server's SWIFT_APP_STORES switch (StoreButtons in components/app-store-links.tsx).
 *
 * [OPEN-EARLY · owner 31 Oct 2026] Partners sign up and send documents before ordering opens. This page is only
 * ever the closed front door (middleware.ts answers ordering addresses with it while the switch is not live), so
 * it says so plainly: "Opening soon" with a Join Swift button in the hero, the Order and Ride cards marked
 * "Opening soon" (their words describe the app, which is true), and the Earn card first in the swipe row on a
 * phone so a partner sees it without swiping.
 */
export const metadata: Metadata = {
  title: { absolute: `${site.tradeName} · ${launchCity()}, in one app` },
  description: `Food, groceries, shops, parcels, rides and local pros in ${launchCity()}. The people doing the work keep 100% of what they earn.`,
  alternates: { canonical: SITE_ORIGIN },
};

/** [WEBSITE 30 Oct · perf] A still picture needs no client script: next/image's component (and getImageProps,
 *  which brings the same module) added about 5 kB of script to this page. The screens ship as sized WebP files,
 *  content-hashed by the build so they cache for good. Width and height are set so the page never jumps; the
 *  three screens below the fold load lazily. */
const fileUrl = (image: StaticImageData | string) => (typeof image === 'string' ? image : image.src);
const HERO_SHOT = {
  src: fileUrl(appHome880),
  srcSet: `${fileUrl(appHome600)} 600w, ${fileUrl(appHome880)} 880w`,
  sizes: '(min-width: 768px) 378px, 298px',
  width: 880,
  height: 887,
  alt: 'The Swift app’s Home screen: a Good afternoon greeting, search, and tiles for Food, Groceries, Taxi, Send, Services, Orders, Favourites and Scan.',
};

/** Each card screen ships at 640 px and at the phone's full 1206 px, so Retina screens and zoom stay sharp; the
 *  browser picks by the card's drawn width (about 400 px on desktop, 82% of the phone's width below 768 px). */
type Shot = { image: StaticImageData | string; large: StaticImageData | string; alt: string };
const SCREEN = { width: 640, height: 764, sizes: '(min-width: 768px) 400px, 75vw' };

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;

function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="group inline-flex min-h-11 items-center gap-1.5 text-[15px] font-semibold text-[var(--swift-red)] hover:text-[var(--swift-red-600)]">
      {children}
      <ArrowRight aria-hidden="true" size={16} className="transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

/** A real app screen inside a card: the top of a phone's glass, with a hairline, sized and lazy. */
function Screen({ shot, tone }: { shot: Shot; tone: 'paper' | 'brand' }) {
  const ground = tone === 'brand' ? 'bg-[rgba(255,255,255,0.12)]' : 'bg-[var(--swift-sunken)]';
  return (
    <div className={`overflow-hidden rounded-2xl px-5 pt-5 ${ground}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a sized file and no client script */}
      <img
        src={fileUrl(shot.image)}
        srcSet={`${fileUrl(shot.image)} 640w, ${fileUrl(shot.large)} 1206w`}
        sizes={SCREEN.sizes}
        alt={shot.alt}
        width={SCREEN.width}
        height={SCREEN.height}
        loading="lazy"
        decoding="async"
        className="block h-auto w-full rounded-t-[22px] shadow-[0_0_0_1px_rgba(33,26,26,0.08)]"
      />
    </div>
  );
}

/** [OPEN-EARLY] Ordering and rides are not open yet: the card says so above its title, and its screen is muted. */
function Card({ shot, title, children, more }: { shot: Shot; title: string; children: ReactNode; more: ReactNode }) {
  return (
    <article data-opening-soon className="flex w-[82%] shrink-0 snap-center flex-col rounded-3xl bg-[var(--swift-card)] p-4 shadow-[var(--swift-elevation-card)] sm:w-[60%] md:w-auto">
      <div className="opacity-60 grayscale-[35%]">
        <Screen shot={shot} tone="paper" />
      </div>
      <div className="flex flex-1 flex-col px-3 pb-3 pt-6">
        <p className="self-start rounded-full bg-[var(--swift-sunken)] px-3 py-1 text-[13px] font-semibold text-[var(--swift-ink)]">Opening soon</p>
        <h2 className="mt-3 text-2xl font-bold tracking-tight">{title}</h2>
        <p className="mt-3 flex-1 text-[17px] leading-relaxed text-[var(--swift-muted)]">{children}</p>
        <div className="mt-5">{more}</div>
      </div>
    </article>
  );
}

const TRUST: Array<{ icon: Icon; title: string; body: ReactNode }> = [
  {
    icon: ShieldCheck,
    title: 'Checked by a person',
    body: 'Every business, rider and driver has their documents checked by a person on our team before they go live.',
  },
  {
    icon: Banknote,
    title: 'Cash or MMG',
    body: 'Pay the business, rider or driver directly, in cash or by MMG where they take it. Swift never holds your money.',
  },
  {
    icon: LifeBuoy,
    title: 'Local support',
    body: (
      <>
        People answer Help &amp; Support in the app, {site.supportDays}.{' '}
        <Link href="/contact" className="whitespace-nowrap font-semibold text-[var(--swift-red)] underline underline-offset-2 hover:text-[var(--swift-red-600)]">
          Contact us
        </Link>
      </>
    ),
  },
];

/** [REVIEW-F S3-1] The page's focus ring is the brand maroon: on the maroon card it would vanish, so these two
 *  links draw a white one. */
const ON_BRAND_FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--swift-white)]';

export default function LaunchingSoonPage() {
  return (
    <>
      {/* The headline and the app. The phone rises from the bottom edge of the band, as on the app's own store page. */}
      <section className="overflow-hidden border-b border-[var(--swift-border)]">
        <div className="mx-auto grid max-w-6xl items-end gap-12 px-5 pt-14 md:grid-cols-[minmax(0,1fr)_400px] md:gap-16 md:pt-24">
          <div className="self-center md:pb-24">
            <h1 className="text-[44px] font-bold leading-[1.02] tracking-[-0.03em] sm:text-6xl md:text-[76px]">
              {launchCity()},{' '}
              <br />
              in one app.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-[var(--swift-muted)] md:text-xl">
              Food, groceries, shops, parcels, rides and local pros. The people doing the work keep 100% of what they
              earn.
            </p>
            {/* [OPEN-EARLY] What is true today: Swift is not open yet, and partners can sign up now. */}
            <div data-opening-soon-hero className="mt-6 flex max-w-xl flex-col items-start gap-4">
              <p className="text-lg font-semibold leading-snug md:text-xl">
                Opening soon in {launchCity()}. Businesses, riders and taxi drivers can sign up now.
              </p>
              <Link href="/signup" className="sw-btn">
                Join Swift
              </Link>
            </div>
            {/* [REVIEW-F S4-2] The area keeps the store buttons' height (one 56 px row) in both states. */}
            <div data-store-area className="mt-8 flex min-h-14 items-center">
              <StoreButtons />
            </div>
          </div>
          <div className="relative mx-auto w-full max-w-[320px] md:max-w-none">
            <div aria-hidden="true" className="absolute -inset-x-10 top-10 bottom-0 rounded-t-full bg-[var(--swift-red-50)]" />
            <div className="relative rounded-t-[52px] border-[11px] border-b-0 border-[var(--swift-ink)] bg-[var(--swift-ink)] shadow-[0_30px_80px_-20px_rgba(33,26,26,0.35)]">
              {/* eslint-disable-next-line @next/next/no-img-element -- two sized files and srcset; no client script */}
              <img {...HERO_SHOT} alt={HERO_SHOT.alt} fetchPriority="high" decoding="async" className="block h-auto w-full rounded-t-[41px]" />
            </div>
          </div>
        </div>
      </section>

      {/* Order / Ride / Earn, each with its real screen: a swipe row on a phone, three columns on a wide screen. */}
      <section className="bg-[var(--swift-sunken)]">
        <div
          data-swipe-row
          className="mx-auto flex max-w-6xl snap-x snap-mandatory gap-4 overflow-x-auto px-5 py-16 [scrollbar-width:none] md:grid md:grid-cols-3 md:gap-5 md:overflow-visible md:py-24"
        >
          <Card
            shot={{ image: appTracking, large: appTracking1206, alt: 'Live order tracking in the Swift app: the rider on the map and where the order stands.' }}
            title="Order"
            more={<MoreLink href="/how-it-works">How it works</MoreLink>}
          >
            Meals, groceries and shop items from local businesses. Parcels sent across town. Local pros booked for the
            job. Follow every order live on the map.
          </Card>
          <Card
            shot={{ image: appTaxi, large: appTaxi1206, alt: 'Booking a taxi in the Swift app: the destination pinned on the map, and the pickup and destination fields.' }}
            title="Ride"
            more={<MoreLink href="/faq">Common questions</MoreLink>}
          >
            Taxis in the Swift app, with the fare shown before you book. A PIN check before every ride, and the trip
            live on the map.
          </Card>
          {/* [OPEN-EARLY] First in the swipe row on a phone (a partner sees it without swiping); last on a wide screen. */}
          <article data-earn-card className="order-first flex w-[82%] shrink-0 snap-center flex-col rounded-3xl bg-[var(--swift-red)] p-4 text-[var(--swift-white)] sm:w-[60%] md:order-none md:w-auto">
            <Screen
              shot={{ image: appPartner, large: appPartner1206, alt: 'The rider’s side of the Swift app: a map of Georgetown and the button to go online for jobs.' }}
              tone="brand"
            />
            <div className="flex flex-1 flex-col px-3 pb-3 pt-6">
              <h2 className="text-2xl font-bold tracking-tight">Earn with Swift</h2>
              <p className="mt-3 flex-1 text-[17px] leading-relaxed text-[rgba(255,255,255,0.86)]">
                Sell, deliver, drive or offer a service. Keep 100% of every sale, fare and tip. One flat weekly fee, no
                commission.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Link href="/signup" className={`sw-btn sw-btn-sm bg-[var(--swift-white)] text-[var(--swift-red)] hover:bg-[var(--swift-red-50)] ${ON_BRAND_FOCUS}`}>
                  Become a partner
                </Link>
                <Link href="/pricing" className={`sw-btn sw-btn-sm bg-transparent text-[var(--swift-white)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.55)] hover:bg-[var(--swift-red-600)] ${ON_BRAND_FOCUS}`}>
                  See pricing
                </Link>
              </div>
            </div>
          </article>
        </div>
      </section>

      {/* The trust strip. */}
      <section aria-labelledby="trust-heading">
        <div className="mx-auto max-w-6xl px-5 py-14 md:py-16">
          <h2 id="trust-heading" className="sr-only">Why people trust Swift</h2>
          <ul className="grid gap-8 md:grid-cols-3 md:gap-10">
            {TRUST.map(({ icon: Glyph, title, body }) => (
              <li key={title} className="flex gap-4">
                <Glyph aria-hidden="true" size={24} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[var(--swift-red)]" />
                <div>
                  <h3 className="text-[17px] font-semibold">{title}</h3>
                  <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--swift-muted)]">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
