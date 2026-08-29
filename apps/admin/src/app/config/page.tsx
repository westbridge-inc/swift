'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchConfig, updateConfig } from '@/lib/api';

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
];

// Rendered as information, not as inputs — so the page stays honest about
// where these numbers actually live and how to change them.
const NOT_EDITABLE_HERE: { title: string; body: string }[] = [
  {
    title: 'Taxi, delivery & courier rates',
    body: 'Per-market numbers on CountryConfig (taxiRates, courierRates, delivery schedule) — changing them is a per-country edit, not a platform-wide one.',
  },
  {
    title: 'Cancellation window & fees',
    body: 'Product law shipped as code (5-minute free window, G$500 late fee) so the app, the API and this dashboard can never disagree about money.',
  },
  {
    title: 'Dispatch offer timeout',
    body: 'A shipped constant (20s, 12s express) — it is paced against the offer cascade, its timeout jobs and its evidence trail, and is not safe to tune at runtime.',
  },
];

export default function ConfigPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['config'], queryFn: fetchConfig });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);

  const rows: { key: string; value: unknown }[] = data?.data ?? [];
  const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const save = useMutation({
    mutationFn: async () => {
      await Promise.all(Object.entries(edits).map(([key, v]) => updateConfig(key, Number(v))));
    },
    onSuccess: () => {
      setStatus('Saved.');
      setEdits({});
      qc.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (e) => setStatus((e as Error).message || 'Save failed.'),
  });

  const dirty = Object.keys(edits).length > 0;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Platform Configuration</h1>

      {isLoading ? (
        <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-8 text-center text-[var(--muted)]">
          Loading configuration...
        </div>
      ) : (
        <div className="space-y-6">
          {SECTIONS.map((section) => (
            <div key={section.title} className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6">
              <h2 className="text-lg font-semibold mb-4">{section.title}</h2>
              <div className="space-y-3">
                {section.items.map((item) => (
                  <div key={item.key} className="p-3 rounded-lg bg-white/5">
                    <div className="flex items-center justify-between">
                      <label className="text-sm">{item.label}</label>
                      <input
                        type="number"
                        step="any"
                        value={edits[item.key] ?? String(values[item.key] ?? '')}
                        onChange={(e) => {
                          setStatus(null);
                          setEdits((prev) => ({ ...prev, [item.key]: e.target.value }));
                        }}
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

          <div className="flex items-center justify-end gap-4">
            {status && <span className="text-sm text-[var(--muted)]">{status}</span>}
            <button
              onClick={() => save.mutate()}
              disabled={!dirty || save.isPending}
              className="px-6 py-2.5 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--accent)]/80 disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save Configuration'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
