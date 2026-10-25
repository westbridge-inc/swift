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
import { reasonTooShort } from '@/lib/ask-reason';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { label } from '@/lib/labels';

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

const ADVERTISER_EMPTY: Record<AdvertiserStatus, string> = {
  PENDING_REVIEW: 'No advertisers waiting for review.',
  APPROVED: 'No approved advertisers.',
  REJECTED: 'No rejected advertisers.',
  SUSPENDED: 'No suspended advertisers.',
};

// Mirrors CREATIVE_REJECT_REASONS in the ads service. The route validates
// against that enum, so a free-text reason would be refused at the moment a
// reviewer tries to turn something down.
const CREATIVE_REJECT_REASONS = [
  'BLURRY_LOW_QUALITY', 'MISLEADING_CLAIM', 'WRONG_DIMENSIONS', 'TEXT_UNREADABLE',
  'RESTRICTED_CATEGORY', 'OFFENSIVE_CONTENT', 'LANDING_PAGE_BROKEN', 'LANDING_PAGE_MISMATCH',
  'COMPETITOR_PLATFORM', 'OTHER',
] as const;

// [ADMIN-UI] The reasons in plain words; the code is still what is sent.
const CREATIVE_REASON_WORDS: Record<(typeof CREATIVE_REJECT_REASONS)[number], string> = {
  BLURRY_LOW_QUALITY: 'Blurry or low quality',
  MISLEADING_CLAIM: 'Misleading claim',
  WRONG_DIMENSIONS: 'Wrong size',
  TEXT_UNREADABLE: 'Text hard to read',
  RESTRICTED_CATEGORY: 'Restricted product or service',
  OFFENSIVE_CONTENT: 'Offensive content',
  LANDING_PAGE_BROKEN: 'Link does not open',
  LANDING_PAGE_MISMATCH: 'Link does not match the ad',
  COMPETITOR_PLATFORM: 'Promotes a competing app',
  OTHER: 'Something else',
};

const CREATIVE_KIND_WORDS: Record<string, string> = { IMAGE: 'Image', VIDEO: 'Video' };

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export default function AdsReviewPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('advertisers');
  const [status, setStatus] = useState<AdvertiserStatus>('PENDING_REVIEW');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [creativeReason, setCreativeReason] = useState<string>(CREATIVE_REJECT_REASONS[0]);
  const [notes, setNotes] = useState('');
  const [mutationError, setMutationError] = useState<unknown>(null);
  // Reasons and confirmations are asked in the in-page panel, never a browser
  // prompt; each decision still runs once (buttons disabled while it runs).
  const dialog = useActionDialog();

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
    mutationFn: ({ id, action, reason: stated }: { id: string; action: 'approve' | 'reject' | 'suspend' | 'reinstate'; reason: string }) => {
      if (action === 'approve') return approveAdvertiser(id, stated);
      if (action === 'reinstate') return reinstateAdvertiser(id, stated);
      if (action === 'reject') return rejectAdvertiser(id, stated);
      return suspendAdvertiser(id, stated);
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
  // [DS110-14] The server floor is 12 characters, not 3 — a 3-character
  // answer passed this screen and 400'd at the gate.
  const reasonReady = !reasonTooShort(reason);

  return (
    <div className="mc-page">
      <div className="mc-tabs" role="group" aria-label="Queue">
        <button
          type="button"
          aria-pressed={tab === 'advertisers'}
          onClick={() => { setTab('advertisers'); setActiveId(null); setMutationError(null); }}
          className="mc-tab"
        >
          Advertisers ({advertisers.isSuccess ? advertiserRows.length : '—'})
        </button>
        <button
          type="button"
          aria-pressed={tab === 'creatives'}
          onClick={() => { setTab('creatives'); setActiveId(null); setMutationError(null); }}
          className="mc-tab"
        >
          Creatives ({creatives.isSuccess ? creativeRows.length : '—'})
        </button>
      </div>

      {mutationError ? <div className="mb-4"><MutationError error={mutationError} label="ads review decision" /></div> : null}

      {tab === 'advertisers' ? (
        <div>
          <div className="mc-tabs mc-tabs-sub" role="group" aria-label="Advertiser status">
            {ADVERTISER_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={status === s}
                onClick={() => { setStatus(s); setActiveId(null); }}
                className="mc-tab"
              >
                {label('AdvertiserStatus', s)}
              </button>
            ))}
          </div>

          {advertisers.isLoading ? (
            <div className="mc-loading" aria-busy="true">Loading advertisers…</div>
          ) : advertisers.isError ? (
            <QueryFailed error={advertisers.error} what="the advertisers" onRetry={() => void advertisers.refetch()} retrying={advertisers.isFetching} />
          ) : advertiserRows.length === 0 ? (
            <div className="mc-empty">{ADVERTISER_EMPTY[status]}</div>
          ) : (
            <ul className="mc-list" aria-label="Advertisers">
              {advertiserRows.map((a) => (
                <li key={a.id} className="mc-card">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="mc-card-title">{a.companyName}</p>
                      <p className="mc-muted text-xs">
                        {[a.industry, a.city, a.website].filter(Boolean).join(' · ')}
                      </p>
                      <p className="mc-muted text-xs mt-1">
                        {[a.contactName, a.contactEmail, a.contactPhone].filter(Boolean).join(' · ')}
                      </p>
                      {a.legalName || a.registrationNo ? (
                        <p className="mc-muted text-xs mt-1">
                          {[a.legalName, a.registrationNo].filter(Boolean).join(' · ')}
                        </p>
                      ) : (
                        <p className="mc-text-warn text-xs font-semibold mt-1">
                          No legal name or registration number given
                        </p>
                      )}
                    </div>
                    <span className="mc-muted text-xs whitespace-nowrap">
                      {shortDate(a.createdAt)}
                    </span>
                  </div>
                  {a.statusReason ? (
                    <p className="mc-note mt-2">Last decision: {a.statusReason}</p>
                  ) : null}

                  {activeId === a.id ? (
                    <div className="mt-3 grid gap-2">
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Why? The advertiser is told this."
                        aria-label="Reason the advertiser is told"
                        className="mc-input"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy || !reasonReady}
                          onClick={() => advertiserAction.mutate({ id: a.id, action: status === 'APPROVED' ? 'suspend' : 'reject', reason: reason.trim() })}
                          className="mc-btn mc-btn-danger"
                        >
                          {status === 'APPROVED' ? 'Suspend' : 'Reject'}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => { setActiveId(null); setReason(''); }}
                          className="mc-btn mc-btn-quiet"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mc-actions">
                      {status === 'PENDING_REVIEW' || status === 'SUSPENDED' ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={async () => { const stated = await dialog.ask({ action: 'approve this advertiser', subject: a.companyName }); if (stated) advertiserAction.mutate({ id: a.id, action: 'approve', reason: stated }); }}
                          className="mc-btn mc-btn-primary"
                        >
                          Approve
                        </button>
                      ) : null}
                      {status === 'REJECTED' || status === 'SUSPENDED' ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={async () => { const stated = await dialog.ask({ action: 'reinstate this advertiser', subject: a.companyName }); if (stated) advertiserAction.mutate({ id: a.id, action: 'reinstate', reason: stated }); }}
                          className="mc-btn"
                        >
                          Reinstate
                        </button>
                      ) : null}
                      {status === 'PENDING_REVIEW' || status === 'APPROVED' ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => { setActiveId(a.id); setReason(''); setMutationError(null); }}
                          className="mc-btn mc-btn-danger"
                        >
                          {status === 'APPROVED' ? 'Suspend…' : 'Reject…'}
                        </button>
                      ) : null}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div>
          <p className="mc-muted text-sm mb-3">
            Approving a creative lets it run; rejecting it tells the advertiser why.
          </p>
          {creatives.isLoading ? (
            <div className="mc-loading" aria-busy="true">Loading creatives…</div>
          ) : creatives.isError ? (
            <QueryFailed error={creatives.error} what="the creatives" onRetry={() => void creatives.refetch()} retrying={creatives.isFetching} />
          ) : creativeRows.length === 0 ? (
            <div className="mc-empty">No creatives waiting for review.</div>
          ) : (
            <ul className="mc-grid-2" aria-label="Creatives">
              {creativeRows.map((c) => (
                <li key={c.id} className="mc-card">
                  <div className="flex gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.posterUrl || c.fileUrl}
                      alt={c.headline || 'Ad creative'}
                      className="w-32 h-20 object-cover rounded-lg border border-[var(--mc-line)] shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="mc-card-title truncate">{c.headline || 'No headline'}</p>
                      <p className="mc-muted text-xs line-clamp-2">{c.body || 'No body copy'}</p>
                      <p className="mc-muted text-xs mt-1">
                        {[CREATIVE_KIND_WORDS[c.kind] ?? c.kind, c.width && c.height ? `${c.width}×${c.height}` : null, c.ctaLabel].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  </div>

                  {c.preScreen ? (
                    <p className="mc-note mc-note-warn mt-2">
                      The automatic check flagged something (advice only, you decide):{' '}
                      {typeof c.preScreen === 'string' ? c.preScreen : JSON.stringify(c.preScreen)}
                    </p>
                  ) : null}

                  {activeId === c.id ? (
                    <div className="mt-3 grid gap-2">
                      <select
                        value={creativeReason}
                        onChange={(e) => setCreativeReason(e.target.value)}
                        aria-label="Rejection reason"
                        className="mc-input"
                      >
                        {CREATIVE_REJECT_REASONS.map((r) => (
                          <option key={r} value={r}>{CREATIVE_REASON_WORDS[r]}</option>
                        ))}
                      </select>
                      <input
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Anything else they should know (optional)"
                        aria-label="Notes for the advertiser (optional)"
                        className="mc-input"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => creativeAction.mutate({ id: c.id, action: 'reject' })}
                          className="mc-btn mc-btn-danger"
                        >
                          Reject creative
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => { setActiveId(null); setNotes(''); }}
                          className="mc-btn mc-btn-quiet"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mc-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          const go = await dialog.askWith({
                            title: 'Approve this ad creative?',
                            body: <p>It can run as soon as ads are switched on and its campaign is live.</p>,
                            reason: false,
                            confirmLabel: 'Approve creative',
                          });
                          if (go) creativeAction.mutate({ id: c.id, action: 'approve' });
                        }}
                        className="mc-btn mc-btn-primary"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => { setActiveId(c.id); setNotes(''); setCreativeReason(CREATIVE_REJECT_REASONS[0]); setMutationError(null); }}
                        className="mc-btn mc-btn-danger"
                      >
                        Reject…
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
