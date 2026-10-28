'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchConfig, updateConfig } from '@/lib/api';
import { outcomeOf } from '@/lib/outcome';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';

// EVERY FIELD ON THIS PAGE MUST BE READ BY PRODUCTION CODE.
//
// This page used to render 21 editable keys, of which exactly one was read by
// anything. The other 20 saved successfully and changed nothing — and one of
// them (ride_request_timeout_seconds, seeded 15) actively disagreed with the
// shipped constant (20s). A control that silently does nothing is worse than a
// missing control, because a missing control is visible.
//
// The dead fields were not "unwired features"; their numbers deliberately live
// elsewhere:
//   - taxi / delivery / courier rates → CountryConfig per market (a fare is a
//     Guyana number, not a platform number — a global key here would REGRESS
//     the per-market model)
//   - cancellation window & fees      → cancel-policy.ts constants (product law)
//   - offer timeout                   → dispatch.service.ts constants
//   - surge                           → no engine exists
//
// apps/api/src/__tests__/admin-config-truth.test.ts walks this file's key list
// against the API source and FAILS if a key with no reader is added here — the
// next dead field cannot ship. Add a key ONLY together with the code that reads
// it (see modules/order/response-sla.ts for the pattern: config → env →
// bounded default, fail-safe).
const SECTIONS: { title: string; items: { key: string; label: string; hint?: string }[] }[] = [
  {
    title: 'Operations',
    items: [
      {
        key: 'order_auto_reject_minutes',
        label: 'Minutes a store has to answer a new order',
        hint: 'How long a store has to answer before an unaccepted order is cancelled and the customer is told. 1–1440; out-of-range values fall back to the shipped default.',
      },
    ],
  },
  {
    // [Row 3 · force update] Read by apps/api/src/modules/ops/app-version.ts. Not part of the
    // signed platform seed: saving here changes it at once, with no deploy and no re-seed.
    title: 'App updates',
    items: [
      {
        key: 'app_min_build_ios',
        label: 'Oldest iPhone build allowed',
        hint: 'An iPhone running an older build than this (from build 12 on) shows a full-screen "Update Swift" with an App Store link the next time it opens. 0 or empty = no minimum. Builds 9–11 cannot read this and keep working. It blocks people mid-ride or mid-delivery at their next open too: raise it only after that build is live in the App Store.',
      },
      {
        key: 'app_min_build_android',
        label: 'Oldest Android build allowed (version code)',
        hint: 'The same for Android, by version code (Play Console): an older phone from the build-12 release on is asked to update from Google Play. 0 or empty = no minimum. Raise it only after that version is live on Google Play.',
      },
    ],
  },
];

// Rendered as information, not as inputs — so the page stays honest about
// where these numbers actually live and how to change them.
const NOT_EDITABLE_HERE: { title: string; body: string }[] = [
  {
    title: 'Taxi, delivery & courier rates',
    body: 'Set for each market (taxi rates, courier rates, the delivery schedule) — a change there is made for one country, not for the whole platform.',
  },
  {
    title: 'Cancellation rule',
    body: 'Product law in the API\'s one cancel rule: a cancel is free or refused, never a fee. A store order cancels free until the store accepts it; a ride, parcel or booking cancels free until a driver, rider or provider accepts it, then for 1 minute from that acceptance; very late orders and orders with no mover found cancel free. With INSTANT_BOOKING on, a confirmed appointment cancels free until 2 hours before it starts (never less than 1 minute after it was confirmed), and the customer\'s own move stops 2 hours before it starts. The apps show the API\'s verdict.',
  },
  {
    title: 'Dispatch offer timeout',
    body: 'Fixed on the server (20 seconds, 12 seconds for express). It is timed together with how offers pass from one mover to the next, so it is not safe to change while Swift is running.',
  },
];

export default function ConfigPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['config'], queryFn: fetchConfig });
  const [edits, setEdits] = useState<Record<string, string>>({});

  const rows: { key: string; value: unknown }[] = data?.data ?? [];
  const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  // [U28] A configuration change is C5: its first answer is a second admin's
  // approval. It used to read "Saved." (or the 202 as an error) with the form
  // still dirty, so a second save filed a duplicate approval. The panel names
  // old -> new per setting; once it went through OR was queued the edits are
  // cleared, so nothing is left to press twice. A refusal outranks a queued
  // answer: the operator is shown what did not go.
  const actions = useActionRunner(() => {
    setEdits({});
    void qc.invalidateQueries({ queryKey: ['config'] });
  });
  const save = () => {
    const changes = Object.entries(edits);
    void actions.run({
      title: changes.length === 1 ? 'Change this setting?' : `Change these ${changes.length} settings?`,
      body: (
        <ul>
          {changes.map(([key, v]) => <li key={key}><code>{key}</code>: {String(values[key] ?? 'not set')} to {v}</li>)}
        </ul>
      ),
      confirmLabel: 'Save configuration',
      submit: async ({ reason }) => {
        const results = await Promise.allSettled(changes.map(([key, v]) => updateConfig(key, Number(v), reason)));
        const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
        const refused = failures.find((e) => outcomeOf(e, { kind: 'write' }).tone !== 'queued');
        if (refused) throw refused;
        if (failures.length) throw failures[0];
        return results;
      },
      success: () => 'Saved.',
    });
  };

  const dirty = Object.keys(edits).length > 0;

  return (
    <div className="mc-page">
      {isLoading ? (
        <div className="mc-loading" aria-busy="true">Loading configuration…</div>
      ) : isError ? (
        // No form over a failed read: blank boxes would look like unset values.
        <QueryFailed error={error} what="the platform configuration" onRetry={() => void refetch()} retrying={isFetching} />
      ) : (
        <div className="max-w-3xl space-y-5">
          {SECTIONS.map((section) => (
            <section key={section.title} className="mc-card">
              <h2 className="mc-section-title">{section.title}</h2>
              <div className="mc-list-plain">
                {section.items.map((item) => (
                  <div key={item.key} className="py-3 first:pt-1 last:pb-1">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <label htmlFor={`config-${item.key}`} className="font-semibold">{item.label}</label>
                      <input
                        id={`config-${item.key}`}
                        type="number"
                        step="any"
                        value={edits[item.key] ?? String(values[item.key] ?? '')}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [item.key]: e.target.value }))}
                        className="mc-input mc-input-number mc-numbers"
                      />
                    </div>
                    {item.hint && <p className="mc-muted mt-1.5 text-xs">{item.hint}</p>}
                  </div>
                ))}
              </div>
            </section>
          ))}

          <section className="mc-card">
            <h2 className="mc-section-title">Launch switches</h2>
            <p className="mc-muted mb-3 text-xs">
              Set on the server and shown here as the server is running them. They cannot be changed from Mission Control.
            </p>
            <div className="flex items-start justify-between gap-4 rounded-[var(--mc-radius-sm)] bg-[var(--mc-surface)] p-3">
              <div>
                <p className="font-semibold">Team invites need the invitee to accept</p>
                <p className="mc-muted mt-1 text-xs">
                  <span className="mc-mono">STAFF_INVITE_ACCEPT</span>. Off: a store owner adding a number adds that account straight away. On: the account gets an invite
                  and joins only after accepting. Turn on once the app build with the Accept card is live in both stores.
                </p>
              </div>
              <span data-testid="switch-staff-invite-accept" className="mc-numbers shrink-0 font-semibold">
                {data?.switches?.staffInviteAccept === true ? 'ON' : data?.switches?.staffInviteAccept === false ? 'OFF' : 'Unknown'}
              </span>
            </div>
          </section>

          <section className="mc-card">
            <h2 className="mc-section-title">Not changed here — by design</h2>
            <p className="mc-muted mb-3 text-xs">
              These numbers matter, but a box on this page would not change them. Where each one really lives:
            </p>
            <div className="space-y-2">
              {NOT_EDITABLE_HERE.map((n) => (
                <div key={n.title} className="rounded-[var(--mc-radius-sm)] bg-[var(--mc-surface)] p-3">
                  <p className="font-semibold">{n.title}</p>
                  <p className="mc-muted mt-1 text-xs">{n.body}</p>
                </div>
              ))}
            </div>
          </section>

          {actions.banner}
          <div className="flex items-center justify-end gap-4">
            <button type="button" onClick={save} disabled={!dirty} className="mc-btn mc-btn-primary">
              Save Configuration
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
