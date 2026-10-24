'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { getAdvertisers, getCampaigns, type Campaign } from '@/lib/partner-api';
import { formatAmount, formatMoney } from '@/lib/money';
import { ApiRequestError } from '@/lib/auth';
import { DataUnavailable } from './data-unavailable';

/** [BUG-GUARDS C5] Status words, the phone's (AdvertiserHomeScreen CAMPAIGN_STATUS,
 *  CampaignDetail creatives, team roles) — never the server's code ("pending
 *  payment", "partially refunded" read as a machine). */
const CAMPAIGN_WORDS: Record<string, string> = {
  DRAFT: 'Draft', PENDING_PAYMENT: 'Awaiting payment', PENDING_REVIEW: 'In review', SCHEDULED: 'Scheduled', LIVE: 'Live',
  PAUSED: 'Paused', COMPLETED: 'Completed', CANCELLED: 'Cancelled', REJECTED: 'Not approved',
};
const ACCOUNT_WORDS: Record<string, string> = { PENDING_REVIEW: 'In review', APPROVED: 'Approved', REJECTED: 'Not approved', SUSPENDED: 'Suspended' };
const ROLE_WORDS: Record<string, string> = { OWNER: 'Owner', MANAGER: 'Manager', ANALYST: 'Analyst' };
const INVOICE_WORDS: Record<string, string> = { UNPAID: 'Unpaid', PAID: 'Paid', VOID: 'Cancelled', REFUNDED: 'Refunded', PARTIALLY_REFUNDED: 'Partly refunded' };
const CREATIVE_WORDS: Record<string, string> = { PENDING: 'In review', APPROVED: 'Approved', REJECTED: 'Rejected' };
const WEEK_WORDS: Record<string, string> = { RESERVED: 'Held for you', CONFIRMED: 'Booked', RELEASED: 'Released', CANCELLED: 'Cancelled', REFUNDED: 'Refunded' };
const say = (table: Record<string, string>, code: string) => table[code] ?? 'Status unavailable';
/** Campaign weeks are calendar dates (`@db.Date`, sent as UTC midnight): read
 *  them in UTC, or Guyana's clock turns Monday 12 Oct into Sunday 11 Oct. */
const weekDate = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
/** The server's advertising switch is off (it is at launch): say so plainly,
 *  rather than drawing it as an outage or an empty account. */
const adsOff = (error: unknown) => error instanceof ApiRequestError && error.code === 'ADS_DISABLED';
function AdsNotOpen() {
  return <div className="sw-empty"><h2 className="sw-heading">Swift Ads is not open yet</h2><p className="sw-caption">Advertising on Swift has not started. Your account and campaigns will show here when it does.</p></div>;
}
function Amount({ value, currency }: { value: number | null; currency: string }) {
  return <span>{formatMoney(value)}{currency !== 'GYD' ? ` ${currency}` : ''}</span>;
}
function CampaignList({ advertiserId }: { advertiserId: string }) {
  const q = useQuery({ queryKey: ['ads-campaigns', advertiserId], queryFn: () => getCampaigns(advertiserId) });
  if (q.isLoading) return <p role="status" className="sw-caption py-6">Loading campaigns…</p>;
  if (q.isError) return <DataUnavailable what="your campaigns" error={q.error} onRetry={() => void q.refetch()} />;
  return <>
    {q.data?.length ? <div className="grid gap-4 wide:grid-cols-2">{q.data.map(c => <Link key={c.id} href={`/advertiser/campaigns/${encodeURIComponent(advertiserId)}/${encodeURIComponent(c.id)}`} className="sw-order-card block hover:outline hover:outline-1 hover:outline-[var(--swift-border-strong)]">
      <div className="flex items-start gap-3"><h3 className="sw-label flex-1">{c.name}</h3><span className="sw-status">{say(CAMPAIGN_WORDS, c.status)}</span></div>
      <p className="sw-caption mt-2">{c.placement.name} · {weekDate(c.startWeek)} – {weekDate(c.endWeek)}</p>
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
    {q.isError && (adsOff(q.error) ? <AdsNotOpen /> : <DataUnavailable what="your advertising accounts" error={q.error} onRetry={() => void q.refetch()} />)}
    {q.data?.length === 0 && <div className="sw-empty"><h2 className="sw-heading">Your business can advertise here</h2><p className="sw-caption">Register an advertising account in the Swift app to get started.</p></div>}
    {q.data?.map(a => <section key={a.id} className="space-y-4"><div className="flex flex-wrap items-center gap-3"><h2 className="sw-heading">{a.companyName}</h2><span className="sw-status">{say(ACCOUNT_WORDS, a.status)}</span></div>
      {account ? <div className="sw-card p-5"><p className="sw-label">Your access: {say(ROLE_WORDS, a.memberRole)}</p><p className="sw-caption mt-2">Manage company details and team access in the Swift app.</p></div> : <CampaignList advertiserId={a.id} />}
    </section>)}
    {!account && !adsOff(q.error) && <p className="sw-caption">Create and manage campaigns in the Swift app. You can read their status and payment records here.</p>}
  </section>;
}
export function CampaignRead({ advertiserId, campaignId }: { advertiserId: string; campaignId: string }) {
  const q = useQuery({ queryKey: ['ads-campaigns', advertiserId], queryFn: () => getCampaigns(advertiserId) });
  const c: Campaign | undefined = q.data?.find(row => row.id === campaignId);
  return <section className="space-y-6"><Link href="/advertiser" className="sw-link-btn">Back to campaigns</Link>
    {q.isLoading && <p role="status" className="sw-empty">Loading campaign…</p>}
    {q.isError && (adsOff(q.error) ? <AdsNotOpen /> : <DataUnavailable what="this campaign" error={q.error} onRetry={() => void q.refetch()} />)}
    {q.data && !c && <div className="sw-empty"><h1 className="sw-title">Campaign unavailable</h1><p className="sw-caption">It is not in this account’s latest 100 campaigns. Check the Swift app for older campaigns.</p></div>}
    {c && <><header className="sw-bleed bg-[var(--swift-red)] py-5 text-white"><h1 className="sw-title text-white">{c.name}</h1><p className="mt-1">{say(CAMPAIGN_WORDS, c.status)}</p></header>
      <div className="max-w-3xl space-y-6">
      {c.statusReason && <p className="sw-note">{c.statusReason}</p>}
      <dl className="sw-card grid gap-5 p-5 wide:grid-cols-2"><div><dt className="sw-caption">Placement</dt><dd className="sw-label">{c.placement.name}</dd></div><div><dt className="sw-caption">Schedule</dt><dd>{weekDate(c.startWeek)} – {weekDate(c.endWeek)}</dd></div><div><dt className="sw-caption">Cities</dt><dd>{c.cities.join(', ')}</dd></div><div><dt className="sw-caption">Campaign total</dt><dd className="sw-title"><Amount value={c.totalAmount} currency={c.currency} /></dd></div></dl>
      <section><h2 className="sw-heading">Payment records</h2>{c.invoices.length ? c.invoices.map(i => <div key={i.id} className="sw-row flex-wrap"><span className="flex-1 sw-label">{i.number}</span><span>{formatAmount(i.amount, `${c.currency} `)}</span><span className="sw-status">{say(INVOICE_WORDS, i.status)}</span></div>) : <p className="sw-board-empty mt-3">No invoices yet.</p>}</section>
      <section><h2 className="sw-heading">Creative review</h2>{c.creatives.length ? c.creatives.map((a, index) => <div key={a.id} className="sw-row"><span className="flex-1">Creative {index + 1}</span><span className="sw-status">{say(CREATIVE_WORDS, a.status)}</span></div>) : <p className="sw-board-empty mt-3">No creative uploaded yet.</p>}</section>
      <section><h2 className="sw-heading">Booked weeks</h2>{c.bookings.length ? c.bookings.map((b, index) => <div key={`${b.city}:${b.weekStart}:${index}`} className="sw-row flex-wrap"><span className="flex-1">{b.city} · {weekDate(b.weekStart)}</span><span className="sw-status">{say(WEEK_WORDS, b.status)}</span></div>) : <p className="sw-board-empty mt-3">No weeks reserved yet.</p>}</section>
      </div>
    </>}
  </section>;
}
