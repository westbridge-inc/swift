'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { setSelectedStore } from '@/lib/auth';
import { getHours, getStores, money, type Store } from '@/lib/vendor-api';
import { getAllBranchOrders, getStoresSummary, putHoursAt, toggleOrdersAt } from '@/lib/branches-api';
import { storeKey, switchStore, useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';
import { normalizeHours, timeAgo } from '@/lib/vendor-hub';
import { BUCKETS, bucketFor } from '@/lib/order-buckets';
import { branchLabel, branchOutcomeWords, forEachBranch, isAwaitingApproval } from '@/lib/branches';
import { waitingFor } from '@/lib/branch-label';
import { ownerSteps } from '@/lib/branch-go-live';
import { DataUnavailable } from '@/components/data-unavailable';

const LANE_WORDS = new Map(BUCKETS.map((b) => [b.key, b.label]));

/**
 * [CHAINS PR2 · owner 29 Oct 2026] Branches: one owner, many stores, on one page.
 *  - each branch's orders and money today, over 7 and 30 days, and all branches together (GET /stores/summary: an
 *    owner sees every branch, a manager the branches they manage);
 *  - every branch's open orders on one board (GET /orders?scope=all), each naming its branch; opening one switches
 *    to that branch's own board, where its actions are;
 *  - pause or take orders, and copy one branch's hours, across the branches ticked here: one request per branch over
 *    that branch's own route (each branch's own checks apply), then which ones did not go through and why.
 * A branch waiting for Swift's approval says so — and [REVIEW-F #2220 S3-1] only then: a branch still waiting for its
 * OWNER is listed under "Not live yet" with the owner's steps and a button to where each is done. The owner adds a
 * branch from here.
 */
export default function BranchesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  const { role, manager, known } = useStoreRole();
  const stores = useQuery({ queryKey: ['stores'], queryFn: getStores });
  const list: Store[] = useMemo(() => stores.data?.stores ?? [], [stores.data?.stores]);
  const nameOf = (id: string) => list.find((s) => s.id === id)?.name ?? 'A branch';
  const summary = useQuery({ queryKey: storeKey(storeId, 'branches-summary'), queryFn: getStoresSummary, enabled: manager, refetchInterval: 60_000 });
  const board = useQuery({ queryKey: storeKey(storeId, 'branches-orders'), queryFn: () => getAllBranchOrders(100), enabled: manager && list.length > 1, refetchInterval: 15_000 });
  const open = (board.data ?? []).filter((o) => { const lane = bucketFor(o.status); return lane !== 'done'; });

  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const tick = (id: string, on: boolean) => setTicked((t) => { const n = new Set(t); if (on) n.add(id); else n.delete(id); return n; });
  // [REVIEW-F #2220 N1] Bulk actions are for branches that are live (a waiting branch takes no orders yet).
  const live = list.filter((s) => !isAwaitingApproval(s));
  const chosen = live.filter((s) => ticked.has(s.id)).map((s) => s.id);
  const notLive = list.filter((s) => isAwaitingApproval(s));

  const run = async (label: string, act: (_id: string) => Promise<unknown>, ids = chosen) => {
    if (ids.length === 0 || busy) return;
    setBusy(label);
    setReport(null);
    const result = await forEachBranch(ids, act);
    setReport(branchOutcomeWords(result, nameOf));
    setBusy(null);
    void queryClient.invalidateQueries({ queryKey: ['stores'] });
    void queryClient.invalidateQueries({ queryKey: storeKey(storeId) });
  };
  const copyHours = async () => {
    const targets = chosen.filter((id) => id !== storeId);
    if (targets.length === 0 || busy) return;
    setBusy('hours');
    setReport(null);
    let rows;
    try {
      rows = normalizeHours(await getHours());
    } catch (e) {
      setBusy(null);
      setReport(e instanceof Error && e.message ? e.message : 'Couldn’t read this branch’s hours. Try again.');
      return;
    }
    if (rows.length === 0) { setBusy(null); setReport('This branch has no hours set yet. Set them in Account first.'); return; }
    setBusy(null);
    const hours = rows.map((r) => (r.isClosed ? { dayOfWeek: r.dayOfWeek, isClosed: true } : { dayOfWeek: r.dayOfWeek, openTime: r.openTime, closeTime: r.closeTime, isClosed: false }));
    await run('hours', (id) => putHoursAt(id, hours), targets);
  };
  const openBranchBoard = async (id: string) => {
    if (id !== storeId) {
      const switched = await switchStore(queryClient, {
        from: storeId, to: id, commit: setSelectedStore,
        confirmDiscard: (ids) => window.confirm(`You have unsaved changes (${ids.join(', ')}). Switching stores discards them. Switch anyway?`),
      });
      if (!switched) return;
    }
    router.push('/dashboard/orders');
  };
  /** [REVIEW-F #2220 S3-1] Open the branch's own Settings, where its number customers can call and its food handlers tick are given. */
  const finishAt = async (id: string) => {
    if (id !== storeId) {
      const switched = await switchStore(queryClient, {
        from: storeId, to: id, commit: setSelectedStore,
        confirmDiscard: (ids) => window.confirm(`You have unsaved changes (${ids.join(', ')}). Switching stores discards them. Switch anyway?`),
      });
      if (!switched) return;
    }
    router.push('/dashboard/settings');
  };

  const current = list.find((s) => s.id === storeId);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {/* [REVIEW-F #2220 S4-2] A team member may work at stores of different businesses: only an owner's list is one business. */}
          <p className="sw-caption font-semibold uppercase tracking-wide text-[var(--swift-red)]">{role === 'OWNER' ? 'One business · ' : ''}{list.length} {list.length === 1 ? 'store' : 'stores'}</p>
          <h1 className="sw-title">Branches</h1>
        </div>
        {role === 'OWNER' && <Link href="/dashboard/branches/add" className="sw-btn sw-btn-md">Add a branch</Link>}
      </div>
      {known && !manager && <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">Branches are for the store&apos;s owner and managers.</p>}
      {stores.isError && <DataUnavailable what="your branches" error={stores.error} onRetry={() => void stores.refetch()} />}

      {role === 'OWNER' && notLive.length > 0 && (
        <section aria-labelledby="branches-waiting" className="sw-card p-5">
          <h2 id="branches-waiting" className="text-base font-bold">Not live yet</h2>
          <ul className="mt-2 divide-y divide-[var(--swift-border)]">
            {notLive.map((s) => {
              const steps = ownerSteps(s);
              return (
                <li key={s.id} className="space-y-1 py-2 text-sm">
                  <p className="font-semibold">{branchLabel(s)}</p>
                  {steps.length > 0 && (
                    <ul className="list-disc pl-5 text-[var(--swift-muted)]">{steps.map((step) => <li key={step.words}>{step.words}</li>)}</ul>
                  )}
                  {waitingFor(s) === 'OWNER' && steps.some((step) => step.where === 'settings') && (
                    <button type="button" className="sw-chip" onClick={() => void finishAt(s.id)}>Finish in {s.name}&apos;s Settings</button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {manager && (
        <section aria-labelledby="branches-money" className="sw-card overflow-x-auto p-5">
          <h2 id="branches-money" className="text-base font-bold">Orders and money · GYD</h2>
          {summary.isLoading && <div role="status" className="sw-skeleton mt-3 h-24"><span className="sr-only">Loading your branches&apos; figures…</span></div>}
          {summary.isError && <DataUnavailable what="your branches' figures" error={summary.error} onRetry={() => void summary.refetch()} />}
          {summary.data && (
            <table className="mt-3 w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs text-[var(--swift-muted)]">
                <tr><th className="py-2">Branch</th><th>Today</th><th>7 days</th><th>30 days</th><th>Waiting now</th></tr>
              </thead>
              <tbody>
                {summary.data.branches.map((b) => {
                  const store = list.find((s) => s.id === b.vendorId);
                  return (
                    <tr key={b.vendorId} className="border-t border-[var(--swift-border)]">
                      <td className="py-2 font-semibold">{store ? branchLabel(store) : b.name}</td>
                      <td>{b.today.orders} · {money(b.today.revenue)}</td>
                      <td>{b.week.orders} · {money(b.week.revenue)}</td>
                      <td>{b.month.orders} · {money(b.month.revenue)}</td>
                      <td>{b.pendingOrders}</td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-[var(--swift-border)] font-bold">
                  <td className="py-2">All branches</td>
                  <td>{summary.data.total.today.orders} · {money(summary.data.total.today.revenue)}</td>
                  <td>{summary.data.total.week.orders} · {money(summary.data.total.week.revenue)}</td>
                  <td>{summary.data.total.month.orders} · {money(summary.data.total.month.revenue)}</td>
                  <td>{summary.data.total.pendingOrders}</td>
                </tr>
              </tbody>
            </table>
          )}
        </section>
      )}

      {manager && list.length > 1 && (
        <section aria-labelledby="branches-board" className="sw-card p-5">
          <h2 id="branches-board" className="text-base font-bold">All branches&apos; open orders</h2>
          {board.isError ? <DataUnavailable what="your branches' orders" error={board.error} onRetry={() => void board.refetch()} />
            : !board.isSuccess ? <div role="status" className="sw-skeleton mt-3 h-16"><span className="sr-only">Loading your branches&apos; orders…</span></div>
              : open.length === 0 ? <p className="mt-2 text-sm text-[var(--swift-muted)]">No open orders at any branch.</p>
                : (
                  <ul className="mt-3 divide-y divide-[var(--swift-border)]">
                    {open.map((o) => (
                      <li key={o.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                        <span className="font-semibold">#{o.orderNumber}</span>
                        <span className="text-[var(--swift-muted)]">{o.vendor?.name ?? 'A branch'}</span>
                        <span className="sw-chip">{LANE_WORDS.get(bucketFor(o.status)) ?? 'Unrecognised'}</span>
                        <span>{money(o.totalAmount)}</span>
                        <span className="text-xs text-[var(--swift-muted)]">{timeAgo(o.placedAt)}</span>
                        {o.vendor?.id && (
                          <button type="button" className="ml-auto text-sm font-semibold text-[var(--swift-red)]" onClick={() => void openBranchBoard(o.vendor!.id)}>
                            Open {o.vendor.name}&apos;s orders
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
        </section>
      )}

      {manager && live.length > 1 && (
        <section aria-labelledby="branches-bulk" className="sw-card p-5">
          <h2 id="branches-bulk" className="text-base font-bold">Several branches at once</h2>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">Tick the branches, then choose what to do. Each branch is changed on its own; any that can&apos;t be changed are named with the reason.</p>
          <ul className="mt-3 space-y-2">
            {live.map((s) => (
              <li key={s.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--swift-red)]" checked={ticked.has(s.id)} onChange={(e) => tick(s.id, e.target.checked)} />
                  <span className="font-semibold">{s.name}</span>
                  <span className="text-xs text-[var(--swift-muted)]">{s.acceptingOrders ? 'Taking orders' : 'Orders paused'}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="sw-chip" disabled={!chosen.length || !!busy} onClick={() => void run('pause', (id) => toggleOrdersAt(id, false))}>
              {busy === 'pause' ? 'Pausing…' : 'Pause orders'}
            </button>
            <button type="button" className="sw-chip" disabled={!chosen.length || !!busy} onClick={() => void run('take', (id) => toggleOrdersAt(id, true))}>
              {busy === 'take' ? 'Turning orders on…' : 'Take orders'}
            </button>
            <button type="button" className="sw-chip" disabled={!chosen.some((id) => id !== storeId) || !!busy} onClick={() => void copyHours()}>
              {busy === 'hours' ? 'Copying hours…' : `Copy ${current?.name ?? 'this branch'}’s hours to the ticked branches`}
            </button>
          </div>
          {report && <p role="status" className="mt-3 text-sm font-semibold">{report}</p>}
        </section>
      )}
    </div>
  );
}
