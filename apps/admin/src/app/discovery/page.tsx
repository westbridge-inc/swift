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
import { humanise } from '@/lib/labels';

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
    <div className="mc-page space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <p className="mc-muted max-w-2xl">
          The categories customers browse by, and the queue of categories businesses have asked for.
          {categories.isSuccess ? <>{' '}{tagged} of {cats.length} categories are visible to customers.</> : null}
        </p>
        <div className="max-w-xs text-right">
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
            className="mc-btn"
          >
            {backfill.isPending ? 'Queueing…' : 'Run the backfill'}
          </button>
          <p className="mc-muted mt-1 text-xs">
            Matches existing items to the categories. Each match is suggested to the business for review,
            never tagged behind their back.
          </p>
          {backfillNote && <p className="mc-note mt-2 text-left text-xs">{backfillNote}</p>}
        </div>
      </header>

      <div className="mc-tabs" role="group" aria-label="Discovery">
        {(['requests', 'categories'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => { setTab(t); setActiveId(null); setMutationError(null); }}
            aria-pressed={tab === t}
            className="mc-tab"
          >
            {t === 'requests' ? 'Requests' : 'Taxonomy'}
          </button>
        ))}
      </div>

      <MutationError error={mutationError} label="discovery action" />

      {tab === 'requests' ? (
        <section className="space-y-3">
          <div className="mc-tabs mc-tabs-sub" role="group" aria-label="Request status">
            {REQUEST_STATUSES.map((s) => (
              <button key={s} type="button" onClick={() => setStatus(s)} aria-pressed={status === s} className="mc-tab">
                {humanise(s)}
              </button>
            ))}
          </div>

          {requests.isLoading ? <div className="mc-loading" aria-busy="true">Loading…</div> : null}
          {requests.isError ? (
            <QueryFailed error={requests.error} what="the category requests" onRetry={() => void requests.refetch()} retrying={requests.isFetching} />
          ) : null}
          {!requests.isLoading && !requests.isError && rows.length === 0 ? (
            <div className="mc-empty">Nothing in this queue.</div>
          ) : null}

          <ul className="mc-list">
            {rows.map((r) => (
              <li key={r.id} className="mc-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="mc-card-title">{r.proposedName}</p>
                    <p className="mc-muted text-xs">
                      {r.vendorName ?? 'Vendor no longer on Swift'} · {new Date(r.createdAt).toLocaleDateString('en-GB')}
                    </p>
                    {r.note && <p className="mt-2">“{r.note}”</p>}
                    {r.resolutionNote && <p className="mc-muted mt-2 text-xs">Resolution: {r.resolutionNote}</p>}
                  </div>
                  {r.status === 'PENDING' && (
                    <button type="button" onClick={() => setActiveId(activeId === r.id ? null : r.id)} aria-expanded={activeId === r.id} className="mc-btn">
                      {activeId === r.id ? 'Close' : 'Decide'}
                    </button>
                  )}
                </div>

                {activeId === r.id && (
                  <div className="mt-4 space-y-4 border-t border-[var(--mc-line)] pt-4">
                    {/* MAP FIRST, deliberately. Most requests are a near-duplicate
                        of something that already exists, and every new slug is
                        permanent — mergedIntoId exists because a slug is never
                        edited afterwards. */}
                    <div>
                      <p className="font-semibold">Map to an existing category</p>
                      <p className="mc-muted text-xs">The usual answer. Nothing new is made and the business still gets what they asked for.</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <select
                          value={mapTarget}
                          onChange={(e) => setMapTarget(e.target.value)}
                          aria-label="Existing category to map to"
                          className="mc-select"
                        >
                          <option value="">Choose a category…</option>
                          {cats.filter((c) => c.status === 'ACTIVE' && !c.mergedIntoId).map((c) => (
                            <option key={c.id} value={c.slug}>{c.name} ({c.slug})</option>
                          ))}
                        </select>
                        <button type="button" disabled={!mapTarget || mapTo.isPending} onClick={() => mapTo.mutate(r.id)} className="mc-btn mc-btn-primary">
                          Map
                        </button>
                      </div>
                    </div>

                    <div>
                      <p className="font-semibold">Or create it as a new category</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {/* Owner 17 Oct: a category carries one of the app's icons,
                            never an emoji. The route refuses any key not on this list. */}
                        <select value={iconKey} onChange={(e) => setIconKey(e.target.value)} aria-label="Icon" className="mc-select">
                          <option value="">Choose an icon…</option>
                          {CATEGORY_ICON_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                        </select>
                        {/* Enums, never text: the route refuses anything else. */}
                        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind" className="mc-select">
                          {KINDS.map((k) => <option key={k} value={k}>{humanise(k)}</option>)}
                        </select>
                        <select value={vertical} onChange={(e) => setVertical(e.target.value)} aria-label="Vertical" className="mc-select">
                          {VERTICALS.map((v) => <option key={v} value={v}>{humanise(v)}</option>)}
                        </select>
                        <button type="button" disabled={!iconKey || approve.isPending} onClick={() => approve.mutate(r.id)} className="mc-btn mc-btn-primary">
                          Create
                        </button>
                      </div>
                      <p className="mc-muted mt-1 text-xs">The app draws the icon you choose. The button stays off until you choose one.</p>
                    </div>

                    <div>
                      <p className="font-semibold">Or turn it down</p>
                      <p className="mc-muted text-xs">The business is shown this text word for word, so write it to them.</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="Why not"
                          aria-label="Rejection reason"
                          maxLength={300}
                          className="mc-input flex-1"
                        />
                        <button type="button" disabled={reason.trim().length < 3 || reject.isPending} onClick={() => reject.mutate(r.id)} className="mc-btn mc-btn-danger">
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
          {categories.isLoading ? <div className="mc-loading" aria-busy="true">Loading…</div> : null}
          {actions.banner}
          {categories.isError ? (
            <QueryFailed error={categories.error} what="the categories" onRetry={() => void categories.refetch()} retrying={categories.isFetching} />
          ) : null}
          {categories.isSuccess && cats.length === 0 ? <div className="mc-empty">No categories yet.</div> : null}
          {categories.isSuccess && cats.length > 0 ? (
          <div className="mc-table-wrap overflow-x-auto">
          <table className="mc-table" style={{ tableLayout: 'auto' }}>
            <thead>
              <tr>
                <th className="mc-label">Category</th><th className="mc-label">Icon</th><th className="mc-label">Slug</th><th className="mc-label">Kind</th><th className="mc-label">Vertical</th>
                <th className="mc-label">Aliases</th><th className="mc-label">Visible</th><th />
              </tr>
            </thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.id}>
                  <td data-label="Category" data-primary className="font-semibold">{c.name}</td>
                  <td data-label="Icon" className="mc-muted">{iconLabel(c.iconKey)}</td>
                  <td data-label="Slug" className="mc-muted mc-mono">{c.slug}</td>
                  <td data-label="Kind" className="mc-muted">{humanise(c.kind)}</td>
                  <td data-label="Vertical" className="mc-muted">{humanise(c.vertical)}</td>
                  <td data-label="Aliases" className="mc-muted mc-numbers">{c.aliases.length}</td>
                  <td data-label="Visible">
                    {c.mergedIntoId ? (
                      <span className="mc-muted text-xs">merged</span>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <span className={`mc-badge${c.status === 'ACTIVE' ? ' mc-tone-good' : ''}`}>
                          {c.status === 'ACTIVE' ? 'Visible' : 'Hidden'}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleVisibility(c)}
                          aria-label={c.status === 'ACTIVE' ? `Hide ${c.name} from customers` : `Show ${c.name} to customers`}
                          className="mc-btn"
                          style={{ minHeight: 36 }}
                        >
                          {c.status === 'ACTIVE' ? 'Hide' : 'Show'}
                        </button>
                      </span>
                    )}
                  </td>
                  <td data-align="right">
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
                        className="mc-select"
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
          </div>
          ) : null}
          <p className="mc-muted text-xs">
            Hiding a category takes it away from customers without deleting anything. Merging sends one into another and
            keeps the old address working — which is why a slug is never edited in place.
          </p>
        </section>
      )}
    </div>
  );
}
