'use client';

import { useEffect, useReducer, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  SAFETY_LIST_LIMIT, acknowledgeSos, decideSafetyCase, errorStatus, fetchOrderDetail, fetchSafetyCases, fetchSafetySos, fetchUserDetail, resolveSos, revealUserPhone, workSafetyCase,
  type Envelope,
} from '@/lib/api';
import { ENUM_LABELS, label } from '@/lib/labels';
import { gyClock, gyDateTime, gyTime } from '@/lib/dates';
import { succeeded } from '@/lib/outcome';
import {
  DECISION_WORDS, SOS_RESOLUTION_CODES, caseActions, categoryWords, clocksFor, interimWords, queueOrder, sosActions, sosGraceOver, sosNeedsYou, sosNotes, sosPosition, sosPressesNotShown, sosReadFresh, worstSla,
  type CaseScope, type DecisionCode, type IncidentRow, type SlaClock, type SosResolutionCode, type SosRow,
} from '@/lib/safetyView';
import { PhoneReveal, usePhoneReveal } from '@/components/mc/PhoneReveal';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { StatusBadge } from '@/components/mc/StatusBadge';
import { useActionRunner } from '@/components/mc/useActionRunner';

// ---------------------------------------------------------------------------
// [SAFETY BOARD] Where a person works an SOS and a safety case from the web console, copied from the desktop console's
// Safety module onto the routes it already uses. Before this the console could only acknowledge the page: it said someone
// raised an SOS and nothing else, and a person held by a safety report stayed off the road until someone called the API.
//
// Who may act is the server's call: every read and write here passes the same ops check, so an account the server refuses
// has no cards, and so no buttons. A failed refresh keeps the cards, because an outage must not blank a live emergency.
// "No open SOS." is the worst thing this page can get wrong, so it is said only on a read that came back in the last 45
// seconds. BOARD_READ makes a read that could not run or never returned a failed read, instead of an old answer.
// Every action renders the server's answer; nothing is shown as done before it is.
// ---------------------------------------------------------------------------

const PERSON_READ_MS = 5 * 60_000;
/** The server said this account may not read: the cards go. Anything else (a 429, a 5xx, no network) leaves them on screen. */
const refusedRead = (error: unknown) => { const status = errorStatus(error); return status === 401 || status === 403; };

/** Keep reading: offline, behind a hidden tab, and at once on opening or coming back. A failure shows at once, not after retries. */
const BOARD_READ = { networkMode: 'always', retry: false, staleTime: 0, refetchOnWindowFocus: 'always', refetchIntervalInBackground: true } as const;

/** Now, kept current on a timer and at once when a sleeping tab wakes, when no timer has run. */
function useNow(): number {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = setInterval(tick, 5_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return Date.now();
}

type Reveal = ReturnType<typeof usePhoneReveal>;
type ListQuery<T> = UseQueryResult<Envelope<T[]>>;

/** A list's first read, a refusal, a failed refresh, or the cap: said in words, never as an empty list. */
function ListState<T>({ query, what, onRetry }: { query: ListQuery<T>; what: string; onRetry: () => void }) {
  if (query.isPending) return <div className="mc-card" aria-busy="true">Loading {what}…</div>;
  if (query.isError && (refusedRead(query.error) || !query.data)) {
    return <QueryFailed error={query.error} what={what} onRetry={onRetry} retrying={query.isFetching} className="mb-3" />;
  }
  if (query.isError) {
    return <p role="alert" className="mc-note mc-note-bad mb-3">This list could not refresh. It shows what it last read at {gyTime(query.dataUpdatedAt)}.</p>;
  }
  if ((query.data?.data.length ?? 0) >= SAFETY_LIST_LIMIT) {
    return <p className="mc-note mc-note-warn mb-3">Showing the first {SAFETY_LIST_LIMIT}. There may be more.</p>;
  }
  return null;
}

/** The person behind an alert. GET /admin/users/:id writes a sensitive-read row, so one card reads it once, not on every refresh. */
function Person({ id, role, reveal }: { id: string; role?: string; reveal: Reveal }) {
  const person = useQuery({ queryKey: ['safety-person', id], queryFn: () => fetchUserDetail(id), staleTime: PERSON_READ_MS });
  const u = person.data?.data as { firstName?: string | null; lastName?: string | null; phone?: string | null } | undefined;
  if (person.isLoading) return <span className="mc-muted">Reading their page…</span>;
  if (!u) {
    return (
      <span>
        {errorStatus(person.error) === 403 ? 'This account cannot read this person.' : 'Their page could not be read.'}{' '}
        <Link href={`/users/${id}`} className="mc-link-button">Open their page</Link>
      </span>
    );
  }
  const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || 'No name on file';
  const key = `person:${id}`;
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
      <Link href={`/users/${id}`} className="mc-link-button">{name}</Link>
      {role ? <span className="mc-muted">{label('UserRole', role)}</span> : null}
      {u.phone ? (
        <PhoneReveal
          phone={u.phone}
          revealed={reveal.revealed[key]}
          onReveal={reveal.revealFor(key, `Show ${name}'s full number?`, `${name}'s number is shown.`, (reason) => revealUserPhone(id, reason))}
        />
      ) : <span className="mc-muted">No number on file</span>}
    </span>
  );
}

function OrderLink({ id, type }: { id: string; type: string | null }) {
  const order = useQuery({ queryKey: ['safety-order', id], queryFn: () => fetchOrderDetail(id), staleTime: PERSON_READ_MS });
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
      <Link href={`/orders/${id}`} className="mc-link-button">{(order.data?.data as { orderNumber?: string } | undefined)?.orderNumber ?? 'Open the order'}</Link>
      {type ? <span className="mc-muted">{label('OrderType', type)}</span> : null}
      {order.isError ? <span className="mc-muted">Its number could not be read.</span> : null}
    </span>
  );
}

type Run = ReturnType<typeof useActionRunner>['run'];

function SosCard({ alert: a, now, run, reveal }: { alert: SosRow; now: number; run: Run; reveal: Reveal }) {
  const said = sosNotes(a);
  const notShown = sosPressesNotShown(a);
  const where = sosPosition(a);
  const can = sosActions(a);
  const raised = gyDateTime(a.triggeredAt);

  const acknowledge = () => void run({
    title: 'Acknowledge this SOS?',
    body: <p>You are saying you have seen this and are handling it. Swift stops re-paging everyone about it and records that you acknowledged it. This does not close the SOS.</p>,
    confirmLabel: 'Acknowledge',
    reason: false,
    submit: () => acknowledgeSos(a.id),
    success: () => succeeded('Acknowledged.', 'If its page is still on Ops alerts, it is still re-paging.'),
  });
  const resolve = () => void run({
    title: 'Resolve this SOS?',
    body: (
      <p>
        Only a person closes an SOS, and a closed one cannot be reopened. Emergency contacts who were texted get an all-clear. Police involved or Abuse opens a
        safety case against the other person on the trip, if there is one. A rider or driver is taken offline at once and told they are under review.
      </p>
    ),
    confirmLabel: 'Resolve',
    reason: false,
    fields: [
      { kind: 'choice', name: 'code', label: 'What happened', options: SOS_RESOLUTION_CODES.map((value) => ({ value, label: ENUM_LABELS.SosResolutionCode[value] })) },
      { kind: 'text', name: 'notes', label: 'Notes', maxLength: 2000 },
    ],
    submit: ({ values }) => resolveSos(a.id, values['code'] as SosResolutionCode, String(values['notes'] ?? '')),
    success: (_result, { values }) => `Resolved as ${ENUM_LABELS.SosResolutionCode[values['code'] as SosResolutionCode]}.`,
  });

  return (
    <li className={`mc-card${sosNeedsYou(a, now) ? ' border-[var(--mc-bad)]' : ''}`} aria-label={`SOS from ${label('UserRole', a.actorRole)}, ${raised}`}>
      <p className="mc-label">SOS · raised {raised} · {label('SosTriggerSource', a.triggerSource)}</p>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <StatusBadge group="SosStatus" value={a.status} />
        {a.retriggerCount > 0 ? <span className="mc-badge mc-badge-alarm">Asked again ×{a.retriggerCount}</span> : null}
      </div>

      {/* "I'm safe" never closes an alert: a person under duress can be made to tap it. A reason to call, never a dimmed row. */}
      {a.userSafeFlaggedAt ? <p className="mc-note mc-note-warn mb-2">They tapped “I’m safe”. That does not close this: call back and check before resolving.</p> : null}
      {sosGraceOver(a, now) ? (
        <p className="mc-note mc-note-bad mb-2">The grace window ended at {gyTime(a.graceEndsAt)} and it has not gone live, so nobody has been paged. Call them.</p>
      ) : a.status === 'TRIGGER_PENDING' ? (
        <p className="mc-note mc-note-info mb-2">They can still cancel.{a.graceEndsAt ? ` It goes live at ${gyTime(a.graceEndsAt)} if they do not.` : ''} There is nothing to acknowledge until it is live.</p>
      ) : null}

      <dl className="mc-rows">
        <div className="mc-row"><dt>Who</dt><dd><Person id={a.actorUserId} role={a.actorRole} reveal={reveal} /></dd></div>
        {a.counterpartyUserId ? <div className="mc-row"><dt>Other person</dt><dd><Person id={a.counterpartyUserId} reveal={reveal} /></dd></div> : null}
        {a.orderId ? <div className="mc-row"><dt>Order</dt><dd><OrderLink id={a.orderId} type={a.orderType} /></dd></div> : null}
        {!a.orderId && a.serviceJobId ? <div className="mc-row"><dt>Context</dt><dd>On a service job (home visit)</dd></div> : null}
        {a.acknowledgedAt ? <div className="mc-row"><dt>Acknowledged</dt><dd>{gyDateTime(a.acknowledgedAt)}</dd></div> : null}
      </dl>

      {/* What they typed reads on this card only: it never goes on a push, a text or the order timeline. React escapes it. */}
      {said.length > 0 ? (
        <section aria-label="What they said" className="mc-note mc-note-bad mt-3">
          <p className="font-semibold">What they said</p>
          <ol>
            {said.map((n) => (
              <li key={n.seq}>
                <span className="whitespace-pre-wrap break-words">{n.text}</span>{' '}
                <span className="whitespace-nowrap text-xs">{n.seq === 0 ? 'when they pressed' : `press ×${n.seq}`} · {gyTime(n.at)}</span>
              </li>
            ))}
          </ol>
          {notShown > 0 ? <p className="text-xs">{notShown} earlier repeat {notShown === 1 ? 'press is' : 'presses are'} not shown here.</p> : null}
        </section>
      ) : null}

      <section aria-label="Where" className="mt-3 text-sm">
        <p className="font-semibold">Where</p>
        {where ? (
          <p>
            {where.text}{where.accuracy ? <span className="mc-muted"> {where.accuracy}</span> : null}
            {where.seq ? <span className="mc-muted"> Newest position, from repeat press ×{where.seq} at {gyTime(where.at)}</span> : null}
          </p>
        ) : <p>No location was captured.</p>}
      </section>

      {can.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {can.includes('ack') ? <button type="button" className="mc-btn mc-btn-primary" onClick={acknowledge}>Acknowledge…</button> : null}
          {can.includes('resolve') ? <button type="button" className="mc-btn" onClick={resolve}>Resolve…</button> : null}
        </div>
      ) : null}
    </li>
  );
}

function clockWords(k: SlaClock): string {
  if (k.state === 'met') return 'Done';
  if (k.state === 'breached') return `Overdue since ${gyDateTime(k.deadline)}`;
  return k.state === 'due' ? `${gyDateTime(k.deadline)}, ${k.minutes} min left` : gyDateTime(k.deadline);
}

function CaseCard({ item: c, run }: { item: IncidentRow; run: Run }) {
  const can = caseActions(c);
  const hold = interimWords(c);

  const acknowledge = () => void run({
    title: `Acknowledge case ${c.caseNumber}?`,
    body: <p>This stops its acknowledgement clock and starts the work on it.</p>,
    confirmLabel: 'Acknowledge',
    reason: false,
    submit: () => workSafetyCase(c.id, 'ack'),
    success: () => `${c.caseNumber} is acknowledged.`,
  });
  const decide = () => void run({
    title: `Decide case ${c.caseNumber}?`,
    body: (
      <p>
        {hold ? `Only Dismissed lifts the ${hold.noun}: any other decision leaves it on until someone lifts it. ` : null}
        Warning issued is a record: Swift sends them nothing. Warn them yourself. Permanent suspension is a record too: it does not suspend anyone. Do that on the person’s page.
      </p>
    ),
    confirmLabel: 'Record the decision',
    reason: false,
    fields: [
      { kind: 'choice', name: 'code', label: 'Decision', options: (Object.keys(DECISION_WORDS) as DecisionCode[]).map((value) => ({ value, label: DECISION_WORDS[value] })) },
      { kind: 'text', name: 'notes', label: 'Notes', maxLength: 4000 },
    ],
    submit: ({ values }) => decideSafetyCase(c.id, values['code'] as DecisionCode, String(values['notes'] ?? '')),
    success: (_result, { values }) => `${c.caseNumber} is decided: ${DECISION_WORDS[values['code'] as DecisionCode]}.`,
  });
  const close = () => void run({
    title: `Close case ${c.caseNumber}?`,
    body: <p>A closed case leaves the open queue.{hold ? ` Closing does not lift the ${hold.noun}: lift it first if it should end.` : ''}</p>,
    confirmLabel: 'Close case',
    reason: false,
    submit: () => workSafetyCase(c.id, 'close'),
    success: () => `${c.caseNumber} is closed.`,
  });
  const lift = () => void run({
    title: `Lift the ${hold?.noun} on case ${c.caseNumber}?`,
    body: <p>This ends the {hold?.noun} from this case. They are told. Another open case that holds them stays in force, and they are told that too.</p>,
    confirmLabel: `Lift ${hold?.noun}`,
    reason: false,
    submit: () => workSafetyCase(c.id, 'lift-interim'),
    success: () => `${c.caseNumber}: the ${hold?.noun} is lifted.`,
  });

  return (
    <li className={`mc-card${worstSla(c) === 'breached' ? ' border-[var(--mc-bad)]' : ''}`} aria-label={`Case ${c.caseNumber}`}>
      <p className="mc-label">{c.caseNumber} · {categoryWords(c.category)} · opened {gyDateTime(c.createdAt)}</p>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className={`mc-badge${c.severity === 'S0' || c.severity === 'S1' ? ' mc-badge-alarm' : ''}`}>{c.severity}</span>
        <StatusBadge group="IncidentStatus" value={c.status} />
        {hold ? <span className="mc-badge mc-tone-warn">{hold.words}</span> : null}
        {c.escalatedPoliceAt ? <span className="mc-badge mc-tone-bad">Police</span> : null}
        {c.legalHold ? <span className="mc-badge">Legal hold</span> : null}
      </div>
      <p className="text-sm whitespace-pre-wrap break-words">{c.summary}</p>
      {c.status === 'CLOSED' && hold ? <p className="mc-note mc-note-warn mt-2">This case is closed and still lists a {hold.noun}. Closing does not lift one.</p> : null}
      {c.status === 'CLOSED' ? null : (
        <dl className="mc-rows">
          {clocksFor(c).map((k) => <div key={k.label} className="mc-row"><dt>{k.label}</dt><dd className={k.state === 'breached' ? 'mc-text-bad' : ''}>{clockWords(k)}</dd></div>)}
        </dl>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 text-sm">
        <Link href={`/users/${c.subjectUserId}`} className="mc-link-button">Open the person’s page</Link>
        {c.orderId ? <Link href={`/orders/${c.orderId}`} className="mc-link-button">Open the order</Link> : null}
      </div>
      {can.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {can.includes('ack') ? <button type="button" className="mc-btn mc-btn-primary" onClick={acknowledge}>Acknowledge…</button> : null}
          {can.includes('decide') ? <button type="button" className="mc-btn mc-btn-primary" onClick={decide}>Decide…</button> : null}
          {can.includes('close') ? <button type="button" className="mc-btn mc-btn-primary" onClick={close}>Close case…</button> : null}
          {can.includes('lift-interim') ? <button type="button" className="mc-btn" onClick={lift}>Lift {hold?.noun}…</button> : null}
        </div>
      ) : null}
    </li>
  );
}

const SCOPES: Array<{ key: CaseScope; words: string }> = [{ key: 'open', words: 'Open' }, { key: 'breached', words: 'Past a deadline' }, { key: 'all', words: 'All' }];

export default function SafetyPage() {
  const qc = useQueryClient();
  const [scope, setScope] = useState<CaseScope>('open');
  const actions = useActionRunner(() => {
    void qc.invalidateQueries({ queryKey: ['safety-sos'] });
    void qc.invalidateQueries({ queryKey: ['safety-cases'] });
  });
  const reveal = usePhoneReveal(actions.run);
  // A live emergency is not a page you refresh by hand.
  const alerts = useQuery({ ...BOARD_READ, queryKey: ['safety-sos'], queryFn: ({ signal }) => fetchSafetySos(signal), refetchInterval: 15_000 });
  const cases = useQuery({ ...BOARD_READ, queryKey: ['safety-cases', scope], queryFn: ({ signal }) => fetchSafetyCases(scope, signal), refetchInterval: 60_000 });
  const now = useNow();
  // No rows once the server refuses the read, so no buttons; the last good rows if a refresh only failed.
  const alertsRefused = alerts.isError && refusedRead(alerts.error);
  const openAlerts = alertsRefused ? [] : alerts.data?.data ?? [];
  const readRecently = sosReadFresh(alerts.dataUpdatedAt, now);
  const queue = queueOrder(cases.isError && refusedRead(cases.error) ? [] : cases.data?.data ?? []);

  return (
    <div className="mc-page">
      <p className="mc-muted mb-4 text-sm">
        Who asked for help, where they are, and the safety cases on the queue. SOS alerts refresh every 15 seconds, cases every minute. An unacknowledged page keeps
        re-paging until someone acknowledges it here or on <Link href="/ops-alerts" className="mc-link-button">Ops alerts</Link>.
      </p>
      {actions.banner}
      <section aria-label="Open SOS alerts" className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Open SOS alerts</h2>
        {alerts.dataUpdatedAt > 0 && !alertsRefused && (alerts.isError || !readRecently) ? (
          <p role="alert" className="mc-note mc-note-bad mb-3">Not read since {gyClock(alerts.dataUpdatedAt)}. There may be an open SOS.</p>
        ) : (
          <ListState query={alerts} what="the open SOS alerts" onRetry={() => void alerts.refetch()} />
        )}
        {alerts.isSuccess && readRecently && openAlerts.length === 0 ? <div className="mc-card"><p>No open SOS.</p><p className="mc-muted text-xs">Read at {gyClock(alerts.dataUpdatedAt)}</p></div> : null}
        {openAlerts.length > 0 ? <ul className="space-y-3">{openAlerts.map((a) => <SosCard key={a.id} alert={a} now={now} run={actions.run} reveal={reveal} />)}</ul> : null}
        {alerts.isSuccess && readRecently && openAlerts.length > 0 ? <p className="mc-muted text-xs mt-2">Read at {gyClock(alerts.dataUpdatedAt)}</p> : null}
      </section>
      <section aria-label="Cases">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h2 className="text-lg font-semibold">Cases</h2>
          <div className="flex flex-wrap gap-2 ml-auto">
            {SCOPES.map((s) => (
              <button key={s.key} type="button" aria-pressed={scope === s.key} className={`mc-btn${scope === s.key ? ' mc-btn-primary' : ''}`} onClick={() => setScope(s.key)}>{s.words}</button>
            ))}
          </div>
        </div>
        <ListState query={cases} what="the safety cases" onRetry={() => void cases.refetch()} />
        {cases.isSuccess && queue.length === 0 ? <div className="mc-card">No cases in this view.</div> : null}
        {queue.length > 0 ? <ul className="space-y-3">{queue.map((c) => <CaseCard key={c.id} item={c} run={actions.run} />)}</ul> : null}
      </section>
    </div>
  );
}
