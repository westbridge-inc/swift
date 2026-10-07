'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchVendorDetail, approveVendor, suspendVendor, featureVendor } from '@/lib/api';
import { label, ratingText } from '@/lib/labels';
import type { Outcome } from '@/lib/outcome';
import { ActionResult } from '@/components/mc/ActionResult';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { StatusBadge } from '@/components/mc/StatusBadge';
import { Truncate } from '@/components/mc/Truncate';
import { DataTable } from '@/components/mc/DataTable';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-1 pilot] One store, the whole story — and every action
// answers in words.
//
// Approve, suspend and feature go through the in-page panel (reason where the
// server requires one, a plain confirmation where it does not), and the
// server's answer — success, a 202 queue, or a refusal such as 409
// CHECKLIST_INCOMPLETE — is shown in plain words with the next step. The old
// page dropped every answer but the suspension's: approving a store whose
// documents were not all approved "silently didn't work".
// ---------------------------------------------------------------------------

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

const gyd = (n: unknown) => `G$${Number(n || 0).toLocaleString('en-GY', { maximumFractionDigits: 2 })}`;

function Back() {
  return (
    <Link href="/vendors" className="mc-back">
      <ArrowLeft size={16} aria-hidden="true" /> Vendors
    </Link>
  );
}

function Row({ label: name, children }: { label: string; children: React.ReactNode }) {
  if (children == null || children === '') return null;
  return (
    <div className="mc-row">
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

interface RecentOrder { id: string; orderNumber: string; status: string; totalAmount: number; paymentMethod: string }
interface Sibling { id: string; name: string; status: string }

export default function VendorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const dialog = useActionDialog();
  const [result, setResult] = useState<Outcome | null>(null);
  const store = useQuery({ queryKey: ['vendor', id], queryFn: () => fetchVendorDetail(id) });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['vendor', id] });
    void qc.invalidateQueries({ queryKey: ['vendors'] });
  };
  /** Whatever the server said, it stays on the page — and the record is re-read. */
  const show = (outcome: Outcome | null) => {
    if (!outcome) return;
    setResult(outcome);
    refresh();
  };

  const v: any = store.data?.data;

  if (store.isLoading) {
    return (
      <div className="mc-page">
        <Back />
        <div className="mc-card" aria-busy="true">Loading this store…</div>
      </div>
    );
  }
  if (store.isError || !v) {
    return (
      <div className="mc-page">
        <Back />
        <QueryFailed
          error={store.error ?? new Error('The server sent no store record.')}
          what="this store"
          onRetry={() => void store.refetch()}
          retrying={store.isFetching}
        />
      </div>
    );
  }

  const owner = v.owner?.user;
  const ownerName = [owner?.firstName, owner?.lastName].filter(Boolean).join(' ');
  const siblings: Sibling[] = (v.owner?.vendors ?? []).filter((s: Sibling) => s.id !== v.id);
  const orders: RecentOrder[] = v.recentOrders ?? [];
  const sub = v.subscription;
  const context = { applicantId: owner?.id };

  const approve = async () => show(await dialog.run({
    title: `Approve ${v.name}?`,
    body: (
      <p>
        The store goes live and can take orders. Swift first checks that every required document is approved; if one is
        not, nothing changes and you are told what is missing.
      </p>
    ),
    confirmLabel: 'Approve store',
    reason: { hint: 'Kept on the permanent record; not sent to the owner.' },
    context,
    submit: ({ reason }) => approveVendor(id, reason),
    success: () => `${v.name} is live and can take orders.`,
  }));

  const suspend = async () => show(await dialog.run({
    title: `Suspend ${v.name}?`,
    body: (
      <p>
        It stops taking orders immediately and leaves search. The owner is sent your reason. The console cannot undo a
        suspension yet.
      </p>
    ),
    confirmLabel: 'Suspend store',
    reason: { hint: 'The owner receives this reason, and it is kept on the permanent record.' },
    context,
    submit: ({ reason }) => suspendVendor(id, reason),
    success: () => `${v.name} is suspended and has stopped taking orders. The owner was sent your reason.`,
  }));

  const toggleFeatured = async () => {
    const featuring = !v.isFeatured;
    show(await dialog.run({
      title: featuring ? `Feature ${v.name}?` : `Remove ${v.name} from featured stores?`,
      body: <p>{featuring ? 'Customers see it among the featured stores.' : 'Customers stop seeing it among the featured stores.'}</p>,
      confirmLabel: featuring ? 'Feature store' : 'Remove from featured',
      reason: false,
      context,
      submit: () => featureVendor(id, featuring),
      success: () => (featuring ? `${v.name} is now featured.` : `${v.name} is no longer featured.`),
    }));
  };

  return (
    <div className="mc-page">
      <Back />

      <header className="flex flex-wrap items-start gap-4 mb-5">
        <div
          aria-hidden="true"
          className="mc-numbers grid place-items-center shrink-0 w-12 h-12 rounded-full text-white text-lg font-bold"
          style={{ background: 'var(--mc-accent)' }}
        >
          {String(v.name ?? '?').trim().charAt(0).toUpperCase() || '?'}
        </div>
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="mc-numbers text-2xl font-semibold leading-tight" style={{ letterSpacing: '-0.02em' }}>
            <Truncate text={v.name} lines={2} focusable />
          </h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <StatusBadge group="VendorStatus" value={v.status} />
            <span className={`mc-badge${v.acceptingOrders ? ' mc-tone-good' : ''}`}>
              {v.acceptingOrders ? 'Taking orders' : 'Not taking orders'}
            </span>
            {v.isFeatured ? <span className="mc-badge mc-tone-info">Featured</span> : null}
          </div>
          <p className="mc-muted mt-1.5">
            {[label('VendorType', v.vendorType), v.city, `Joined ${when(v.createdAt)}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 w-full sm:w-auto sm:ml-auto">
          <button type="button" className="mc-btn" onClick={toggleFeatured}>
            {v.isFeatured ? 'Remove from featured…' : 'Feature…'}
          </button>
          {v.status === 'ACTIVE' ? (
            <button type="button" className="mc-btn mc-btn-danger" onClick={suspend}>Suspend…</button>
          ) : null}
          {v.status === 'PENDING_APPROVAL' ? (
            <button type="button" className="mc-btn mc-btn-primary" onClick={approve}>Approve…</button>
          ) : null}
        </div>
      </header>

      <ActionResult outcome={result} onDismiss={() => setResult(null)} className="mb-5" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4 min-w-0">
          <section aria-labelledby="recent-orders" className="space-y-2">
            <h2 id="recent-orders" className="mc-label">Recent orders</h2>
            <DataTable<RecentOrder>
              label="Recent orders"
              rows={orders}
              rowKey={(o) => o.id}
              empty="No orders yet."
              columns={[
                {
                  key: 'order', header: 'Order', width: '34%', primary: true,
                  cell: (o) => <Link href={`/orders/${o.id}`}><Truncate text={o.orderNumber} /></Link>,
                },
                { key: 'payment', header: 'Payment', width: '18%', cell: (o) => label('PaymentMethod', o.paymentMethod) },
                { key: 'status', header: 'Status', width: '28%', cell: (o) => <StatusBadge group="OrderStatus" value={o.status} /> },
                { key: 'total', header: 'Total', width: '20%', align: 'right', cell: (o) => <span className="mc-numbers">{gyd(o.totalAmount)}</span> },
              ]}
            />
          </section>

          {siblings.length > 0 ? (
            <section aria-labelledby="other-stores" className="mc-card">
              <h2 id="other-stores" className="mc-label">Other stores (same owner)</h2>
              <ul className="grid gap-1">
                {siblings.map((s) => (
                  <li key={s.id}>
                    <Link href={`/vendors/${s.id}`} className="flex items-center justify-between gap-3 min-h-11 rounded-lg px-2 -mx-2 hover:bg-[var(--mc-surface)]">
                      <Truncate text={s.name} className="font-semibold" />
                      <StatusBadge group="VendorStatus" value={s.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="space-y-4 min-w-0">
          <section aria-labelledby="owner" className="mc-card">
            <h2 id="owner" className="mc-label">Owner</h2>
            {owner ? (
              <dl className="mc-rows">
                <Row label="Name">{ownerName ? <Link href={`/users/${owner.id}`}>{ownerName}</Link> : null}</Row>
                <Row label="Phone">{owner.phone}</Row>
                <Row label="Email">{owner.email}</Row>
                <Row label="Account">{owner.status ? <StatusBadge group="UserStatus" value={owner.status} /> : null}</Row>
              </dl>
            ) : (
              <p className="mc-muted">No owner on this record.</p>
            )}
          </section>

          <section aria-labelledby="subscription" className="mc-card">
            <h2 id="subscription" className="mc-label">Subscription</h2>
            {sub ? (
              <dl className="mc-rows">
                <Row label="Status"><StatusBadge group="SubscriptionStatus" value={sub.status} /></Row>
                <Row label="Weekly fee"><span className="mc-numbers">{gyd(sub.customRate ?? sub.weeklyRate)}</span></Row>
                {sub.isTrialActive && sub.trialEndDate ? <Row label="Trial ends">{when(sub.trialEndDate)}</Row> : null}
                {sub.nextBillingDate ? <Row label="Next bill">{when(sub.nextBillingDate)}</Row> : null}
              </dl>
            ) : (
              <p className="mc-muted">No subscription yet. It starts when the store goes live.</p>
            )}
          </section>

          <section aria-labelledby="store" className="mc-card">
            <h2 id="store" className="mc-label">Store</h2>
            <dl className="mc-rows">
              <Row label="City">{v.city}</Row>
              <Row label="Address">{v.addressLine1}</Row>
              <Row label="Phone">{v.phone}</Row>
              <Row label="Rating"><span className="mc-numbers">{ratingText(v.averageRating, v.totalRatings)}</span></Row>
              <Row label="Registration">{v.tier ? label('VendorTier', v.tier) : null}</Row>
              <Row label="Menu items"><span className="mc-numbers">{v._count?.items ?? 0}</span></Row>
              <Row label="Lifetime orders"><span className="mc-numbers">{v._count?.orders ?? 0}</span></Row>
              <Row label="MMG pay link">{v.mmgPayUrl ? 'Attached' : 'Not attached'}</Row>
              <Row label="Joined">{when(v.createdAt)}</Row>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
