'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { fetchIntegrityFlags, errorCode, type IntegrityFlag } from '@/lib/api';

/** [Integrity review · the algorithms' decision log]
 *
 *  Until this page, `GET /admin/integrity/flags` was an engine with no door —
 *  ALG-15 (GPS plausibility), ALG-30 (rider gaming) and ALG-34 (account
 *  takeover) writing rows nobody could read. Three laws govern the door:
 *
 *  - The SENTENCE is the interface. Each row's reviewer-facing prose renders
 *    VERBATIM. The `inputs` evidence Json — signal tokens and all — rides the
 *    wire but is never rendered, so detection tells can't leak into a
 *    screenshot.
 *  - [L3] Nothing here is a penalty button. The only action is "open the
 *    subject"; consequences, if any, happen on the subject's own page under
 *    its own rules.
 *  - The guard is the server's. platformControlGuard admits SUPER_ADMIN on the
 *    platform tenant only; a 403 here is rendered as that truth, not as a
 *    generic failure.
 */

/** The algorithms writing reviewable rows today. "All" omits the param. */
const ALGOS = ['ALG-15', 'ALG-30', 'ALG-34'] as const;
const SUBJECT_TYPES = ['ORDER', 'RIDER', 'DRIVER', 'VENDOR', 'CUSTOMER', 'ITEM'] as const;
const WINDOWS = [7, 30, 90] as const;

/** Where "open the subject" leads. ITEM has no admin detail page yet — its id
 *  is shown, never linked somewhere that pretends. */
const SUBJECT_HREF: Partial<Record<IntegrityFlag['subjectType'], (_id: string) => string>> = {
  ORDER: (id) => `/orders/${id}`,
  RIDER: (id) => `/riders/${id}`,
  DRIVER: (id) => `/drivers/${id}`,
  VENDOR: (id) => `/vendors/${id}`,
  CUSTOMER: (id) => `/users/${id}`,
};

/** Settled → green, waiting → yellow, needs-a-human → red. Outcomes are
 *  per-algorithm vocabulary; anything unrecognised reads as needs-a-human. */
function outcomeClass(outcome: string) {
  if (outcome === 'CLEARED' || outcome === 'APPLIED') return 'mc-badge mc-tone-good';
  if (outcome === 'STAGED' || outcome === 'UNCORROBORATED') return 'mc-badge mc-tone-warn';
  return 'mc-badge mc-tone-bad';
}

export default function IntegrityPage() {
  const [algo, setAlgo] = useState<string | null>(null);
  const [subjectType, setSubjectType] = useState<string | null>(null);
  const [days, setDays] = useState<number>(7);

  const { data, isLoading, error } = useQuery({
    queryKey: ['integrity-flags', algo, subjectType, days],
    queryFn: () =>
      fetchIntegrityFlags({
        ...(algo ? { algo } : {}),
        ...(subjectType ? { subjectType } : {}),
        days,
        limit: 50,
      }),
  });

  const flags: IntegrityFlag[] = data?.data?.flags ?? [];
  const windowDays: number = data?.data?.windowDays ?? days;
  const forbidden =
    errorCode(error) === 'FORBIDDEN' || (error as { status?: number } | null)?.status === 403;

  const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="mc-page">
      <p className="mc-muted mb-4 max-w-3xl">
        What the detection algorithms decided — every detection is one sentence written for a reviewer.
        Nothing on this page is a penalty button; review, then open the subject.
      </p>

      <div className="mc-card mb-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Algorithm">
          <span className="mc-label w-24">Algorithm</span>
          <button type="button" onClick={() => setAlgo(null)} aria-pressed={algo === null} className="mc-tab">All</button>
          {ALGOS.map((a) => (
            <button key={a} type="button" onClick={() => setAlgo(a)} aria-pressed={algo === a} className="mc-tab">{a}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Subject">
          <span className="mc-label w-24">Subject</span>
          <button type="button" onClick={() => setSubjectType(null)} aria-pressed={subjectType === null} className="mc-tab">All</button>
          {SUBJECT_TYPES.map((s) => (
            <button key={s} type="button" onClick={() => setSubjectType(s)} aria-pressed={subjectType === s} className="mc-tab">{s}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Window">
          <span className="mc-label w-24">Window</span>
          {WINDOWS.map((w) => (
            <button key={w} type="button" onClick={() => setDays(w)} aria-pressed={days === w} className="mc-tab">{w} days</button>
          ))}
        </div>
      </div>

      {forbidden ? (
        <div className="mc-note">
          This log is super-admin only — the server&apos;s platform guard said no, and this page
          believes it.
        </div>
      ) : error ? (
        <div className="mc-alert" role="alert">
          {(error as Error).message}
        </div>
      ) : (
        <>
          <p className="mc-muted mb-2 text-xs">
            {isLoading
              ? 'Loading…'
              : `${flags.length} flag${flags.length === 1 ? '' : 's'} · last ${windowDays} days · newest first · shadow runs are never listed here`}
          </p>
          <div className="mc-table-wrap overflow-x-auto">
            <table className="mc-table">
              <thead>
                <tr>
                  <th className="mc-label" style={{ width: '9rem' }}>When</th>
                  <th className="mc-label" style={{ width: '7rem' }}>Algorithm</th>
                  <th className="mc-label" style={{ width: '9rem' }}>Outcome</th>
                  <th className="mc-label">What happened</th>
                  <th className="mc-label" style={{ width: '16rem', textAlign: 'right' }}>Subject</th>
                </tr>
              </thead>
              <tbody>
                {flags.length === 0 && !isLoading ? (
                  <tr>
                    <td colSpan={5} className="mc-table-empty">
                      No flags in this window.
                    </td>
                  </tr>
                ) : (
                  flags.map((f) => {
                    const href = SUBJECT_HREF[f.subjectType]?.(f.subjectId);
                    return (
                      <tr key={f.id} className="align-top">
                        <td data-label="When" className="mc-muted mc-numbers">{when(f.createdAt)}</td>
                        <td data-label="Algorithm">
                          {f.algo}
                          <span className="mc-cell-sub">{f.configVersion}</span>
                        </td>
                        <td data-label="Outcome">
                          <span className={outcomeClass(f.outcome)}>{f.outcome.replaceAll('_', ' ')}</span>
                        </td>
                        {/* The sentence, VERBATIM — and only the sentence. f.inputs
                            (the evidence Json with its signal tokens) is never
                            rendered anywhere on this page, deliberately. */}
                        <td data-label="What happened" style={{ whiteSpace: 'normal' }}>{f.sentence}</td>
                        <td data-label="Subject" data-align="right">
                          <span className="mc-muted mr-2 text-xs">
                            {f.subjectType} · {f.subjectId.slice(0, 8)}…
                          </span>
                          {href ? (
                            <Link href={href} className="text-xs font-semibold underline underline-offset-2" style={{ color: 'var(--mc-accent)' }}>
                              Open the subject
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
