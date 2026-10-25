'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchCompliance, runComplianceAudit, decideComplianceReview, resolveComplianceViolation } from '@/lib/api';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { humanise } from '@/lib/labels';

/**
 * The liability shield. Three panels:
 *  - Violations: movers found live-operating with a broken checklist (should
 *    be empty — anything here was already forced offline, evidence attached).
 *  - Re-verification queue: the monthly random sample awaiting a human
 *    re-review of their documents.
 *  - Audit runs: the immutable "we checked" trail — every daily run, counts,
 *    zero or not.
 */
export default function CompliancePage() {
  const qc = useQueryClient();
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['compliance'], queryFn: fetchCompliance, refetchInterval: 60_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['compliance'] });

  // [U28] Running the audit, deciding a re-verification and resolving a
  // violation used to fail in silence (only a refetch followed). Each now goes
  // through the in-page panel, which keeps the server's refusal in view, and
  // the answer stays on the page. Running the audit can force movers offline,
  // so it is confirmed first.
  const actions = useActionRunner(() => void refresh());
  const runAudit = () => void actions.run({
    title: 'Run the compliance audit now?',
    body: <p>Everyone online is checked against their document checklist. Anyone failing it is forced offline at once, with the evidence kept.</p>,
    reason: false,
    confirmLabel: 'Run audit',
    submit: () => runComplianceAudit(),
    success: () => 'Audit run. Its counts are in the evidence trail below.',
  });
  const decide = (c: any, pass: boolean) => {
    const who = [c.user?.firstName, c.user?.lastName].filter(Boolean).join(' ') || 'this mover';
    void actions.run({
      title: pass ? `Pass the re-verification of ${who}?` : `Fail the re-verification of ${who} and force them offline?`,
      body: pass
        ? <p>Confirm you re-opened their documents in Verification and they are genuine and current.</p>
        : <p>They go offline at once and stay offline until their documents pass again.</p>,
      confirmLabel: pass ? 'Documents check out' : 'Fail and force offline',
      fields: [{ kind: 'text', name: 'note', label: 'Note for the record', required: !pass, hint: pass ? 'Optional' : 'Required: what is wrong with the documents' }],
      submit: ({ reason, values }) => decideComplianceReview(c.id, pass, String(values['note'] ?? '') || undefined, reason),
      success: () => (pass ? 'Re-verification passed.' : 'Re-verification failed: they are offline.'),
    });
  };
  const resolve = (v: any) => void actions.run({
    title: 'Mark this compliance violation as resolved?',
    body: <p>This only succeeds once their document checklist passes again.</p>,
    confirmLabel: 'Mark resolved',
    submit: ({ reason }) => resolveComplianceViolation(v.id, reason),
    success: () => 'Violation resolved.',
  });

  const d = q.data?.data;
  const runs: any[] = d?.runs ?? [];
  const violations: any[] = d?.openViolations ?? [];
  const queue: any[] = d?.reviewQueue ?? [];

  const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="mc-page">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="mc-muted max-w-3xl">
          Every day Swift re-checks everyone on the road against their document checklist and keeps the evidence.
          An unlicensed or uninsured mover working through Swift is a lawsuit — this page is where that never happens.
        </p>
        <button type="button" onClick={runAudit} className="mc-btn mc-btn-primary">
          Run audit now
        </button>
      </div>

      {actions.banner}

      {q.isLoading ? (
        <div className="mc-loading" aria-busy="true">Loading the compliance checks…</div>
      ) : q.isError ? (
        // A failed read is never "nobody is operating outside the rules": say we could not look.
        <QueryFailed error={q.error} what="the compliance checks" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
      <>
      {/* Open violations */}
      <section className="mc-section">
        <h2 className="mc-section-title">
          Open violations{' '}
          <span className={violations.length === 0 ? 'mc-text-good' : 'mc-text-bad'}>({violations.length})</span>
        </h2>
        <div className="mc-list">
          {violations.length === 0 ? (
            <div className="mc-empty">
              Nobody is operating outside the rules — and the run log below proves it.
            </div>
          ) : (
            violations.map((v) => (
              <div key={v.id} className="mc-card border-l-4 border-l-[var(--mc-bad)]">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="mc-card-title">
                    {v.user?.firstName} {v.user?.lastName}
                  </span>
                  <span className="mc-muted mc-numbers text-xs">{v.user?.phone}</span>
                  <span className="mc-badge mc-tone-bad">{humanise(String(v.reason))}</span>
                  <span className="mc-muted text-xs">{humanise(String(v.moverKind))}</span>
                  <span className="mc-muted mc-numbers ml-auto text-xs">{when(v.createdAt)}</span>
                </div>
                <p className="mc-muted mt-2">
                  Action taken: <b className="text-[var(--mc-ink)]">{humanise(String(v.actionTaken))}</b> — they stay
                  offline until their documents pass again.
                </p>
                <div className="mc-actions">
                  <button
                    type="button"
                    onClick={() => setOpenEvidence(openEvidence === v.id ? null : v.id)}
                    aria-expanded={openEvidence === v.id}
                    className="mc-btn"
                  >
                    {openEvidence === v.id ? 'Hide evidence' : 'View evidence'}
                  </button>
                  <button
                    type="button"
                    onClick={() => resolve(v)}
                    className="mc-btn"
                    title="Only succeeds once their checklist passes again"
                  >
                    Mark resolved
                  </button>
                </div>
                {openEvidence === v.id && (
                  <pre className="mc-mono mt-3 overflow-x-auto rounded-[var(--mc-radius-sm)] bg-[var(--mc-surface)] p-3">
                    {JSON.stringify(v.evidence, null, 2)}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      {/* Re-verification queue */}
      <section className="mc-section">
        <h2 className="mc-section-title">Random re-verification queue ({queue.length})</h2>
        <div className="mc-list">
          {queue.length === 0 ? (
            <div className="mc-empty">
              No open cases. A random sample of active movers is drawn on the 1st of each month.
            </div>
          ) : (
            queue.map((c) => (
              <div key={c.id} className="mc-card">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="mc-card-title">
                    {c.user?.firstName} {c.user?.lastName}
                  </span>
                  <span className="mc-muted mc-numbers text-xs">{c.user?.phone}</span>
                  <span className="mc-badge mc-tone-warn">Due {new Date(c.dueAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                </div>
                <p className="mc-muted mt-1.5 text-xs">
                  Re-open their documents in Documents and confirm they are genuine and current — then decide here.
                </p>
                <div className="mc-actions">
                  <button type="button" onClick={() => decide(c, true)} className="mc-btn mc-btn-primary">
                    Documents check out
                  </button>
                  <button type="button" onClick={() => decide(c, false)} className="mc-btn mc-btn-danger">
                    Fail — force offline
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Run history */}
      <section className="mc-section">
        <h2 className="mc-section-title">Audit runs (evidence trail)</h2>
        <div className="mc-table-wrap overflow-x-auto">
          <table className="mc-table">
            <thead>
              <tr>
                <th className="mc-label">When</th>
                <th className="mc-label">Started by</th>
                <th className="mc-label">Online movers checked</th>
                <th className="mc-label">Violations</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr>
                  <td colSpan={4} className="mc-table-empty">
                    No runs yet — the daily job writes one every morning, or run one now.
                  </td>
                </tr>
              )}
              {runs.map((r) => (
                <tr key={r.id}>
                  <td data-label="When" className="mc-numbers">{when(r.startedAt)}</td>
                  <td data-label="Started by" className="mc-muted">{humanise(String(r.trigger))}</td>
                  <td data-label="Online movers checked" className="mc-numbers">{r.moversChecked}</td>
                  <td data-label="Violations" className={`mc-numbers font-bold ${r.violations > 0 ? 'mc-text-bad' : 'mc-text-good'}`}>
                    {r.violations}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      </>
      )}
    </div>
  );
}
