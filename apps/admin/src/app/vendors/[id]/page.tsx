'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchVendorDetail, fetchVendorActivationChecklist, approveVendor, suspendVendor, featureVendor, type VendorActivationChecklist } from '@/lib/api';
import { label, ratingText, type Tone } from '@/lib/labels';
import type { Outcome } from '@/lib/outcome';
import { ActionResult } from '@/components/mc/ActionResult';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { StatusBadge } from '@/components/mc/StatusBadge';
import { Truncate } from '@/components/mc/Truncate';
import { DataTable } from '@/components/mc/DataTable';
import { ActivationChecklist } from '@/components/mc/ActivationChecklist';

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
//
// [MC-PR2] The page now shows the store's required documents and what each one
// is waiting for, with the server's verdict. There is no "Approve" decision of
// its own any more: a store goes live by itself when its last required
// document is approved. "Activate now" and "Reinstate" appear only when the
// server says every go-live rule is met, and run the same gates.
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

const DISCLOSURE_WORDS: Record<string, string> = {
  legalName: 'the legal or trading name', address: 'the business address', contact: "the owner's verified phone",
  operator: "Swift's own operator details (a server setting the tech team fixes)", vendor: 'the store record',
};

/** [MC-PR2] Where this store stands, in one sentence, from the server's verdict. */
function vendorVerdict(c: VendorActivationChecklist, name: string): { tone: Tone; text: string } {
  switch (c.next) {
    case 'LIVE':
      return c.isVerified
        ? { tone: 'good', text: c.activationValidUntil ? `Live. Its documents are approved and current until ${when(c.activationValidUntil)}.` : 'Live. Its documents are approved and current.' }
        : { tone: 'bad', text: 'Live, but its documents are no longer all current, so it cannot take orders until they are renewed.' };
    case 'NEEDS_DOCUMENTS':
      return c.storeStatus === 'SUSPENDED'
        ? { tone: 'warn', text: 'Suspended. It can be reinstated only when every required document below is approved and current.' }
        : { tone: 'warn', text: `Waiting for documents. When the last required one is approved in the Review Center, Swift makes ${name} live by itself.` };
    case 'NEEDS_DISCLOSURE':
      return { tone: 'warn', text: `Documents complete, but its storefront supplier information is missing ${c.disclosure.missing.map((m) => DISCLOSURE_WORDS[m] ?? m).join(', ')}. It goes live by itself once that is complete.` };
    case 'CAN_ACTIVATE':
      return { tone: 'info', text: 'Every required document is approved, but the store is not live yet. You can activate it now.' };
    case 'CAN_REINSTATE':
      return { tone: 'info', text: 'Suspended. Its documents are approved and current, so it can be reinstated.' };
    case 'FEE_UNPAID':
      // [MC-AD2] Billing lifts a fee hold when a payment is confirmed; the console never does.
      return { tone: 'warn', text: 'Suspended, and its weekly fee is unpaid or its billing is stopped. It comes back by itself when the fee is paid through MMG checkout.' };
    case 'ACCOUNT_CLOSED':
      return { tone: 'bad', text: 'The owner closed their Swift account. The store stays closed and cannot be reopened from the console.' };
    case 'CLOSED':
      return { tone: 'neutral', text: 'Closed. A closed store is not reopened from the console.' };
  }
}

interface RecentOrder { id: string; orderNumber: string; status: string; totalAmount: number; paymentMethod: string }
interface Sibling { id: string; name: string; status: string }

export default function VendorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const dialog = useActionDialog();
  const [result, setResult] = useState<Outcome | null>(null);
  const store = useQuery({ queryKey: ['vendor', id], queryFn: () => fetchVendorDetail(id) });
  // [MC-PR2] The activation checklist decides what this page offers: the same verdict the approve route enforces.
  const checklist = useQuery({ queryKey: ['vendor-checklist', id], queryFn: () => fetchVendorActivationChecklist(id) });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['vendor', id] });
    void qc.invalidateQueries({ queryKey: ['vendor-checklist', id] });
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

  const c: VendorActivationChecklist | undefined = checklist.data?.data;

  // [MC-PR2] "Approve" is no longer a decision of its own: the store goes live by itself when its last required
  // document is approved. These two buttons appear only when the server's verdict says the rules are met.
  const activate = async () => show(await dialog.run({
    title: `Activate ${v.name} now?`,
    body: (
      <p>
        Every required document is approved. Swift runs the same activation it runs when the last document is approved:
        the store goes live and its free trial starts. Only this store is activated; the owner&apos;s other stores are not
        changed.
      </p>
    ),
    confirmLabel: 'Activate store',
    reason: { hint: 'Kept on the permanent record; not sent to the owner.' },
    context,
    submit: ({ reason }) => approveVendor(id, reason),
    success: () => `${v.name} is live and can take orders.`,
  }));

  const reinstate = async () => show(await dialog.run({
    title: `Reinstate ${v.name}?`,
    body: (
      <p>
        It is no longer suspended and can take orders again once the owner opens it. Its required documents are approved
        and current.
      </p>
    ),
    confirmLabel: 'Reinstate store',
    reason: { hint: 'Kept on the permanent record. The owner is told the store is back, not your reason.' },
    context,
    submit: ({ reason }) => approveVendor(id, reason),
    success: () => `${v.name} is reinstated.`,
  }));

  const suspend = async () => show(await dialog.run({
    title: `Suspend ${v.name}?`,
    body: (
      <p>
        It stops taking orders immediately and leaves search. The owner is sent your reason. You can reinstate it from
        this page later, once its required documents are approved and current.
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
          {c?.next === 'CAN_ACTIVATE' ? (
            <button type="button" className="mc-btn mc-btn-primary" onClick={activate}>Activate now…</button>
          ) : null}
          {c?.next === 'CAN_REINSTATE' ? (
            <button type="button" className="mc-btn mc-btn-primary" onClick={reinstate}>Reinstate…</button>
          ) : null}
        </div>
      </header>

      <ActionResult outcome={result} onDismiss={() => setResult(null)} className="mb-5" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4 min-w-0">
          {c ? (
            <ActivationChecklist
              title={`Required documents · ${label('VendorType', c.role)}`}
              items={c.checklist.items}
              applicantId={c.applicantId}
              verdict={vendorVerdict(c, v.name)}
            />
          ) : checklist.isLoading ? (
            <div className="mc-card" aria-busy="true">Loading the document checklist…</div>
          ) : (
            <QueryFailed error={checklist.error} what="the document checklist" onRetry={() => void checklist.refetch()} retrying={checklist.isFetching} />
          )}
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
