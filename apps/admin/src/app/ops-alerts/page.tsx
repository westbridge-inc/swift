'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  acknowledgeOpsAlert,
  fetchFailedDrills,
  fetchOpsAlerts,
  runOpsAlertDrill,
  type FailedDrillRow,
  type OpsAlertKind,
  type OpsAlertRow,
} from '@/lib/api';
import { succeeded, type Outcome } from '@/lib/outcome';
import { ActionResult } from '@/components/mc/ActionResult';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { gyDateTime } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [DRILL-STORM · S-19 · GUARDRAILS §3] OPS ALERTS — where a page is acknowledged.
//
// An SOS page, a platform page (a stalled scheduler, a failed SOS delivery) and
// the weekly drill are durable obligations: until a person acknowledges one,
// it re-pages every responder and texts the on-call phones (backed off, at most
// a few times an hour per person). Until this screen there was nowhere in the
// console to acknowledge one, so nothing ever stopped them. Acknowledging says
// "I have seen this and I am handling it": it stops the re-pages for everyone
// and records who did it and when. It does not resolve an SOS — the person in
// trouble is still handled by phone and the war room.
//
// A drill nobody acknowledged within its window is closed as a FAILED drill and
// stops paging; it stays listed below, because it is evidence the paging path
// or the on-call rota failed.
// ---------------------------------------------------------------------------

const KIND_WORDS: Record<OpsAlertKind, string> = { SOS: 'SOS', DRILL: 'Drill', PLATFORM: 'Operations page' };
const when = (iso: string) => gyDateTime(iso);

function reach(recipients: OpsAlertRow['recipients']): string {
  const delivered = recipients.filter((r) => r.deliveredAt).length;
  const seen = recipients.filter((r) => r.seenAt).length;
  if (recipients.length === 0) return 'Not paged to anyone yet: no responder is set up. The on-call phones are texted.';
  return `Paged ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'} · delivered to ${delivered} · opened by ${seen}`;
}

function AlertRow({ alert, now, onDone }: { alert: OpsAlertRow; now: number; onDone: (_outcome: Outcome | null) => void }) {
  const dialog = useActionDialog();
  const overdue = new Date(alert.ackDeadlineAt).getTime() <= now;
  const acknowledge = async () => onDone(await dialog.run({
    title: `Acknowledge “${alert.title}”?`,
    body: (
      <p>
        You are saying you have seen this page and are handling it. Swift stops re-paging everyone about it and records
        that you acknowledged it.{alert.kind === 'SOS' ? ' This does not close the SOS: keep handling the person who asked for help.' : ''}
      </p>
    ),
    confirmLabel: 'Acknowledge',
    reason: false,
    submit: () => acknowledgeOpsAlert(alert.id),
    success: (res) => (res.data.acknowledged
      ? succeeded('Acknowledged. The re-pages have stopped.')
      : succeeded('Already handled: someone acknowledged it first, or it was closed.')),
  }));

  return (
    <li className="mc-card" aria-label={alert.title}>
      <p className="mc-label">
        {KIND_WORDS[alert.kind]} · opened {when(alert.createdAt)}
      </p>
      <h2 className="text-base font-semibold">{alert.title}</h2>
      <p className="text-sm">{alert.body}</p>
      <dl className="mc-rows">
        <div className="mc-row">
          <dt>Acknowledge by</dt>
          <dd>{overdue ? <strong>{`Overdue since ${when(alert.ackDeadlineAt)}`}</strong> : when(alert.ackDeadlineAt)}</dd>
        </div>
        {alert.escalationLevel > 0 ? (
          <div className="mc-row">
            <dt>Re-paged</dt>
            <dd>{`${alert.escalationLevel} ${alert.escalationLevel === 1 ? 'time' : 'times'}${alert.lastEscalatedAt ? `, last at ${when(alert.lastEscalatedAt)}` : ''}`}</dd>
          </div>
        ) : null}
        <div className="mc-row"><dt>Reached</dt><dd>{reach(alert.recipients)}</dd></div>
      </dl>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" className="mc-btn mc-btn-primary" onClick={() => void acknowledge()}>Acknowledge…</button>
      </div>
    </li>
  );
}

function FailedDrill({ drill }: { drill: FailedDrillRow }) {
  return (
    <li className="mc-card" aria-label={`Failed drill opened ${when(drill.createdAt)}`}>
      <p className="mc-label">Failed drill · opened {when(drill.createdAt)}</p>
      <p className="text-sm">
        {`Nobody acknowledged it. It paged ${drill.recipients.length} ${drill.recipients.length === 1 ? 'person' : 'people'}, re-paged ${drill.escalationLevel} ${drill.escalationLevel === 1 ? 'time' : 'times'}, and was closed at ${when(drill.closedAt)}.`}
      </p>
    </li>
  );
}

export default function OpsAlertsPage() {
  const qc = useQueryClient();
  const dialog = useActionDialog();
  const [result, setResult] = useState<Outcome | null>(null);
  const alerts = useQuery({ queryKey: ['ops-alerts'], queryFn: fetchOpsAlerts, refetchInterval: 15_000 });
  const failed = useQuery({ queryKey: ['ops-alerts-failed-drills'], queryFn: fetchFailedDrills, retry: false });
  const open: OpsAlertRow[] = alerts.data?.data ?? [];
  const failedDrills: FailedDrillRow[] = failed.data?.data ?? [];
  // A tenant ADMIN is refused the platform's drills: the section is simply not theirs.
  const failedRefused = failed.isError && (failed.error as { status?: number }).status === 403;
  const now = alerts.dataUpdatedAt || Date.now();

  const done = (outcome: Outcome | null) => {
    if (!outcome) return;
    setResult(outcome);
    void qc.invalidateQueries({ queryKey: ['ops-alerts'] });
    void qc.invalidateQueries({ queryKey: ['ops-alerts-failed-drills'] });
  };

  const drill = async () => done(await dialog.run({
    title: 'Run a paging drill now?',
    body: (
      <p>
        Every platform operator is paged and every on-call phone is texted now, exactly like a real SOS. Acknowledge it
        on this screen before its deadline. If nobody does, it is re-paged like a real SOS until its drill window ends, then closed as
        a FAILED drill.
      </p>
    ),
    confirmLabel: 'Run the drill',
    reason: false,
    submit: () => runOpsAlertDrill(),
    success: () => succeeded('The drill is out. Acknowledge it above when it reaches you.'),
  }));

  return (
    <div className="mc-page">
      <p className="mc-muted mb-4 text-sm">
        An SOS, an operations page and the weekly drill keep re-paging the responders and texting the on-call phones
        until someone acknowledges them here. Acknowledge one when you have seen it and are handling it: the re-pages
        stop for everyone, and Swift records who acknowledged it and when. Refreshes every 15 seconds.
      </p>
      <ActionResult outcome={result} onDismiss={() => setResult(null)} className="mb-5" />
      <section aria-label="Waiting for acknowledgement" className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Waiting for acknowledgement</h2>
        {alerts.isLoading ? (
          <div className="mc-card" aria-busy="true">Loading the pages…</div>
        ) : alerts.isError ? (
          <QueryFailed error={alerts.error} what="the ops alerts" onRetry={() => void alerts.refetch()} retrying={alerts.isFetching} />
        ) : open.length === 0 ? (
          <div className="mc-card">Nothing is waiting for acknowledgement.</div>
        ) : (
          <ul className="space-y-3">
            {open.map((a) => <AlertRow key={a.id} alert={a} now={now} onDone={done} />)}
          </ul>
        )}
      </section>
      {failedRefused ? null : (
        <section aria-label="Failed drills">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h2 className="text-lg font-semibold">Failed drills</h2>
            <button type="button" className="mc-btn ml-auto" onClick={() => void drill()}>Run a drill…</button>
          </div>
          <p className="mc-muted mb-3 text-sm">
            A drill nobody acknowledged within its window. Each one means a real SOS could have gone unanswered: check
            that the on-call staff get Swift pages, then run a drill.
          </p>
          {failed.isLoading ? (
            <div className="mc-card" aria-busy="true">Loading the failed drills…</div>
          ) : failed.isError ? (
            <QueryFailed error={failed.error} what="the failed drills" onRetry={() => void failed.refetch()} retrying={failed.isFetching} />
          ) : failedDrills.length === 0 ? (
            <div className="mc-card">No drill has failed.</div>
          ) : (
            <ul className="space-y-3">
              {failedDrills.map((d) => <FailedDrill key={d.id} drill={d} />)}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
