'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { BadgeCheck, CircleCheck, Star, X } from 'lucide-react';
import type { ServiceCatalog } from '@swift/types';
import { BROWSE_STALE_MS, fromPage, type GuestRead } from '@/lib/browse-keys';
import {
  SERVICE_GROUP_LABELS, customerServiceCategories, selectedServiceCategory, serviceRequestTrade, servicesApi,
  type ProviderPage, type ServiceProviderCard,
} from '@/lib/service-jobs';
import { signInPath } from '@/lib/customer-routes';
import { useCustomerSession } from '@/components/customer-session';
import { DataUnavailable } from '@/components/data-unavailable';
import { EmptyNote } from '@/components/order-ui';
import { Modal } from '@/components/modal';
import { Pictogram } from '@/components/glyphs';
import { launchCity } from '@/lib/web-ordering';

export interface ServicesPageSeed {
  trade: string;
  catalog: GuestRead<ServiceCatalog> | null;
  providers: GuestRead<ProviderPage> | null;
}

const MIN_DESCRIPTION = 10;
const MAX_DESCRIPTION = 2000;

function ServicesInner({ seed }: { seed: ServicesPageSeed | null }) {
  const params = useSearchParams();
  const trade = params.get('trade') ?? '';
  const session = useCustomerSession();
  const catalog = useQuery({ queryKey: ['services', 'catalog'], queryFn: servicesApi.catalog, staleTime: 10 * 60_000, refetchOnWindowFocus: false, ...fromPage(seed?.catalog) });
  const categories = customerServiceCategories(catalog.data?.categories ?? []);
  const requestTrade = catalog.data ? serviceRequestTrade(catalog.data.categories, trade) : undefined;
  const chosen = selectedServiceCategory(categories, trade);
  const drawn = seed && seed.trade === requestTrade ? seed.providers : null;
  const providers = useInfiniteQuery({
    queryKey: ['services', 'providers', requestTrade ?? ''],
    queryFn: ({ pageParam }) => servicesApi.providers(requestTrade!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled: Boolean(requestTrade),
    staleTime: BROWSE_STALE_MS,
    refetchOnWindowFocus: false,
    ...(drawn ? { initialData: { pages: [drawn.data], pageParams: [undefined] }, initialDataUpdatedAt: drawn.at } : {}),
  });
  const [asking, setAsking] = useState<ServiceProviderCard | null>(null);
  const list = providers.data?.pages.flatMap((page) => page.providers) ?? [];
  const first = providers.data?.pages[0];

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <span className="sw-eyebrow">Services · {launchCity()}</span>
          <h1 className="sw-title mt-1">Local pros</h1>
          <p className="sw-caption mt-1 max-w-[560px] text-[15px] leading-[22px]">Electricians, plumbers, tutors and more. Ask for a quote, agree a time, and pay the pro in cash when the job is done.</p>
        </div>
        {session.status === 'signed-in' ? <Link href="/services/requests" className="sw-btn sw-btn-sm sw-btn-outline mt-1">Your requests</Link> : null}
      </div>

      {catalog.isError && !catalog.data ? (
        <div className="mt-5"><DataUnavailable what="the services" error={catalog.error} onRetry={() => void catalog.refetch()} /></div>
      ) : !catalog.data ? (
        <p role="status" className="mt-5 text-sm text-[var(--swift-muted)]">Loading services…</p>
      ) : categories.length === 0 ? (
        <div className="mt-5"><EmptyNote>No services are taking requests yet. They open as pros are checked.</EmptyNote></div>
      ) : (
        <>
          <nav aria-label="Kinds of service" className="sw-chip-row mt-5">
            {categories.map((category) => (
              <Link key={category.id} href={`/services?trade=${encodeURIComponent(category.id)}`} replace scroll={false}
                aria-current={category.id === trade ? 'page' : undefined} className="sw-chip">
                {category.label}
              </Link>
            ))}
          </nav>

          {!chosen ? (
            <div className="mt-6 grid gap-6">
              {(Object.keys(SERVICE_GROUP_LABELS) as Array<keyof typeof SERVICE_GROUP_LABELS>).map((group) => {
                const inGroup = categories.filter((category) => category.group === group);
                if (inGroup.length === 0) return null;
                return (
                  <section key={group} aria-labelledby={`group-${group}`}>
                    <h2 id={`group-${group}`} className="sw-heading">{SERVICE_GROUP_LABELS[group]}</h2>
                    <ul className="mt-3 grid grid-cols-1 gap-3 wide:grid-cols-2">
                      {inGroup.map((category) => (
                        <li key={category.id}>
                          <Link href={`/services?trade=${encodeURIComponent(category.id)}`} scroll={false} className="sw-card flex items-center gap-3 p-4">
                            <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-[var(--swift-sunken)] text-[var(--swift-ink)]"><Pictogram name="services" size={22} /></span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[15px] font-semibold leading-[22px]">{category.label}</span>
                              {category.availabilityMessage ? <span className="block text-[13px] leading-[18px] text-[var(--swift-muted)]">{category.availabilityMessage}</span> : null}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          ) : (
            <section aria-labelledby="pros-title" className="mt-6">
              <h2 id="pros-title" className="sw-title">{chosen.label}</h2>
              {chosen.availabilityMessage ? <p className="sw-caption mt-1">{chosen.availabilityMessage}</p> : null}
              {first?.riskTier === 'HIGH' && first.guidance ? <p className="sw-note sw-note-info mt-3">{first.guidance}</p> : null}
              {providers.isError && list.length === 0 ? (
                <div className="mt-4"><DataUnavailable what={`the ${chosen.label.toLowerCase()} pros`} error={providers.error} onRetry={() => void providers.refetch()} /></div>
              ) : providers.isPending ? (
                <p role="status" className="mt-4 text-sm text-[var(--swift-muted)]">Loading pros…</p>
              ) : list.length === 0 ? (
                <div className="mt-4"><EmptyNote>No {chosen.label.toLowerCase()} pros near you yet. We add pros as their checks finish — try again soon.</EmptyNote></div>
              ) : (
                <ul className="mt-4 grid grid-cols-1 gap-3 wide:grid-cols-2">
                  {list.map((provider) => <li key={provider.id}><ProviderCard provider={provider} onAsk={() => setAsking(provider)} /></li>)}
                </ul>
              )}
              {providers.hasNextPage ? (
                <button type="button" onClick={() => void providers.fetchNextPage()} disabled={providers.isFetchingNextPage} className="sw-btn sw-btn-md sw-btn-outline mx-auto mt-5">
                  {providers.isFetchingNextPage ? 'Loading…' : 'Show more pros'}
                </button>
              ) : null}
            </section>
          )}
        </>
      )}

      <p className="mt-6 text-[13px] leading-[18px] text-[var(--swift-muted)]">
        Looking for a barber, a salon or another shop that takes bookings? <Link href="/order/browse?type=SERVICE" className="sw-link">Browse shops that take bookings</Link>.
      </p>
      <p className="mt-2 flex items-start gap-2 text-[13px] leading-[18px] text-[var(--swift-muted)]">
        <CircleCheck size={16} className="mt-0.5 flex-none text-[var(--swift-success)]" aria-hidden />
        Every pro listed here has passed Swift’s checks for their trade. You pay the pro directly; Swift adds nothing to the price.
      </p>

      {asking && requestTrade ? <AskForQuote provider={asking} trade={requestTrade} onClose={() => setAsking(null)} /> : null}
    </div>
  );
}

function ProviderCard({ provider, onAsk }: { provider: ServiceProviderCard; onAsk: () => void }) {
  const rating = provider.displayRating == null ? 'New' : `${Number(provider.displayRating).toFixed(1)} (${provider.totalRatings})`;
  return (
    <div className="sw-card flex h-full flex-col gap-2 p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-[var(--swift-sunken)] text-[var(--swift-ink)]"><Pictogram name="services" size={22} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-[22px]">{provider.tradeLabel}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] leading-[18px] text-[var(--swift-muted)]">
            <span className="inline-flex items-center gap-1"><Star size={13} className="fill-[var(--swift-star)] text-[var(--swift-star)]" aria-hidden />{rating}</span>
            {provider.certified ? <span className="inline-flex items-center gap-1 font-semibold text-[var(--swift-success)]"><BadgeCheck size={14} aria-hidden />Licensed</span> : <span>Self-skilled</span>}
          </p>
        </div>
      </div>
      {provider.bio ? <p className="line-clamp-3 text-[13px] leading-[18px] text-[var(--swift-ink)]">{provider.bio}</p> : null}
      <button type="button" onClick={onAsk} className="sw-btn sw-btn-sm mt-auto self-start">Ask for a quote</button>
    </div>
  );
}

function AskForQuote({ provider, trade, onClose }: { provider: ServiceProviderCard; trade: string; onClose: () => void }) {
  const router = useRouter();
  const session = useCustomerSession();
  const [description, setDescription] = useState('');
  const send = useMutation({
    mutationFn: async () => {
      if (!(await session.ensureSignedIn())) {
        router.push(signInPath(`/services?trade=${encodeURIComponent(trade)}`));
        return null;
      }
      return servicesApi.request(provider.id, description.trim());
    },
    onSuccess: (job) => { if (job) router.push(`/services/requests/${encodeURIComponent(job.id)}`); },
  });
  const ready = description.trim().length >= MIN_DESCRIPTION;
  return (
    <Modal labelledBy="ask-title" onClose={onClose} className="bg-[var(--swift-card)] px-6 pb-6 pt-5">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h2 id="ask-title" className="sw-title">Ask for a quote</h2>
          <p className="sw-caption mt-1">{provider.tradeLabel} · they reply with a price; nothing is booked until you accept it.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" data-modal-initial-focus className="sw-icon-btn"><X size={20} aria-hidden /></button>
      </div>
      <label htmlFor="job-description" className="sw-field-label mt-4 block">What do you need done?</label>
      <textarea
        id="job-description"
        className="sw-input mt-1 min-h-[120px] w-full py-3"
        maxLength={MAX_DESCRIPTION}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        aria-describedby="job-description-hint"
      />
      <p id="job-description-hint" className="mt-1 text-[13px] leading-[18px] text-[var(--swift-muted)]">
        At least {MIN_DESCRIPTION} characters. The pro reads this to price the job.
      </p>
      {send.isError ? <p role="alert" className="sw-note sw-note-error mt-3">{(send.error as Error).message}</p> : null}
      <button type="button" onClick={() => send.mutate()} disabled={!ready || send.isPending} className="sw-btn sw-btn-block mt-4">
        {send.isPending ? 'Sending…' : ready ? 'Send request' : 'Describe the job to send'}
      </button>
    </Modal>
  );
}

export function ServicesScreen({ seed = null }: { seed?: ServicesPageSeed | null }) {
  return <Suspense fallback={<p role="status" className="text-sm text-[var(--swift-muted)]">Loading services…</p>}><ServicesInner seed={seed} /></Suspense>;
}
