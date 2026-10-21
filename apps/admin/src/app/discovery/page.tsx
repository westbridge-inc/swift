'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CATEGORY_ICON_OPTIONS } from '@swift/types';
import {
  approveDiscoveryRequest,
  fetchDiscoveryCategories,
  fetchDiscoveryRequests,
  mapDiscoveryRequest,
  mergeDiscoveryCategory,
  rejectDiscoveryRequest,
  runDiscoveryBackfill,
  updateDiscoveryCategory,
  type DiscoveryCategory,
  type DiscoveryRequest,
} from '@/lib/api';
import { MutationError } from '@/components/MutationError';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { QueryFailed } from '@/components/mc/QueryFailed';

// ---------------------------------------------------------------------------
// The taxonomy, and the two decisions nobody could make.
//
// Category discovery shipped complete: the taxonomy, the matcher, the AI
// classifier, derivation, governance and a backfill movement, all tested. Eight
// admin routes expose it. `git grep discovery apps/admin/src` returned NOTHING,
// so every one of them was unreachable.
//
// That is measurable, not theoretical. On this platform 1 of 57 live retail
// items carries a discovery tag — because the backfill that would tag them is
// admin-triggered, and no admin could trigger it. Meanwhile vendors can request
// a category from their dashboard and those requests landed in a queue with
// nobody standing at it.
//
// Two tabs, because they are two different jobs. The taxonomy is a standing
// thing you curate; requests are a queue you clear.
// ---------------------------------------------------------------------------

type Tab = 'categories' | 'requests';

const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'MERGED', 'REJECTED'] as const;
type RequestStatus = (typeof REQUEST_STATUSES)[number];

// The route validates against these enums. Offering free text would mean a
// reviewer types something reasonable and is refused at the moment they act.
/** The icon a category row shows: its chosen app icon, else the app's own by-slug choice. */
function iconLabel(key: string | null): string {
  return CATEGORY_ICON_OPTIONS.find((o) => o.key === key)?.label ?? 'App default';
}

const KINDS = ['CUISINE', 'DISH', 'DIETARY', 'AISLE', 'RETAIL'] as const;
const VERTICALS = ['FOOD', 'GROCERY', 'RETAIL'] as const;

export default function DiscoveryPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('requests');
  const [status, setStatus] = useState<RequestStatus>('PENDING');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [iconKey, setIconKey] = useState('');
  const [kind, setKind] = useState<string>(KINDS[0]);
  const [vertical, setVertical] = useState<string>(VERTICALS[0]);
  const [mapTarget, setMapTarget] = useState('');
  const [reason, setReason] = useState('');
  const [mutationError, setMutationError] = useState<unknown>(null);
  const [backfillNote, setBackfillNote] = useState<string | null>(null);

  const categories = useQuery({ queryKey: ['discovery', 'categories'], queryFn: fetchDiscoveryCategories });
  const requests = useQuery({
    queryKey: ['discovery', 'requests', status],
    queryFn: () => fetchDiscoveryRequests(status),
  });

  const cats: DiscoveryCategory[] = categories.data?.data ?? [];
  const rows: DiscoveryRequest[] = requests.data?.data ?? [];

  const done = () => {
    setActiveId(null); setIconKey(''); setReason(''); setMapTarget('');
    queryClient.invalidateQueries({ queryKey: ['discovery'] });
  };
  const approve = useMutation({
    mutationFn: (id: string) => approveDiscoveryRequest(id, { iconKey, kind, vertical }),
    onSuccess: done, onError: setMutationError,
  });
  const mapTo = useMutation({
    mutationFn: (id: string) => mapDiscoveryRequest(id, mapTarget),
    onSuccess: done, onError: setMutationError,
  });
  const reject = useMutation({
    mutationFn: (id: string) => rejectDiscoveryRequest(id, reason.trim()),
    onSuccess: done, onError: setMutationError,
  });
  // [U60] Hiding a category takes it away from every customer, and merging is
  // permanent. The status used to BE the toggle (one click hid it, no busy
  // guard); now the status is a label and each act is confirmed in the panel,
  // which runs it once and keeps a refusal in view.
  const dialog = useActionDialog();
  const actions = useActionRunner(done);
  const toggleVisibility = (c: DiscoveryCategory) => {
    const hide = c.status === 'ACTIVE';
    void actions.run({
      title: hide ? `Hide ${c.name} from customers?` : `Show ${c.name} to customers again?`,
      body: hide
        ? <p>Customers stop seeing it at once. Nothing is deleted; you can show it again.</p>
        : <p>Customers see it again at once.</p>,
      reason: false,
      confirmLabel: hide ? 'Hide category' : 'Show category',
      submit: () => updateDiscoveryCategory(c.id, { status: hide ? 'HIDDEN' : 'ACTIVE' }),
      success: () => (hide ? `${c.name} is hidden from customers.` : `${c.name} is visible to customers.`),
    });
  };
  const merge = (c: DiscoveryCategory, target: DiscoveryCategory) => void actions.run({
    title: `Merge ${c.name} into ${target.name}?`,
    body: <p>This is permanent: {c.name} redirects to {target.name}, and its old slug keeps resolving.</p>,
    confirmLabel: 'Merge category',
    submit: ({ reason }) => mergeDiscoveryCategory(c.id, target.id, reason),
    success: () => `${c.name} now redirects to ${target.name}.`,
  });
  const backfill = useMutation({
    mutationFn: runDiscoveryBackfill,
    onSuccess: () => {
      setBackfillNote('Queued. It runs in the background and is idempotent — re-running writes nothing new and never re-notifies a vendor.');
      setMutationError(null);
    },
    onError: (e: unknown) => {
      // 503 QUEUES_OFF is a real operational state, not a fault to hide behind
      // "something went wrong": the worker fleet is not running, so nothing
      // would have processed the job anyway.
      const code = (e as { code?: string })?.code;
      setBackfillNote(
        code === 'QUEUES_OFF'
          ? 'Not queued — the background workers are not running, so nothing would process it. Start the worker fleet and try again.'
          : null,
      );
      if (code !== 'QUEUES_OFF') setMutationError(e);
    },
  });

  const tagged = cats.filter((c) => c.status === 'ACTIVE').length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Discovery</h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-500">
            The category taxonomy customers browse by, and the queue of categories vendors have asked for.
            {categories.isSuccess ? <>{' '}{tagged} of {cats.length} categories are visible to customers.</> : null}
          </p>
        </div>
        <div className="text-right">
          <button
            type="button"
            onClick={async () => {
              const go = await dialog.askWith({
                title: 'Run the discovery backfill?',
                body: <p>Existing items are matched against the taxonomy and suggested to their vendors for review. Re-running writes nothing new.</p>,
                reason: false,
                confirmLabel: 'Run the backfill',
              });
              if (go) backfill.mutate();
            }}
            disabled={backfill.isPending}
            className="rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {backfill.isPending ? 'Queueing…' : 'Run the backfill'}
          </button>
          <p className="mt-1 max-w-xs text-xs text-neutral-500">
            Tags existing items against the taxonomy. Items are suggested to their vendor for review,
            not tagged behind their back.
          </p>
          {backfillNote && <p className="mt-2 max-w-xs text-xs text-neutral-700">{backfillNote}</p>}
        </div>
      </header>

      <nav className="flex gap-2 border-b border-neutral-200">
        {(['requests', 'categories'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => { setTab(t); setActiveId(null); setMutationError(null); }}
            aria-pressed={tab === t}
            className={`px-3 py-2 text-sm ${tab === t ? 'border-b-2 border-neutral-900 font-medium' : 'text-neutral-500'}`}
          >
            {t === 'requests' ? 'Requests' : 'Taxonomy'}
          </button>
        ))}
      </nav>

      <MutationError error={mutationError} label="discovery action" />

      {tab === 'requests' ? (
        <section className="space-y-4">
          <div className="flex gap-2">
            {REQUEST_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                aria-pressed={status === s}
                className={`rounded px-2 py-1 text-xs ${status === s ? 'bg-neutral-900 text-white' : 'bg-neutral-100'}`}
              >
                {s}
              </button>
            ))}
          </div>

          {requests.isLoading ? <p className="text-sm text-neutral-500">Loading…</p> : null}
          {requests.isError ? (
            <QueryFailed error={requests.error} what="the category requests" onRetry={() => void requests.refetch()} retrying={requests.isFetching} />
          ) : null}
          {!requests.isLoading && !requests.isError && rows.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing in this queue.</p>
          ) : null}

          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={r.id} className="rounded border border-neutral-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{r.proposedName}</p>
                    <p className="text-xs text-neutral-500">
                      {r.vendorName ?? 'Vendor no longer on Swift'} · {new Date(r.createdAt).toLocaleDateString('en-GB')}
                    </p>
                    {r.note && <p className="mt-2 text-sm text-neutral-700">“{r.note}”</p>}
                    {r.resolutionNote && <p className="mt-2 text-xs text-neutral-500">Resolution: {r.resolutionNote}</p>}
                  </div>
                  {r.status === 'PENDING' && (
                    <button type="button" onClick={() => setActiveId(activeId === r.id ? null : r.id)} className="text-sm underline">
                      {activeId === r.id ? 'Close' : 'Decide'}
                    </button>
                  )}
                </div>

                {activeId === r.id && (
                  <div className="mt-4 space-y-4 border-t border-neutral-100 pt-4">
                    {/* MAP FIRST, deliberately. Most requests are a near-duplicate
                        of something that already exists, and every new slug is
                        permanent — mergedIntoId exists because a slug is never
                        edited afterwards. */}
                    <div>
                      <p className="text-sm font-medium">Map to an existing category</p>
                      <p className="text-xs text-neutral-500">The usual answer. Nothing new is minted and the vendor still gets what they asked for.</p>
                      <div className="mt-2 flex gap-2">
                        <select
                          value={mapTarget}
                          onChange={(e) => setMapTarget(e.target.value)}
                          aria-label="Existing category to map to"
                          className="rounded border border-neutral-300 px-2 py-1 text-sm"
                        >
                          <option value="">Choose a category…</option>
                          {cats.filter((c) => c.status === 'ACTIVE' && !c.mergedIntoId).map((c) => (
                            <option key={c.id} value={c.slug}>{c.name} ({c.slug})</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!mapTarget || mapTo.isPending}
                          onClick={() => mapTo.mutate(r.id)}
                          className="rounded bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-40"
                        >
                          Map
                        </button>
                      </div>
                    </div>

                    <div>
                      <p className="text-sm font-medium">Or create it as a new category</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {/* Owner 17 Oct: a category carries one of the app's icons,
                            never an emoji. The route refuses any key not on this list. */}
                        <select value={iconKey} onChange={(e) => setIconKey(e.target.value)} aria-label="Icon" className="rounded border border-neutral-300 px-2 py-1 text-sm">
                          <option value="">Choose an icon…</option>
                          {CATEGORY_ICON_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                        </select>
                        {/* Enums, never text: the route refuses anything else. */}
                        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind" className="rounded border border-neutral-300 px-2 py-1 text-sm">
                          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                        </select>
                        <select value={vertical} onChange={(e) => setVertical(e.target.value)} aria-label="Vertical" className="rounded border border-neutral-300 px-2 py-1 text-sm">
                          {VERTICALS.map((v) => <option key={v} value={v}>{v}</option>)}
                        </select>
                        <button
                          type="button"
                          disabled={!iconKey || approve.isPending}
                          onClick={() => approve.mutate(r.id)}
                          className="rounded bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-40"
                        >
                          Create
                        </button>
                      </div>
                      <p className="mt-1 text-xs text-neutral-500">The app draws the icon you choose. The button stays off until you choose one.</p>
                    </div>

                    <div>
                      <p className="text-sm font-medium">Or turn it down</p>
                      <p className="text-xs text-neutral-500">The vendor is shown this text verbatim, so write it to them.</p>
                      <div className="mt-2 flex gap-2">
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="Why not"
                          aria-label="Rejection reason"
                          maxLength={300}
                          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
                        />
                        <button
                          type="button"
                          disabled={reason.trim().length < 3 || reject.isPending}
                          onClick={() => reject.mutate(r.id)}
                          className="rounded border border-red-300 px-3 py-1 text-sm text-red-700 disabled:opacity-40"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="space-y-3">
          {categories.isLoading ? <p className="text-sm text-neutral-500">Loading…</p> : null}
          {actions.banner}
          {categories.isError ? (
            <QueryFailed error={categories.error} what="the categories" onRetry={() => void categories.refetch()} retrying={categories.isFetching} />
          ) : null}
          {categories.isSuccess && cats.length === 0 ? <p className="text-sm text-neutral-500">No categories yet.</p> : null}
          {categories.isSuccess && cats.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2">Category</th><th>Icon</th><th>Slug</th><th>Kind</th><th>Vertical</th>
                <th>Aliases</th><th>Visible</th><th />
              </tr>
            </thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.id} className="border-t border-neutral-100">
                  <td className="py-2">{c.name}</td>
                  <td className="text-neutral-500">{iconLabel(c.iconKey)}</td>
                  <td className="text-neutral-500">{c.slug}</td>
                  <td className="text-neutral-500">{c.kind}</td>
                  <td className="text-neutral-500">{c.vertical}</td>
                  <td className="text-neutral-500">{c.aliases.length}</td>
                  <td>
                    {c.mergedIntoId ? (
                      <span className="text-xs text-neutral-500">merged</span>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <span className={`rounded px-2 py-0.5 text-xs ${c.status === 'ACTIVE' ? 'bg-green-100 text-green-800' : 'bg-neutral-100 text-neutral-600'}`}>
                          {c.status === 'ACTIVE' ? 'Visible' : 'Hidden'}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleVisibility(c)}
                          aria-label={c.status === 'ACTIVE' ? `Hide ${c.name} from customers` : `Show ${c.name} to customers`}
                          className="rounded border border-neutral-300 px-2 py-0.5 text-xs"
                        >
                          {c.status === 'ACTIVE' ? 'Hide' : 'Show'}
                        </button>
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    {!c.mergedIntoId && (
                      <select
                        aria-label={`Merge ${c.name} into`}
                        value=""
                        onChange={(e) => {
                          const targetId = e.target.value;
                          if (!targetId) return;
                          const target = cats.find((o) => o.id === targetId);
                          if (target) merge(c, target);
                        }}
                        className="rounded border border-neutral-200 px-1 py-0.5 text-xs"
                      >
                        <option value="">Merge into…</option>
                        {cats.filter((o) => o.id !== c.id && !o.mergedIntoId).map((o) => (
                          <option key={o.id} value={o.id}>{o.name}</option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          ) : null}
          <p className="text-xs text-neutral-500">
            Hiding a category un-ships it without deleting anything. Merging redirects one into another and
            keeps the old slug resolving — which is why a slug is never edited in place.
          </p>
        </section>
      )}
    </div>
  );
}
