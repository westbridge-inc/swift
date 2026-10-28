'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchVendorDetail, fetchVendorActivationChecklist, approveVendor, suspendVendor, featureVendor, revokeStoreVat, revealVendorPartyPhone, type VendorActivationChecklist } from '@/lib/api';
import { label, ratingText, type Tone } from '@/lib/labels';
import { JUDGED_FIELD_WORDS, PROHIBITED_CLASS_LABELS } from '@/lib/prohibited-items';
import type { ProhibitedClass } from '@/lib/api';
import type { Outcome } from '@/lib/outcome';
import { ActionResult } from '@/components/mc/ActionResult';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { StatusBadge } from '@/components/mc/StatusBadge';
import { Truncate } from '@/components/mc/Truncate';
import { DataTable } from '@/components/mc/DataTable';
import { PhoneReveal, usePhoneReveal } from '@/components/mc/PhoneReveal';
import { ActivationChecklist } from '@/components/mc/ActivationChecklist';
import { billDateLabel } from '@/lib/bill-date';
import { gyDate } from '@/lib/dates';

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
  iso ? gyDate(iso) : '—';

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
    case 'NEEDS_PHONE':
      // [owner #51] A store's first go-live needs a number customers can call; the owner is asked for it.
      return { tone: 'warn', text: `Documents complete, but it has no published phone number customers can call. Swift makes ${name} live by itself once the owner adds one in the app.` };
    case 'CAN_LIFT_TO_WAITING':
      return { tone: 'warn', text: 'Suspended before it was ever live. Its documents are approved, but it has no published phone number customers can call, and a suspended store cannot add one. Lifting the suspension returns it to waiting; it goes live by itself once the owner adds the number.' };
    case 'CAN_ACTIVATE':
      return { tone: 'info', text: 'Every required document is approved, but the store is not live yet. You can activate it now.' };
    case 'CAN_REINSTATE':
      return { tone: 'info', text: 'Suspended. Its documents are approved and current, so it can be reinstated.' };
    case 'FEE_UNPAID':
      // [MC-AD2] Billing lifts a fee hold when a payment is confirmed; the console never does.
      return { tone: 'warn', text: c.suspensionSource === 'BILLING'
        ? 'Suspended, and its weekly fee is unpaid or its billing is stopped. It comes back by itself when the fee is paid through MMG checkout.'
        : 'Suspended, and its weekly fee is unpaid or its billing is stopped. Pay through MMG checkout first. After payment, refresh this checklist and reinstate the admin suspension.' };
    case 'OWNER_ACCOUNT_RESTRICTED':
      return { tone: 'bad', text: "The owner's account is banned or suspended. Reinstate the owner's account first, then refresh this store's checklist." };
    case 'ACCOUNT_CLOSED':
      return { tone: 'bad', text: 'The owner closed their Swift account. The store stays closed and cannot be reopened from the console.' };
    case 'CLOSED':
      return { tone: 'neutral', text: 'Closed. A closed store is not reopened from the console.' };
  }
}

interface RecentOrder { id: string; orderNumber: string; status: string; totalAmount: number; paymentMethod: string }
/** [GUARDRAILS §8] One of this store's items the prohibited-items rule touches, as the server explains it. */
interface ProhibitedRow {
  id: string; name: string; state: 'BANNED' | 'WAITING' | 'APPROVED'; prohibitedClass: ProhibitedClass;
  source?: 'category' | 'removed'; field?: string; term: string | null; reason?: string | null;
}

function whyHidden(p: ProhibitedRow): string {
  const what = PROHIBITED_CLASS_LABELS[p.prohibitedClass] ?? p.prohibitedClass;
  const where = p.field ? `"${p.term}" in the ${JUDGED_FIELD_WORDS[p.field] ?? p.field}` : '';
  if (p.state === 'BANNED') {
    return p.source === 'removed'
      ? `Removed as ${what}${p.reason ? `: ${p.reason}` : ''}`
      : `Not allowed: ${what} (filed under a banned category)`;
  }
  return p.state === 'WAITING' ? `Waiting for a check: ${where} (${what})` : `Approved: ${where} (${what})`;
}
interface Sibling { id: string; name: string; status: string }

/** [STORE-VAT] Where a store's VAT stands, in words (the server's StoreVatStatus). */
const VAT_STATUS_WORDS: Readonly<Record<string, string>> = {
  PENDING: 'Waiting for a person to check its GRA certificate',
  APPROVED: 'Approved by a person (its certificate was checked)',
  REJECTED: 'Not approved',
  REVOKED: 'Withdrawn',
};

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
  // [FOLLOWUPS · follows O-1] The owner's and the store's numbers are masked; "Show number" is the audited read, for this page view only.
  const { revealed, revealFor } = usePhoneReveal(async (request) => show(await dialog.run(request)));
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
        the store goes live and its free trial starts. Only this store is activated. A valid business registration also promotes the owner&apos;s other stores to registered sellers and lifts their unregistered-seller limits.
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

  // [owner #51 · DS1145 S3] A never-live store an admin suspended goes back to waiting for its phone number.
  const liftToWaiting = async () => show(await dialog.run({
    title: `Lift ${v.name}'s suspension?`,
    body: (
      <p>
        It returns to waiting for approval, where the owner can add the phone number customers can call. Its documents
        are approved, so it goes live by itself once they do. The owner is asked for the number.
      </p>
    ),
    confirmLabel: 'Lift suspension',
    reason: { hint: 'Kept on the permanent record. The owner is asked for the number, not told your reason.' },
    context,
    submit: ({ reason }) => approveVendor(id, reason),
    success: () => `${v.name} is waiting for its phone number and goes live once the owner adds it.`,
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

  // [STORE-VAT · owner O-5] Withdraw a store's approved VAT (e.g. the GRA cancelled its registration). New orders stop
  // carrying VAT at once; orders already placed keep the VAT they froze.
  const withdrawVat = async () => show(await dialog.run({
    title: `Withdraw VAT for ${v.name}?`,
    body: <p>Its new orders stop carrying VAT at once, and its prices stop saying &ldquo;incl. VAT&rdquo;. Orders already placed keep their VAT. Your reason shows on the store&apos;s VAT settings.</p>,
    confirmLabel: 'Withdraw VAT',
    reason: { hint: 'The store sees this on its VAT settings, and it is kept on the permanent record.' },
    context,
    submit: ({ reason }) => revokeStoreVat(id, reason),
    success: () => `${v.name}'s VAT is withdrawn. New orders carry no VAT.`,
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
          <h2 className="mc-numbers text-2xl font-semibold leading-tight" style={{ letterSpacing: '-0.02em' }}>
            <Truncate text={v.name} lines={2} focusable />
          </h2>
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
          {c?.next === 'CAN_LIFT_TO_WAITING' ? (
            <button type="button" className="mc-btn mc-btn-primary" onClick={liftToWaiting}>Lift suspension…</button>
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
                <Row label="Phone">{owner.phone ? <PhoneReveal phone={owner.phone} revealed={revealed['owner']} onReveal={revealFor('owner', `Show the owner's full number for ${v.name}?`, "The owner's number is shown.", (reason) => revealVendorPartyPhone(id, 'owner', reason))} /> : null}</Row>
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
                {sub.nextBillingDate ? <Row label={billDateLabel(sub.nextBillingDate)}>{when(sub.nextBillingDate)}</Row> : null}
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
              <Row label="Phone">{v.phone ? <PhoneReveal phone={v.phone} revealed={revealed['store']} onReveal={revealFor('store', `Show the store's full number for ${v.name}?`, "The store's number is shown.", (reason) => revealVendorPartyPhone(id, 'store', reason))} /> : null}</Row>
              <Row label="Rating"><span className="mc-numbers">{ratingText(v.averageRating, v.totalRatings)}</span></Row>
              <Row label="Registration">{v.tier ? label('VendorTier', v.tier) : null}</Row>
              <Row label="Menu items"><span className="mc-numbers">{v._count?.items ?? 0}</span></Row>
              <Row label="Lifetime orders"><span className="mc-numbers">{v._count?.orders ?? 0}</span></Row>
              <Row label="MMG pay link">{v.mmgPayUrl ? 'Attached' : 'Not attached'}</Row>
              <Row label="Joined">{when(v.createdAt)}</Row>
            </dl>
          </section>

          {v.vatStatus && v.vatStatus !== 'NONE' ? (
            <section aria-labelledby="vat" className="mc-card">
              <h2 id="vat" className="mc-label">VAT</h2>
              <dl className="mc-rows">
                <Row label="Status">{VAT_STATUS_WORDS[v.vatStatus as string] ?? 'Not recognised by this page'}</Row>
                <Row label="Number the store gave">{v.vatRegistrationNumber}</Row>
                {v.vatStatus === 'APPROVED' ? (
                  <>
                    <Row label="Approved VAT reg. no.">{v.vatApprovedNumber}</Row>
                    <Row label="Registered name">{v.vatApprovedName}</Row>
                    <Row label="Takes effect">{v.vatEffectiveFrom ? gyDate(v.vatEffectiveFrom) : null}</Row>
                  </>
                ) : null}
                {v.vatStatus === 'REJECTED' || v.vatStatus === 'REVOKED' ? <Row label="Reason given">{v.vatReviewNote}</Row> : null}
              </dl>
              {v.vatStatus === 'PENDING' ? <Link href="/store-vat" className="text-sm underline">Decide it in Store VAT</Link> : null}
              {v.vatStatus === 'APPROVED' ? <button type="button" className="mc-btn mc-btn-danger" onClick={() => void withdrawVat()}>Withdraw VAT</button> : null}
            </section>
          ) : null}

          {(v.prohibitedItems ?? []).length > 0 ? (
            <section aria-labelledby="prohibited" className="mc-card">
              <h2 id="prohibited" className="mc-label">Items Swift does not allow, or is checking</h2>
              <dl className="mc-rows">
                {(v.prohibitedItems as ProhibitedRow[]).map((p) => <Row key={p.id} label={p.name}>{whyHidden(p)}</Row>)}
              </dl>
              <Link href="/catalogue-check" className="text-sm underline">Open the catalogue check</Link>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
