import type { Metadata } from 'next';
import type { StaticImageData } from 'next/image';
import Link from 'next/link';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { ArrowRight, Banknote, CarTaxiFront, HandCoins, LifeBuoy, ShieldCheck, ShoppingBasket } from 'lucide-react';
import { StoreButtons } from '@/components/store-buttons';
import { site, SITE_ORIGIN } from '@/site.config';
import { launchCity } from '@/lib/web-ordering';
// The phone app's real Home screen (the App Store screenshot), cut above the sample "Popular" row: no store,
// price or rating appears, only the app's own header, search and service tiles.
import appHome600 from './app-home-600.webp';
import appHome880 from './app-home-880.webp';

/**
 * [Item 7] The front door the public site shows before ordering opens on the web: src/middleware.ts answers
 * every ordering address with this page (the address bar keeps the address asked for), so it is canonical at
 * the root.
 *
 * [WEBSITE 30 Oct · owner] A real launch page: one headline, the app itself, Order / Ride / Earn, and a short
 * trust strip. Every sentence is true on main today:
 *  - cash or the business's own MMG, and Swift holds no order money: Terms §4;
 *  - fares shown before you book, the PIN check and the live trip: Terms §4 and §10;
 *  - partners' documents checked by a person before they operate: Terms §11 and the Privacy Policy
 *    (GUARDRAILS §7(4): "checked by a person", never a standing "verified" badge);
 *  - keep 100%, one flat weekly fee, no commission: Terms §11;
 *  - support hours: site.supportHours.
 * The company and policy links live once, in the footer every marketing page carries. The store buttons follow
 * the server's SWIFT_APP_STORES switch (components/store-buttons.tsx).
 */
export const metadata: Metadata = {
  title: { absolute: `${site.tradeName} · ${launchCity()}, in one app` },
  description: `Food, groceries, shops, parcels, rides and local pros in ${launchCity()}. The people doing the work keep 100% of what they earn.`,
  alternates: { canonical: SITE_ORIGIN },
};

/** [WEBSITE 30 Oct · perf] A still picture needs no client script: next/image's component (and getImageProps,
 *  which brings the same module) added about 5 kB of script to this page. The screen ships as two sized WebP
 *  files instead (600 and 880 wide, 17 kB and 26 kB), content-hashed by the build so they cache for good, and the
 *  browser picks one with srcset/sizes. Width and height are set so the page never jumps when it loads. */
const fileUrl = (image: StaticImageData | string) => (typeof image === 'string' ? image : image.src);
const HERO_SHOT = {
  src: fileUrl(appHome880),
  srcSet: `${fileUrl(appHome600)} 600w, ${fileUrl(appHome880)} 880w`,
  sizes: '(min-width: 768px) 378px, 298px',
  width: 880,
  height: 887,
  alt: 'The Swift app’s Home screen: search, and tiles for Food, Groceries, Taxi, Send, Services, Orders, Favourites and Scan.',
};

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;

function Tile({ icon: Glyph, tone }: { icon: Icon; tone: 'paper' | 'brand' }) {
  const look = tone === 'brand' ? 'bg-[var(--swift-white)] text-[var(--swift-red)]' : 'bg-[var(--swift-sunken)] text-[var(--swift-ink)]';
  return (
    <span aria-hidden="true" className={`inline-flex size-14 items-center justify-center rounded-2xl ${look}`}>
      <Glyph size={26} strokeWidth={1.75} />
    </span>
  );
}

function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="group inline-flex min-h-11 items-center gap-1.5 text-[15px] font-semibold text-[var(--swift-red)] hover:text-[var(--swift-red-600)]">
      {children}
      <ArrowRight aria-hidden="true" size={16} className="transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

function Card({ icon, title, children, more }: { icon: Icon; title: string; children: ReactNode; more: ReactNode }) {
  return (
    <article className="flex flex-col rounded-3xl bg-[var(--swift-card)] p-7 shadow-[var(--swift-elevation-card)] md:p-8">
      <Tile icon={icon} tone="paper" />
      <h2 className="mt-6 text-2xl font-bold tracking-tight">{title}</h2>
      <p className="mt-3 flex-1 text-[17px] leading-relaxed text-[var(--swift-muted)]">{children}</p>
      <div className="mt-6">{more}</div>
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
    body: 'Pay in cash, or by MMG straight to the business. Swift never holds your money.',
  },
  {
    icon: LifeBuoy,
    title: 'Local support',
    body: (
      <>
        People answer Help &amp; Support in the app, Monday to Saturday, 8:00 to 20:00.{' '}
        <Link href="/contact" className="whitespace-nowrap font-semibold text-[var(--swift-red)] underline underline-offset-2 hover:text-[var(--swift-red-600)]">
          Contact us
        </Link>
      </>
    ),
  },
];

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
            <StoreButtons className="mt-8" />
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

      {/* Order / Ride / Earn. */}
      <section className="bg-[var(--swift-sunken)]">
        <div className="mx-auto grid max-w-6xl gap-5 px-5 py-16 md:grid-cols-3 md:py-24">
          <Card icon={ShoppingBasket} title="Order" more={<MoreLink href="/how-it-works">How it works</MoreLink>}>
            Meals, groceries and shop items from local businesses. Parcels sent across town. Local pros booked for the
            job.
          </Card>
          <Card icon={CarTaxiFront} title="Ride" more={<MoreLink href="/faq">Common questions</MoreLink>}>
            Taxis in the Swift app, with the fare shown before you book. A PIN check before every ride, and the trip
            live on the map.
          </Card>
          <article className="flex flex-col rounded-3xl bg-[var(--swift-red)] p-7 text-[var(--swift-white)] md:p-8">
            <Tile icon={HandCoins} tone="brand" />
            <h2 className="mt-6 text-2xl font-bold tracking-tight">Earn with Swift</h2>
            <p className="mt-3 flex-1 text-[17px] leading-relaxed text-[rgba(255,255,255,0.86)]">
              Sell, deliver, drive or offer a service. Keep 100% of every sale, fare and tip. One flat weekly fee, no
              commission.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/signup" className="sw-btn sw-btn-sm bg-[var(--swift-white)] text-[var(--swift-red)] hover:bg-[var(--swift-red-50)]">
                Become a partner
              </Link>
              <Link href="/pricing" className="sw-btn sw-btn-sm bg-transparent text-[var(--swift-white)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.55)] hover:bg-[var(--swift-red-600)]">
                See pricing
              </Link>
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
