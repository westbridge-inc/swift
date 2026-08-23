'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MutationNotice } from '@/components/MutationNotice';
import { fetchVendorDetail, approveVendor, suspendVendor, featureVendor } from '@/lib/api';
import { Section, Row, StatusPill, BackLink, ActionButton, gyd } from '@/components/detail';
import { statusClass } from '@/lib/status';

export default function VendorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['vendor', id], queryFn: () => fetchVendorDetail(id) });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['vendor', id] });
    qc.invalidateQueries({ queryKey: ['vendors'] });
  };
  const approve = useMutation({ mutationFn: () => approveVendor(id), onSuccess: invalidate });
  const suspend = useMutation({ mutationFn: () => suspendVendor(id, 'Suspended by admin'), onSuccess: invalidate });
  const feature = useMutation({ mutationFn: (featured: boolean) => featureVendor(id, featured), onSuccess: invalidate });

  const v: any = data?.data;

  if (isLoading) return <div className="h-40 rounded-xl bg-[var(--panel)] border border-[var(--border)] animate-pulse" />;
  if (!v) {
    return (
      <div>
        <BackLink href="/vendors" label="Vendors" />
        <p className="text-[var(--muted)]">Vendor not found.</p>
      </div>
    );
  }

  const owner = v.owner?.user;
  const siblings = (v.owner?.vendors ?? []).filter((s: any) => s.id !== v.id);
  const sub = v.subscription;
  const busy = approve.isPending || suspend.isPending || feature.isPending;

  return (
    <div>
      <BackLink href="/vendors" label="Vendors" />

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">{v.name}</h1>
        <MutationNotice errors={[approve.error, suspend.error]} />
        <StatusPill value={v.status} />
        <span className="px-2.5 py-1 rounded-full text-xs bg-white/10 text-[var(--muted)]">{String(v.vendorType).toLowerCase()}</span>
        {v.isFeatured ? <span className="px-2.5 py-1 rounded-full text-xs bg-amber-500/15 text-amber-400">featured</span> : null}
        {v.acceptingOrders ? (
          <span className="px-2.5 py-1 rounded-full text-xs bg-emerald-500/15 text-emerald-400">accepting orders</span>
        ) : (
          <span className="px-2.5 py-1 rounded-full text-xs bg-white/10 text-[var(--muted)]">not accepting</span>
        )}
        <div className="ml-auto flex gap-2">
          {v.status === 'PENDING_APPROVAL' && (
            <ActionButton label="Approve" confirm={`Approve ${v.name}? Their 14-day trial starts now.`} onClick={() => approve.mutate()} disabled={busy} />
          )}
          <ActionButton
            label={v.isFeatured ? 'Unfeature' : 'Feature'}
            confirm={v.isFeatured ? `Remove ${v.name} from featured?` : `Feature ${v.name} on the home surface?`}
            onClick={() => feature.mutate(!v.isFeatured)}
            disabled={busy}
          />
          {v.status === 'ACTIVE' && (
            <ActionButton label="Suspend" danger confirm={`Suspend ${v.name}? They stop taking orders immediately.`} onClick={() => suspend.mutate()} disabled={busy} />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <Section title="Recent orders">
            {(v.recentOrders ?? []).length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No orders yet.</p>
            ) : (
              <div className="space-y-2">
                {v.recentOrders.map((o: any) => (
                  <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center gap-3 p-2.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-sm">
                    <span className="font-mono">{o.orderNumber}</span>
                    <span className="text-[var(--muted)] text-xs">{o.paymentMethod === 'MOBILE_MONEY' ? 'MMG' : 'cash'}</span>
                    <span className={`ml-auto px-2 py-0.5 rounded-full text-xs ${statusClass(o.status)}`}>{o.status}</span>
                    <span className="font-medium">{gyd(o.totalAmount)}</span>
                  </Link>
                ))}
              </div>
            )}
          </Section>

          {siblings.length > 0 && (
            <Section title="Other stores (same owner)">
              <div className="space-y-2 text-sm">
                {siblings.map((s: any) => (
                  <Link key={s.id} href={`/vendors/${s.id}`} className="flex justify-between p-2.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
                    <span>{s.name}</span>
                    <span className="text-[var(--muted)]">{String(s.status).toLowerCase().replaceAll('_', ' ')} →</span>
                  </Link>
                ))}
              </div>
            </Section>
          )}
        </div>

        <div className="space-y-4">
          <Section title="Owner">
            {owner ? (
              <div className="space-y-1.5">
                <Row label="Name" value={[owner.firstName, owner.lastName].filter(Boolean).join(' ')} href={`/users/${owner.id}`} />
                <Row label="Phone" value={owner.phone} />
                <Row label="Email" value={owner.email} />
                <Row label="Account" value={owner.status?.toLowerCase()} />
              </div>
            ) : (
              <p className="text-sm text-[var(--muted)]">—</p>
            )}
          </Section>

          <Section title="Subscription">
            {sub ? (
              <div className="space-y-1.5">
                <Row label="Status" value={<StatusPill value={sub.status} />} />
                <Row label="Weekly rate" value={gyd(sub.customRate ?? sub.weeklyRate)} />
                {sub.isTrialActive && sub.trialEndDate ? <Row label="Trial ends" value={new Date(sub.trialEndDate).toLocaleDateString()} /> : null}
                {sub.nextBillingDate ? <Row label="Next bill" value={new Date(sub.nextBillingDate).toLocaleDateString()} /> : null}
              </div>
            ) : (
              <p className="text-sm text-[var(--muted)]">No subscription yet (starts on approval).</p>
            )}
          </Section>

          <Section title="Store">
            <div className="space-y-1.5">
              <Row label="City" value={v.city} />
              <Row label="Address" value={v.addressLine1} />
              <Row label="Phone" value={v.phone} />
              <Row label="Rating" value={v.averageRating ? `${Number(v.averageRating).toFixed(1)} (${v.totalRatings ?? 0})` : '—'} />
              <Row label="Menu items" value={v._count?.items} />
              <Row label="Lifetime orders" value={v._count?.orders} />
              <Row label="MMG pay link" value={v.mmgPayUrl ? 'attached' : 'not attached'} />
              <Row label="Joined" value={new Date(v.createdAt).toLocaleDateString()} />
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
