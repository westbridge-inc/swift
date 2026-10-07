'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchUserDetail, suspendUser, unsuspendUser, banUser } from '@/lib/api';
import { label } from '@/lib/labels';
import type { Outcome } from '@/lib/outcome';
import { ActionResult } from '@/components/mc/ActionResult';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { StatusBadge } from '@/components/mc/StatusBadge';
import { Truncate } from '@/components/mc/Truncate';
import { DataTable } from '@/components/mc/DataTable';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-3] One person.
//
// Suspend, unsuspend and ban go through the in-page reason panel and every
// answer is shown (the old page showed only a suspension's failure; an
// unsuspend or ban refused by the role hierarchy vanished). A failed load says
// so with a Retry instead of "User not found". Roles and statuses are words.
// ---------------------------------------------------------------------------

const when = (iso?: string | null, withTime = false) =>
  iso ? new Date(iso).toLocaleString('en-GB', withTime ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const gyd = (n: unknown) => `G$${Number(n || 0).toLocaleString('en-GY', { maximumFractionDigits: 2 })}`;

function Row({ label: name, children }: { label: string; children: React.ReactNode }) {
  if (children == null || children === '') return null;
  return (
    <div className="mc-row">
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

interface RecentOrder { id: string; orderNumber: string; orderType: string; status: string; totalAmount: number }

export default function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const dialog = useActionDialog();
  const [result, setResult] = useState<Outcome | null>(null);
  const person = useQuery({ queryKey: ['user', id], queryFn: () => fetchUserDetail(id) });

  const show = (outcome: Outcome | null) => {
    if (!outcome) return;
    setResult(outcome);
    void qc.invalidateQueries({ queryKey: ['user', id] });
    void qc.invalidateQueries({ queryKey: ['users'] });
  };

  const back = (
    <Link href="/users" className="mc-back">
      <ArrowLeft size={16} aria-hidden="true" /> People
    </Link>
  );

  const u: any = person.data?.data;
  if (person.isLoading) return <div className="mc-page">{back}<div className="mc-card" aria-busy="true">Loading this person…</div></div>;
  if (person.isError || !u) {
    return (
      <div className="mc-page">
        {back}
        <QueryFailed error={person.error ?? new Error('The server sent no record.')} what="this person" onRetry={() => void person.refetch()} retrying={person.isFetching} />
      </div>
    );
  }

  const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Unnamed';
  const orders: RecentOrder[] = u.orders ?? [];

  // [ADM-006] The operator states why, in their own words; a dismissed panel does nothing.
  const suspend = async () => show(await dialog.run({
    title: `Suspend ${name}?`,
    body: <p>They are signed out and cannot transact until the account is unsuspended.</p>,
    confirmLabel: 'Suspend account',
    reason: { hint: 'Kept on the permanent record.' },
    submit: ({ reason }) => suspendUser(id, reason),
    success: () => `${name} is suspended.`,
  }));
  const unsuspend = async () => show(await dialog.run({
    title: `Unsuspend ${name}?`,
    body: <p>They can sign in and use Swift again.</p>,
    confirmLabel: 'Unsuspend account',
    reason: { hint: 'Kept on the permanent record.' },
    submit: ({ reason }) => unsuspendUser(id, reason),
    success: () => `${name} can use Swift again.`,
  }));
  const ban = async () => show(await dialog.run({
    title: `Permanently ban ${name}?`,
    body: <p>They lose access for good, and their documents are scheduled for deletion under the retention rules. Only a super admin can lift a ban.</p>,
    confirmLabel: 'Ban account',
    reason: { hint: 'Kept on the account and the permanent record.' },
    submit: ({ reason }) => banUser(id, reason),
    success: () => `${name} is banned.`,
  }));

  return (
    <div className="mc-page">
      {back}

      <header className="flex flex-wrap items-start gap-4 mb-5">
        <div aria-hidden="true" className="mc-numbers grid place-items-center shrink-0 w-12 h-12 rounded-full text-white text-lg font-bold" style={{ background: 'var(--mc-accent)' }}>
          {name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="mc-numbers text-2xl font-semibold leading-tight" style={{ letterSpacing: '-0.02em' }}>
            <Truncate text={name} lines={2} focusable />
          </h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <StatusBadge group="UserStatus" value={u.status} />
            {(u.roles ?? []).map((r: string) => <span key={r} className="mc-badge">{label('UserRole', r)}</span>)}
            {u.trustLevel ? <span className="mc-badge mc-tone-info">Trust {u.trustLevel}</span> : null}
          </div>
          <p className="mc-muted mt-1.5">{[u.phone, u.email].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="flex flex-wrap gap-2 w-full sm:w-auto sm:ml-auto">
          {u.status === 'SUSPENDED' ? (
            <button type="button" className="mc-btn" onClick={unsuspend}>Unsuspend…</button>
          ) : u.status !== 'BANNED' ? (
            <button type="button" className="mc-btn" onClick={suspend}>Suspend…</button>
          ) : null}
          {u.status !== 'BANNED' ? <button type="button" className="mc-btn mc-btn-danger" onClick={ban}>Ban…</button> : null}
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
              empty="No orders."
              columns={[
                { key: 'order', header: 'Order', width: '30%', primary: true, cell: (o) => <Link href={`/orders/${o.id}`}><Truncate text={o.orderNumber} /></Link> },
                { key: 'type', header: 'Type', width: '22%', cell: (o) => label('OrderType', o.orderType) },
                { key: 'status', header: 'Status', width: '28%', cell: (o) => <StatusBadge group="OrderStatus" value={o.status} /> },
                { key: 'total', header: 'Total', width: '20%', align: 'right', cell: (o) => <span className="mc-numbers">{gyd(o.totalAmount)}</span> },
              ]}
            />
          </section>

          <section aria-labelledby="strikes" className="mc-card">
            <h2 id="strikes" className="mc-label">Strikes</h2>
            {(u.strikes ?? []).length === 0 ? (
              <p className="mc-muted">Clean record — no strikes.</p>
            ) : (
              <ul className="grid gap-2">
                {u.strikes.map((s: { id: string; reason: string; createdAt: string }) => (
                  <li key={s.id} className="mc-doc mc-doc-bad">
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">{String(s.reason).replaceAll('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}</span>
                      <span className="block mc-muted text-xs">{when(s.createdAt, true)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="space-y-4 min-w-0">
          <section aria-labelledby="profiles" className="mc-card">
            <h2 id="profiles" className="mc-label">Profiles</h2>
            <ul className="grid gap-1">
              {u.rider ? (
                <li><Link href={`/riders/${u.rider.id}`} className="mc-row min-h-11"><span>Rider profile</span><span className={`mc-badge${u.rider.documentsVerified ? ' mc-tone-good' : ' mc-tone-warn'}`}>{u.rider.documentsVerified ? 'Verified' : 'Not verified'}</span></Link></li>
              ) : null}
              {u.driver ? (
                <li><Link href={`/drivers/${u.driver.id}`} className="mc-row min-h-11"><span>Driver profile</span><span className={`mc-badge${u.driver.documentsVerified ? ' mc-tone-good' : ' mc-tone-warn'}`}>{u.driver.documentsVerified ? 'Verified' : 'Not verified'}</span></Link></li>
              ) : null}
              {(u.vendorOwner?.vendors ?? []).map((v: { id: string; name: string; status: string }) => (
                <li key={v.id}><Link href={`/vendors/${v.id}`} className="mc-row min-h-11"><Truncate text={v.name} /><StatusBadge group="VendorStatus" value={v.status} /></Link></li>
              ))}
              {!u.rider && !u.driver && (u.vendorOwner?.vendors ?? []).length === 0 ? <li className="mc-muted">Customer only.</li> : null}
            </ul>
          </section>

          <section aria-labelledby="account" className="mc-card">
            <h2 id="account" className="mc-label">Account</h2>
            <dl className="mc-rows">
              <Row label="Joined">{when(u.createdAt)}</Row>
              <Row label="Phone verified">{u.isPhoneVerified ? 'Yes' : 'No'}</Row>
              <Row label="Total orders"><span className="mc-numbers">{u._count?.orders ?? 0}</span></Row>
              <Row label="Strikes"><span className="mc-numbers">{u._count?.strikes ?? 0}</span></Row>
              <Row label="Last active">{when(u.lastActiveAt, true)}</Row>
            </dl>
          </section>

          <section aria-labelledby="addresses" className="mc-card">
            <h2 id="addresses" className="mc-label">Addresses</h2>
            {(u.addresses ?? []).length === 0 ? (
              <p className="mc-muted">None saved.</p>
            ) : (
              <ul className="grid gap-2">
                {u.addresses.map((a: { id: string; label?: string; addressLine1?: string; city?: string }) => (
                  <li key={a.id}>
                    <span className="block mc-muted text-xs">{a.label}</span>
                    <span className="block">{[a.addressLine1, a.city].filter(Boolean).join(', ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
