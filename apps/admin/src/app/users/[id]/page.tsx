'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchUserDetail, suspendUser, unsuspendUser, banUser } from '@/lib/api';
import { Section, Row, StatusPill, BackLink, ActionButton, gyd } from '@/components/detail';
import { statusClass } from '@/lib/status';

export default function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['user', id], queryFn: () => fetchUserDetail(id) });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['user', id] });
    qc.invalidateQueries({ queryKey: ['users'] });
  };
  const suspend = useMutation({ mutationFn: () => suspendUser(id, 'Suspended by admin'), onSuccess: invalidate });
  const unsuspend = useMutation({ mutationFn: () => unsuspendUser(id), onSuccess: invalidate });
  const ban = useMutation({ mutationFn: () => banUser(id, 'Banned by admin'), onSuccess: invalidate });

  const u: any = data?.data;

  if (isLoading) return <div className="h-40 rounded-xl bg-[var(--panel)] border border-[var(--border)] animate-pulse" />;
  if (!u) {
    return (
      <div>
        <BackLink href="/users" label="Users" />
        <p className="text-[var(--muted)]">User not found.</p>
      </div>
    );
  }

  const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Unnamed';
  const busy = suspend.isPending || unsuspend.isPending || ban.isPending;

  return (
    <div>
      <BackLink href="/users" label="Users" />

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="w-12 h-12 rounded-full bg-[var(--accent)] flex items-center justify-center text-lg font-bold">
          {name.charAt(0).toUpperCase()}
        </div>
        <div>
          <h1 className="text-2xl font-bold">{name}</h1>
          <p className="text-sm text-[var(--muted)]">
            {u.phone}
            {u.email ? ` · ${u.email}` : ''}
          </p>
        </div>
        <StatusPill value={u.status} />
        <span className="px-2.5 py-1 rounded-full text-xs bg-white/10 text-[var(--muted)]">
          {(u.roles ?? []).join(' · ').toLowerCase()}
        </span>
        {u.trustLevel ? (
          <span className="px-2.5 py-1 rounded-full text-xs bg-sky-500/15 text-sky-400">trust {u.trustLevel}</span>
        ) : null}
        <div className="ml-auto flex gap-2">
          {u.status === 'SUSPENDED' ? (
            <ActionButton label="Unsuspend" confirm={`Unsuspend ${name}?`} onClick={() => unsuspend.mutate()} disabled={busy} />
          ) : u.status !== 'BANNED' ? (
            <ActionButton label="Suspend" confirm={`Suspend ${name}? They can't transact until unsuspended.`} onClick={() => suspend.mutate()} disabled={busy} />
          ) : null}
          {u.status !== 'BANNED' && (
            <ActionButton label="Ban" danger confirm={`Permanently BAN ${name}? This is not reversible from the console.`} onClick={() => ban.mutate()} disabled={busy} />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <Section title="Recent orders">
            {(u.orders ?? []).length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No orders.</p>
            ) : (
              <div className="space-y-2">
                {u.orders.map((o: any) => (
                  <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center gap-3 p-2.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-sm">
                    <span className="font-mono">{o.orderNumber}</span>
                    <span className="text-[var(--muted)] text-xs">{String(o.orderType).replaceAll('_', ' ').toLowerCase()}</span>
                    <span className={`ml-auto px-2 py-0.5 rounded-full text-xs ${statusClass(o.status)}`}>{o.status}</span>
                    <span className="font-medium">{gyd(o.totalAmount)}</span>
                  </Link>
                ))}
              </div>
            )}
          </Section>

          <Section title="Strikes">
            {(u.strikes ?? []).length === 0 ? (
              <p className="text-sm text-[var(--muted)]">Clean record — no strikes.</p>
            ) : (
              <div className="space-y-2">
                {u.strikes.map((s: any) => (
                  <div key={s.id} className="p-2.5 rounded-lg bg-red-500/5 border border-red-500/20 text-sm">
                    <p className="text-red-400">{String(s.reason).replaceAll('_', ' ')}</p>
                    <p className="text-xs text-[var(--muted)] mt-0.5">{new Date(s.createdAt).toLocaleString()}</p>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        <div className="space-y-4">
          <Section title="Profiles">
            <div className="space-y-2 text-sm">
              {u.rider ? (
                <Link href={`/riders/${u.rider.id}`} className="flex justify-between p-2.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
                  <span>Rider profile</span>
                  <span className="text-[var(--muted)]">{u.rider.documentsVerified ? 'verified' : 'unverified'} →</span>
                </Link>
              ) : null}
              {u.driver ? (
                <Link href={`/drivers/${u.driver.id}`} className="flex justify-between p-2.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
                  <span>Driver profile</span>
                  <span className="text-[var(--muted)]">{u.driver.documentsVerified ? 'verified' : 'unverified'} →</span>
                </Link>
              ) : null}
              {(u.vendorOwner?.vendors ?? []).map((v: any) => (
                <Link key={v.id} href={`/vendors/${v.id}`} className="flex justify-between p-2.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
                  <span>{v.name}</span>
                  <span className="text-[var(--muted)]">{String(v.status).toLowerCase().replaceAll('_', ' ')} →</span>
                </Link>
              ))}
              {!u.rider && !u.driver && (u.vendorOwner?.vendors ?? []).length === 0 && (
                <p className="text-[var(--muted)]">Customer only.</p>
              )}
            </div>
          </Section>

          <Section title="Account">
            <div className="space-y-1.5">
              <Row label="Joined" value={new Date(u.createdAt).toLocaleDateString()} />
              <Row label="Phone verified" value={u.isPhoneVerified ? 'yes' : 'no'} />
              <Row label="Total orders" value={u._count?.orders} />
              <Row label="Strikes" value={u._count?.strikes} />
              <Row label="Last active" value={u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleString() : '—'} />
            </div>
          </Section>

          <Section title="Addresses">
            {(u.addresses ?? []).length === 0 ? (
              <p className="text-sm text-[var(--muted)]">None saved.</p>
            ) : (
              <div className="space-y-2 text-sm">
                {u.addresses.map((a: any) => (
                  <div key={a.id} className="p-2.5 rounded-lg bg-white/5">
                    <p className="text-xs text-[var(--muted)]">{a.label}</p>
                    <p>{[a.addressLine1, a.city].filter(Boolean).join(', ')}</p>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
