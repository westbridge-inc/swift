'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchConfig, updateConfig } from '@/lib/api';

// Real platform_config keys (see prisma/seed.ts). markup_percentage is dormant by
// design (cash-only, no markup) and intentionally NOT surfaced. Subscription
// weekly rates live in CountryConfig tiers, not here.
const SECTIONS: { title: string; items: { key: string; label: string }[] }[] = [
  {
    title: 'Delivery',
    items: [
      { key: 'delivery_base_fee', label: 'Base Delivery Fee (GYD)' },
      { key: 'delivery_per_km', label: 'Per-KM Fee (GYD)' },
      { key: 'delivery_included_km', label: 'Included KM (no per-km)' },
    ],
  },
  {
    title: 'Taxi',
    items: [
      { key: 'taxi_base_fare', label: 'Base Fare (GYD)' },
      { key: 'taxi_per_km', label: 'Per-KM (GYD)' },
      { key: 'taxi_per_minute', label: 'Per-Minute (GYD)' },
      { key: 'taxi_minimum_fare', label: 'Minimum Fare (GYD)' },
    ],
  },
  {
    title: 'Courier',
    items: [
      { key: 'courier_base_fee', label: 'Base Fee (GYD)' },
      { key: 'courier_per_km', label: 'Per-KM (GYD)' },
    ],
  },
  {
    title: 'Surge',
    items: [
      { key: 'surge_threshold', label: 'Surge Threshold (0–1)' },
      { key: 'surge_max_multiplier', label: 'Max Surge Multiplier' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { key: 'order_auto_reject_minutes', label: 'Order Auto-Reject (min)' },
      { key: 'ride_request_timeout_seconds', label: 'Ride Request Timeout (s)' },
      { key: 'order_free_cancellation_window_minutes', label: 'Free Cancellation Window (min)' },
      { key: 'subscription_grace_period_hours', label: 'Subscription Grace Period (h)' },
      { key: 'settlement_cycle_days', label: 'Settlement Cycle (days)' },
      { key: 'max_failed_payment_attempts', label: 'Max Failed Payment Attempts' },
      { key: 'min_rider_rating', label: 'Min Rider Rating' },
    ],
  },
  {
    title: 'Cancellation Fees',
    items: [
      { key: 'order_cancel_fee_after_acceptance', label: 'Order Cancel Fee — after acceptance (GYD)' },
      { key: 'taxi_cancel_fee_before_arrival', label: 'Taxi Cancel Fee — before arrival (GYD)' },
      { key: 'taxi_cancel_fee_after_arrival', label: 'Taxi Cancel Fee — after arrival (GYD)' },
    ],
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
                  <div key={item.key} className="flex items-center justify-between p-3 rounded-lg bg-white/5">
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
                ))}
              </div>
            </div>
          ))}

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
