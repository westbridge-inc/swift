'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveAdvertiser,
  approveCreative,
  fetchAdvertiserQueue,
  fetchCreativeQueue,
  reinstateAdvertiser,
  rejectAdvertiser,
  rejectCreative,
  suspendAdvertiser,
} from '@/lib/api';
import { MutationError } from '@/components/MutationError';

// ---------------------------------------------------------------------------
// Swift Ads has two gates, and until now neither had a human standing at it.
//
// An advertiser registers from the app and lands at PENDING_REVIEW. A creative
// uploads and lands at PENDING. `admin.routes.ts` has exposed both queues and
// every decision endpoint since the ads platform was built — and no admin page
// called any of them. So nobody could be approved, nothing could be published,
// and a revenue line that took sixteen PRs to build could not onboard a single
// customer. Approving an advertiser by hand in the database would not have
// helped either: their creatives would still have been stuck at the second
// gate.
//
// Both gates are here. They are separate tabs because they are separate
// decisions about separate things — a trustworthy company can still submit an
// unusable image.
// ---------------------------------------------------------------------------

type Tab = 'advertisers' | 'creatives';

const ADVERTISER_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'] as const;
type AdvertiserStatus = (typeof ADVERTISER_STATUSES)[number];

// Mirrors CREATIVE_REJECT_REASONS in the ads service. The route validates
// against that enum, so a free-text reason would be refused at the moment a
// reviewer tries to turn something down.
const CREATIVE_REJECT_REASONS = [
  'BLURRY_LOW_QUALITY', 'MISLEADING_CLAIM', 'WRONG_DIMENSIONS', 'TEXT_UNREADABLE',
  'RESTRICTED_CATEGORY', 'OFFENSIVE_CONTENT', 'LANDING_PAGE_BROKEN', 'LANDING_PAGE_MISMATCH',
  'COMPETITOR_PLATFORM', 'OTHER',
] as const;

export default function AdsReviewPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('advertisers');
  const [status, setStatus] = useState<AdvertiserStatus>('PENDING_REVIEW');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [creativeReason, setCreativeReason] = useState<string>(CREATIVE_REJECT_REASONS[0]);
  const [notes, setNotes] = useState('');
  const [mutationError, setMutationError] = useState<unknown>(null);

  const advertisers = useQuery({
    queryKey: ['ads', 'advertisers', status],
    queryFn: () => fetchAdvertiserQueue(status),
  });
  const creatives = useQuery({ queryKey: ['ads', 'creatives'], queryFn: () => fetchCreativeQueue() });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['ads'] });
    setActiveId(null);
    setReason('');
    setNotes('');
    setMutationError(null);
  };
  const onError = (e: unknown) => setMutationError(e);

  const advertiserAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' | 'suspend' | 'reinstate' }) => {
      if (action === 'approve') return approveAdvertiser(id);
      if (action === 'reinstate') return reinstateAdvertiser(id);
      if (action === 'reject') return rejectAdvertiser(id, reason.trim());
      return suspendAdvertiser(id, reason.trim());
    },
    onMutate: () => setMutationError(null),
    onError,
    onSuccess: refresh,
  });

  const creativeAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' }) =>
      action === 'approve' ? approveCreative(id) : rejectCreative(id, creativeReason, notes.trim() || undefined),
    onMutate: () => setMutationError(null),
    onError,
    onSuccess: refresh,
  });

  const advertiserRows: any[] = advertisers.data?.data ?? [];
  const creativeRows: any[] = creatives.data?.data ?? [];
  const busy = advertiserAction.isPending || creativeAction.isPending;
  // The route demands 3+ characters; disabling here rather than letting the
  // reviewer discover it as a 400 after typing a decision.
  const reasonReady = reason.trim().length >= 3;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Ads Review</h1>
      <p className="text-[var(--muted)] mb-6 text-sm">
        Two gates on the same path: a company has to be approved before it can book anything, and
        each creative has to be approved before it can be shown. Both queues are worked oldest
        first.
      </p>

      <div className="flex gap-2 mb-4">
        <button
          onClick={() => { setTab('advertisers'); setActiveId(null); setMutationError(null); }}
          className={`px-3 py-1.5 rounded-lg text-xs ${tab === 'advertisers' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--panel)] text-[var(--muted)] border border-[var(--border)]'}`}
        >
          Advertisers ({advertiserRows.length})
        </button>
        <button
          onClick={() => { setTab('creatives'); setActiveId(null); setMutationError(null); }}
          className={`px-3 py-1.5 rounded-lg text-xs ${tab === 'creatives' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--panel)] text-[var(--muted)] border border-[var(--border)]'}`}
        >
          Creatives ({creativeRows.length})
        </button>
      </div>

      {mutationError ? <MutationError error={mutationError} label="ads review decision" /> : null}

      {tab === 'advertisers' ? (
        <div>
          <div className="flex gap-2 mb-3">
            {ADVERTISER_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => { setStatus(s); setActiveId(null); }}
                className={`px-3 py-1 rounded-lg text-[11px] ${status === s ? 'bg-[var(--accent)] text-white' : 'bg-[var(--panel)] text-[var(--muted)] border border-[var(--border)]'}`}
              >
                {s.replace('_', ' ')}
              </button>
            ))}
          </div>

          {advertisers.isLoading ? (
            <p className="text-[var(--muted)] text-sm">Loading…</p>
          ) : advertiserRows.length === 0 ? (
            <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-10 text-center text-[var(--muted)] text-sm">
              Nothing in {status.replace('_', ' ').toLowerCase()}.
            </div>
          ) : (
            <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] divide-y divide-[var(--border)]">
              {advertiserRows.map((a) => (
                <div key={a.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-1">
                      <p className="font-semibold text-sm">{a.companyName}</p>
                      <p className="text-[11px] text-[var(--muted)]">
                        {[a.industry, a.city, a.website].filter(Boolean).join(' · ')}
                      </p>
                      <p className="text-[11px] text-[var(--muted)] mt-1">
                        {[a.contactName, a.contactEmail, a.contactPhone].filter(Boolean).join(' · ')}
                      </p>
                      {a.legalName || a.registrationNo ? (
                        <p className="text-[11px] text-[var(--muted)] mt-1">
                          {[a.legalName, a.registrationNo].filter(Boolean).join(' · ')}
                        </p>
                      ) : (
                        <p className="text-[11px] text-yellow-400 mt-1">
                          No legal name or registration number given
                        </p>
                      )}
                    </div>
                    <span className="text-[11px] text-[var(--muted)]">
                      {new Date(a.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  {a.statusReason ? (
                    <p className="text-[11px] text-[var(--muted)] mt-2">Last decision: {a.statusReason}</p>
                  ) : null}

                  {activeId === a.id ? (
                    <div className="mt-3 space-y-2">
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Why? The advertiser is told this."
                        className="w-full text-sm bg-[var(--bg)] border border-[var(--border)] rounded-lg p-2"
                      />
                      <div className="flex gap-2">
                        <button
                          disabled={busy || !reasonReady}
                          onClick={() => advertiserAction.mutate({ id: a.id, action: status === 'APPROVED' ? 'suspend' : 'reject' })}
                          className="px-3 py-1.5 rounded-lg text-xs bg-red-500/20 text-red-400 disabled:opacity-50"
                        >
                          {status === 'APPROVED' ? 'Suspend' : 'Reject'}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => { setActiveId(null); setReason(''); }}
                          className="px-3 py-1.5 rounded-lg text-xs text-[var(--muted)]"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2 mt-3">
                      {status === 'PENDING_REVIEW' || status === 'SUSPENDED' ? (
                        <button
                          disabled={busy}
                          onClick={() => advertiserAction.mutate({ id: a.id, action: 'approve' })}
                          className="px-3 py-1.5 rounded-lg text-xs bg-green-500/20 text-green-400 disabled:opacity-50"
                        >
                          Approve
                        </button>
                      ) : null}
                      {status === 'REJECTED' || status === 'SUSPENDED' ? (
                        <button
                          disabled={busy}
                          onClick={() => advertiserAction.mutate({ id: a.id, action: 'reinstate' })}
                          className="px-3 py-1.5 rounded-lg text-xs bg-[var(--bg)] border border-[var(--border)] disabled:opacity-50"
                        >
                          Reinstate
                        </button>
                      ) : null}
                      {status === 'PENDING_REVIEW' || status === 'APPROVED' ? (
                        <button
                          disabled={busy}
                          onClick={() => { setActiveId(a.id); setReason(''); setMutationError(null); }}
                          className="px-3 py-1.5 rounded-lg text-xs bg-[var(--bg)] border border-[var(--border)] disabled:opacity-50"
                        >
                          {status === 'APPROVED' ? 'Suspend…' : 'Reject…'}
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div>
          <p className="text-[var(--muted)] text-xs mb-3">
            Videos only appear here once transcoding has finished, so what you see is what will
            run. Approving publishes it; rejecting sends the advertiser a specific reason.
          </p>
          {creatives.isLoading ? (
            <p className="text-[var(--muted)] text-sm">Loading…</p>
          ) : creativeRows.length === 0 ? (
            <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-10 text-center text-[var(--muted)] text-sm">
              No creatives waiting for review.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {creativeRows.map((c) => (
                <div key={c.id} className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-4">
                  <div className="flex gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.posterUrl || c.fileUrl}
                      alt={c.headline || 'Ad creative'}
                      className="w-32 h-20 object-cover rounded-lg border border-[var(--border)]"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{c.headline || 'No headline'}</p>
                      <p className="text-[11px] text-[var(--muted)] line-clamp-2">{c.body || 'No body copy'}</p>
                      <p className="text-[11px] text-[var(--muted)] mt-1">
                        {[c.kind, c.width && c.height ? `${c.width}×${c.height}` : null, c.ctaLabel].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  </div>

                  {c.preScreen ? (
                    <p className="text-[11px] text-yellow-400 mt-2">
                      Pre-screen flagged something — advisory only, it does not decide:{' '}
                      {typeof c.preScreen === 'string' ? c.preScreen : JSON.stringify(c.preScreen)}
                    </p>
                  ) : null}

                  {activeId === c.id ? (
                    <div className="mt-3 space-y-2">
                      <select
                        value={creativeReason}
                        onChange={(e) => setCreativeReason(e.target.value)}
                        aria-label="Rejection reason"
                        className="w-full text-sm bg-[var(--bg)] border border-[var(--border)] rounded-lg p-2"
                      >
                        {CREATIVE_REJECT_REASONS.map((r) => (
                          <option key={r} value={r}>{r.replaceAll('_', ' ').toLowerCase()}</option>
                        ))}
                      </select>
                      <input
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Anything else they should know (optional)"
                        className="w-full text-sm bg-[var(--bg)] border border-[var(--border)] rounded-lg p-2"
                      />
                      <div className="flex gap-2">
                        <button
                          disabled={busy}
                          onClick={() => creativeAction.mutate({ id: c.id, action: 'reject' })}
                          className="px-3 py-1.5 rounded-lg text-xs bg-red-500/20 text-red-400 disabled:opacity-50"
                        >
                          Reject creative
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => { setActiveId(null); setNotes(''); }}
                          className="px-3 py-1.5 rounded-lg text-xs text-[var(--muted)]"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2 mt-3">
                      <button
                        disabled={busy}
                        onClick={() => creativeAction.mutate({ id: c.id, action: 'approve' })}
                        className="px-3 py-1.5 rounded-lg text-xs bg-green-500/20 text-green-400 disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => { setActiveId(c.id); setNotes(''); setCreativeReason(CREATIVE_REJECT_REASONS[0]); setMutationError(null); }}
                        className="px-3 py-1.5 rounded-lg text-xs bg-[var(--bg)] border border-[var(--border)] disabled:opacity-50"
                      >
                        Reject…
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
