'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { getAdvertisers, getCampaigns, type Campaign } from '@/lib/partner-api';
import { formatMoney } from '@/lib/money';
import { feeDate } from '@/lib/weekly-fee';
import { DataUnavailable } from './data-unavailable';

const words = (s: string) => s.toLowerCase().replaceAll('_', ' ');
function Amount({ value, currency }: { value: number | null; currency: string }) {
  return <span>{formatMoney(value)}{currency !== 'GYD' ? ` ${currency}` : ''}</span>;
}
function CampaignList({ advertiserId }: { advertiserId: string }) {
  const q = useQuery({ queryKey: ['ads-campaigns', advertiserId], queryFn: () => getCampaigns(advertiserId) });
  if (q.isLoading) return <p role="status" className="sw-caption py-6">Loading campaigns…</p>;
  if (q.isError) return <DataUnavailable what="your campaigns" error={q.error} onRetry={() => void q.refetch()} />;
  return <>
    {q.data?.length ? <div className="grid gap-4 wide:grid-cols-2">{q.data.map(c => <Link key={c.id} href={`/advertiser/campaigns/${encodeURIComponent(advertiserId)}/${encodeURIComponent(c.id)}`} className="sw-order-card block hover:outline hover:outline-1 hover:outline-[var(--swift-border-strong)]">
      <div className="flex items-start gap-3"><h3 className="sw-label flex-1">{c.name}</h3><span className="sw-status">{words(c.status)}</span></div>
      <p className="sw-caption mt-2">{c.placement.name} · {feeDate(c.startWeek)} – {feeDate(c.endWeek)}</p>
      <div className="mt-4 flex items-center justify-between gap-3"><span className="sw-label"><Amount value={c.totalAmount} currency={c.currency} /></span><ChevronRight size={18} aria-hidden /></div>
    </Link>)}</div> : <div className="sw-empty"><h3 className="sw-heading">No campaigns yet</h3><p className="sw-caption">Campaigns created in the Swift app will appear here.</p></div>}
    {q.data?.length === 100 && <p className="sw-caption mt-4">Showing the latest 100 campaigns.</p>}
  </>;
}
export function AdvertiserCampaigns({ account = false }: { account?: boolean }) {
  const q = useQuery({ queryKey: ['ads-memberships'], queryFn: getAdvertisers });
  return <section className="space-y-6">
    <header className="sw-bleed bg-[var(--swift-red)] py-5 text-white"><h1 className="sw-title text-white">{account ? 'Advertising account' : 'Your campaigns'}</h1><p className="mt-1 text-[13px]">Home-screen advertising · flat weekly rates</p></header>
    {q.isLoading && <div role="status" className="sw-empty"><span className="sw-skeleton h-28 w-full" />Loading your advertising accounts…</div>}
    {q.isError && <DataUnavailable what="your advertising accounts" error={q.error} onRetry={() => void q.refetch()} />}
    {q.data?.length === 0 && <div className="sw-empty"><h2 className="sw-heading">Your business can advertise here</h2><p className="sw-caption">Register an advertising account in the Swift app to get started.</p></div>}
    {q.data?.map(a => <section key={a.id} className="space-y-4"><div className="flex flex-wrap items-center gap-3"><h2 className="sw-heading">{a.companyName}</h2><span className="sw-status">{words(a.status)}</span></div>
      {account ? <div className="sw-card p-5"><p className="sw-label">Your access: {words(a.memberRole)}</p><p className="sw-caption mt-2">Manage company details and team access in the Swift app.</p></div> : <CampaignList advertiserId={a.id} />}
    </section>)}
    {!account && <p className="sw-caption">Create and manage campaigns in the Swift app. You can read their status and payment records here.</p>}
  </section>;
}
export function CampaignRead({ advertiserId, campaignId }: { advertiserId: string; campaignId: string }) {
  const q = useQuery({ queryKey: ['ads-campaigns', advertiserId], queryFn: () => getCampaigns(advertiserId) });
  const c: Campaign | undefined = q.data?.find(row => row.id === campaignId);
  return <section className="max-w-3xl space-y-6"><Link href="/advertiser" className="sw-link-btn">Back to campaigns</Link>
    {q.isLoading && <p role="status" className="sw-empty">Loading campaign…</p>}
    {q.isError && <DataUnavailable what="this campaign" error={q.error} onRetry={() => void q.refetch()} />}
    {q.data && !c && <div className="sw-empty"><h1 className="sw-title">Campaign unavailable</h1><p className="sw-caption">It is not in this account’s latest 100 campaigns. Check the Swift app for older campaigns.</p></div>}
    {c && <><header className="sw-bleed bg-[var(--swift-red)] py-5 text-white"><h1 className="sw-title text-white">{c.name}</h1><p className="mt-1">{words(c.status)}</p></header>
      {c.statusReason && <p className="sw-note">{c.statusReason}</p>}
      <dl className="sw-card grid gap-5 p-5 wide:grid-cols-2"><div><dt className="sw-caption">Placement</dt><dd className="sw-label">{c.placement.name}</dd></div><div><dt className="sw-caption">Schedule</dt><dd>{feeDate(c.startWeek)} – {feeDate(c.endWeek)}</dd></div><div><dt className="sw-caption">Cities</dt><dd>{c.cities.join(', ')}</dd></div><div><dt className="sw-caption">Campaign total</dt><dd className="sw-title"><Amount value={c.totalAmount} currency={c.currency} /></dd></div></dl>
      <section><h2 className="sw-heading">Payment records</h2>{c.invoices.length ? c.invoices.map(i => <div key={i.id} className="sw-row flex-wrap"><span className="flex-1 sw-label">{i.number}</span><span>{c.currency} {formatMoney(i.amount)}</span><span className="sw-status">{words(i.status)}</span></div>) : <p className="sw-board-empty mt-3">No invoices yet.</p>}</section>
      <section><h2 className="sw-heading">Creative review</h2>{c.creatives.length ? c.creatives.map((a, index) => <div key={a.id} className="sw-row"><span className="flex-1">Creative {index + 1}</span><span className="sw-status">{words(a.status)}</span></div>) : <p className="sw-board-empty mt-3">No creative uploaded yet.</p>}</section>
      <section><h2 className="sw-heading">Booked weeks</h2>{c.bookings.length ? c.bookings.map((b, index) => <div key={`${b.city}:${b.weekStart}:${index}`} className="sw-row flex-wrap"><span className="flex-1">{b.city} · {feeDate(b.weekStart)}</span><span className="sw-status">{words(b.status)}</span></div>) : <p className="sw-board-empty mt-3">No weeks reserved yet.</p>}</section>
    </>}
  </section>;
}
