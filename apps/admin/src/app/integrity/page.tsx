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
  if (outcome === 'CLEARED' || outcome === 'APPLIED') return 'bg-green-500/20 text-green-400';
  if (outcome === 'STAGED' || outcome === 'UNCORROBORATED') return 'bg-yellow-500/20 text-yellow-400';
  return 'bg-red-500/20 text-red-400';
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

  const chip = (active: boolean) =>
    `px-3 py-1.5 rounded-lg text-xs ${
      active
        ? 'bg-[var(--accent)] text-white'
        : 'bg-[var(--panel)] text-[var(--muted)] border border-[var(--border)]'
    }`;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Integrity</h1>
      <p className="text-[var(--muted)] mb-6 text-sm">
        The algorithms&apos; decision log — every detection is one reviewer-facing sentence.
        Nothing on this page is a penalty button; review, then open the subject.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-[10px] font-semibold tracking-widest text-[var(--muted)]/70 w-16">
          ALGORITHM
        </span>
        <button onClick={() => setAlgo(null)} className={chip(algo === null)}>
          All
        </button>
        {ALGOS.map((a) => (
          <button key={a} onClick={() => setAlgo(a)} className={chip(algo === a)}>
            {a}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-[10px] font-semibold tracking-widest text-[var(--muted)]/70 w-16">
          SUBJECT
        </span>
        <button onClick={() => setSubjectType(null)} className={chip(subjectType === null)}>
          All
        </button>
        {SUBJECT_TYPES.map((s) => (
          <button key={s} onClick={() => setSubjectType(s)} className={chip(subjectType === s)}>
            {s}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-[10px] font-semibold tracking-widest text-[var(--muted)]/70 w-16">
          WINDOW
        </span>
        {WINDOWS.map((w) => (
          <button key={w} onClick={() => setDays(w)} className={chip(days === w)}>
            {w} days
          </button>
        ))}
      </div>

      {forbidden ? (
        <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6 text-sm text-[var(--muted)]">
          This log is super-admin only — the server&apos;s platform guard said no, and this page
          believes it.
        </div>
      ) : error ? (
        <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6 text-sm text-red-400">
          {(error as Error).message}
        </div>
      ) : (
        <>
          <p className="text-xs text-[var(--muted)] mb-2">
            {isLoading
              ? 'Loading…'
              : `${flags.length} flag${flags.length === 1 ? '' : 's'} · last ${windowDays} days · newest first · shadow runs are never listed here`}
          </p>
          <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left p-4 text-[var(--muted)] font-medium">When</th>
                  <th className="text-left p-4 text-[var(--muted)] font-medium">Algorithm</th>
                  <th className="text-left p-4 text-[var(--muted)] font-medium">Outcome</th>
                  <th className="text-left p-4 text-[var(--muted)] font-medium w-1/2">
                    What happened
                  </th>
                  <th className="text-right p-4 text-[var(--muted)] font-medium">Subject</th>
                </tr>
              </thead>
              <tbody>
                {flags.length === 0 && !isLoading ? (
                  <tr>
                    <td colSpan={5} className="p-6 text-center text-[var(--muted)]">
                      No flags in this window.
                    </td>
                  </tr>
                ) : (
                  flags.map((f) => {
                    const href = SUBJECT_HREF[f.subjectType]?.(f.subjectId);
                    return (
                      <tr key={f.id} className="border-b border-[var(--border)] last:border-0 align-top">
                        <td className="p-4 whitespace-nowrap text-[var(--muted)]">
                          {new Date(f.createdAt).toLocaleString()}
                        </td>
                        <td className="p-4 whitespace-nowrap">
                          {f.algo}
                          <span className="block text-[10px] text-[var(--muted)]">
                            {f.configVersion}
                          </span>
                        </td>
                        <td className="p-4">
                          <span
                            className={`px-2 py-0.5 rounded text-xs whitespace-nowrap ${outcomeClass(f.outcome)}`}
                          >
                            {f.outcome.replaceAll('_', ' ')}
                          </span>
                        </td>
                        {/* The sentence, VERBATIM — and only the sentence. f.inputs
                            (the evidence Json with its signal tokens) is never
                            rendered anywhere on this page, deliberately. */}
                        <td className="p-4">{f.sentence}</td>
                        <td className="p-4 text-right whitespace-nowrap">
                          <span className="text-[var(--muted)] text-xs mr-2">
                            {f.subjectType} · {f.subjectId.slice(0, 8)}…
                          </span>
                          {href ? (
                            <Link
                              href={href}
                              className="text-[var(--accent)] text-xs underline underline-offset-2"
                            >
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
