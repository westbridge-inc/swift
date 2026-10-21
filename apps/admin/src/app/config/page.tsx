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
        label: 'Order Auto-Reject (min)',
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
    body: 'Per-market numbers on CountryConfig (taxiRates, courierRates, delivery schedule) — changing them is a per-country edit, not a platform-wide one.',
  },
  {
    title: 'Cancellation rule',
    body: 'Product law in the API\'s one cancel rule: a cancel is free or refused, never a fee. A store order cancels free until the store accepts it; a ride, parcel or booking cancels free until a driver, rider or provider accepts it, then for 5 minutes from that acceptance; very late orders and orders with no mover found cancel free. The apps show the API\'s verdict.',
  },
  {
    title: 'Dispatch offer timeout',
    body: 'A shipped constant (20s, 12s express) — it is paced against the offer cascade, its timeout jobs and its evidence trail, and is not safe to tune at runtime.',
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
    <div>
      <h1 className="text-2xl font-bold mb-6">Platform Configuration</h1>

      {isLoading ? (
        <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-8 text-center text-[var(--muted)]">
          Loading configuration...
        </div>
      ) : isError ? (
        // No form over a failed read: blank boxes would look like unset values.
        <QueryFailed error={error} what="the platform configuration" onRetry={() => void refetch()} retrying={isFetching} />
      ) : (
        <div className="space-y-6">
          {SECTIONS.map((section) => (
            <div key={section.title} className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6">
              <h2 className="text-lg font-semibold mb-4">{section.title}</h2>
              <div className="space-y-3">
                {section.items.map((item) => (
                  <div key={item.key} className="p-3 rounded-lg bg-white/5">
                    <div className="flex items-center justify-between">
                      <label htmlFor={`config-${item.key}`} className="text-sm">{item.label}</label>
                      <input
                        id={`config-${item.key}`}
                        type="number"
                        step="any"
                        value={edits[item.key] ?? String(values[item.key] ?? '')}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [item.key]: e.target.value }))}
                        className="bg-[var(--panel-2)] text-white px-3 py-1.5 rounded-lg text-sm border border-[var(--border)] focus:border-[var(--accent)] focus:outline-none w-32 text-right"
                      />
                    </div>
                    {item.hint && <p className="text-xs text-[var(--muted)] mt-2">{item.hint}</p>}
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6">
            <h2 className="text-lg font-semibold mb-1">Launch switches</h2>
            <p className="text-xs text-[var(--muted)] mb-4">
              Set in the server environment, shown here as this API is running them. Not editable from the console.
            </p>
            <div className="p-3 rounded-lg bg-white/5 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Team invites need the invitee to accept</p>
                <p className="text-xs text-[var(--muted)] mt-1">
                  STAFF_INVITE_ACCEPT. Off: a store owner adding a number adds that account straight away. On: the
                  account gets an invite and joins only after accepting. Turn on once the app build with the Accept
                  card is live in both stores.
                </p>
              </div>
              <span data-testid="switch-staff-invite-accept" className="text-sm font-semibold ml-4">
                {data?.switches?.staffInviteAccept === true ? 'ON' : data?.switches?.staffInviteAccept === false ? 'OFF' : 'Unknown'}
              </span>
            </div>
          </div>

          <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6">
            <h2 className="text-lg font-semibold mb-1">Not editable here — by design</h2>
            <p className="text-xs text-[var(--muted)] mb-4">
              This page previously showed 20 more fields that saved but were read by nothing. They were
              removed rather than left lying. Where each number really lives:
            </p>
            <div className="space-y-3">
              {NOT_EDITABLE_HERE.map((n) => (
                <div key={n.title} className="p-3 rounded-lg bg-white/5">
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-xs text-[var(--muted)] mt-1">{n.body}</p>
                </div>
              ))}
            </div>
          </div>

          {actions.banner}
          <div className="flex items-center justify-end gap-4">
            <button
              type="button"
              onClick={save}
              disabled={!dirty}
              className="px-6 py-2.5 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--accent)]/80 disabled:opacity-50"
            >
              Save Configuration
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
