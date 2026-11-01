'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';
import { money } from '@/lib/vendor-api';
import { getTier } from '@/lib/store-extras-api';
import { DataUnavailable } from '@/components/data-unavailable';
import { capLine, declarationLine, registrationLine, tierLabel, type TierView } from '../../../../../mobile/src/modules/vendor/tier-view';

/** The phone's words (VendorTierScreen; the test reads them there). */
export const TIER_WORDS = {
  staff: 'Seller status is shown to the store’s manager and owner.',
  near: 'You are near a limit. Orders past it are refused until the day or week rolls over.',
  promotedLater: 'Promoted placement opens once your business is registered.',
  noLimits: 'No order or sales limits apply. Promoted placement is open to you.',
  steps: [
    '1. Register your business name with the Deeds and Commercial Registries Authority (DCRA).',
    '2. Get the Business Registration Certificate.',
    '3. Upload it under your documents. The limits lift the day it is verified, and we tell you.',
  ],
} as const;

function Bar({ fraction, hot, label }: { fraction: number; hot: boolean; label: string }) {
  const pct = Math.round(fraction * 100);
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--swift-subtle)]">
      <div className={`h-2 ${hot ? 'bg-amber-500' : 'bg-green-600'}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * [WEB-SETTINGS PR-B · owner 31 Oct 2026] Seller status on the website: the phone's Account > Seller status
 * (VendorTierScreen), read-only. The store's tier, its caps and usage, and what lifts the limits, all from GET
 * /vendor/tier (manager and owner on the server) and in the phone's own words (its pure tier-view module, imported).
 */
export default function SellerStatusPage() {
  const storeId = useStoreId();
  const { manager, known, role } = useStoreRole();
  const q = useQuery({ queryKey: storeKey(storeId, 'tier'), queryFn: getTier, enabled: manager, refetchInterval: 60_000 });
  const t = q.data as TierView | undefined;

  if (known && !manager) return <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">{TIER_WORDS.staff}</p>;

  const label = t ? tierLabel(t) : null;
  const orders = t ? capLine(t.usage.ordersToday, t.caps.ordersPerDay, 'Orders today') : null;
  const sales = t ? capLine(t.usage.grossThisWeek, t.caps.grossPerWeek, 'Sales this week') : null;
  const declaration = t ? declarationLine(t) : null;

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <Link href="/dashboard/settings" className="text-sm font-semibold text-[var(--swift-muted)] hover:underline">Back to settings</Link>
        <h1 className="sw-title mt-2">Seller status</h1>
      </div>

      {q.isError ? (
        <DataUnavailable what="your seller status" error={q.error} onRetry={() => void q.refetch()} />
      ) : !t || !label || !orders || !sales ? (
        <p role="status" className="sw-card p-6 text-sm text-[var(--swift-muted)]">Checking your seller status…</p>
      ) : (
        <>
          <div className="sw-card p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-bold">Your tier</h2>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${label.tone === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-50 text-[var(--swift-red)]'}`}>{label.label}</span>
            </div>
            {t.capped ? (
              <div className="mt-3 space-y-3 text-sm">
                <div>
                  <p>{orders.text}</p>
                  <Bar label="Orders today" fraction={orders.fraction} hot={orders.fraction >= t.caps.nudgeAtFraction} />
                </div>
                <div>
                  <p>{`Sales this week: ${money(t.usage.grossThisWeek)} of ${money(t.caps.grossPerWeek)}`}</p>
                  <Bar label="Sales this week" fraction={sales.fraction} hot={sales.fraction >= t.caps.nudgeAtFraction} />
                </div>
                {t.nearCap && <p role="alert" className="font-semibold text-amber-700">{TIER_WORDS.near}</p>}
                <p className="text-[var(--swift-muted)]">{TIER_WORDS.promotedLater}</p>
              </div>
            ) : (
              <p className="mt-3 text-sm text-[var(--swift-muted)]">{TIER_WORDS.noLimits}</p>
            )}
          </div>

          <div className="sw-card p-6">
            <h2 className="font-bold">Business registration</h2>
            <p className="mt-1 text-sm">{registrationLine(t)}</p>
            {declaration && <p className="mt-1 text-sm text-[var(--swift-muted)]">{declaration}</p>}
            {t.capped && (
              <div className="mt-3 space-y-1 text-sm">
                <p className="font-bold">How to lift the limits</p>
                {TIER_WORDS.steps.map((step) => <p key={step}>{step}</p>)}
                <div className="flex flex-wrap gap-2 pt-2">
                  {role === 'OWNER' && <Link href="/dashboard/documents" className="sw-chip">Documents</Link>}
                  <Link href="/account/help" className="sw-chip">Need help registering? Ask a person</Link>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
