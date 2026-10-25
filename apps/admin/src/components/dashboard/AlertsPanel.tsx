'use client';

import Link from 'next/link';
import { AlertTriangle, AlertCircle, CheckCircle2, ChevronRight } from 'lucide-react';
import { DataUnavailable } from './DataUnavailable';

type Alerts = { pendingVendors: number; pastDueSubs: number; unassignedOrders: number };

const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;

export function AlertsPanel({
  alerts,
  unavailable,
  lastSuccessAt,
}: {
  alerts?: Alerts;
  /** [A-06] the read failed — say so; "all clear" here is the lie the register named */
  unavailable?: boolean;
  lastSuccessAt?: number;
}) {
  // Every alert is a door, not a label — it deep-links to where the work is.
  const items: { level: 'warning' | 'error'; message: string; href: string }[] = [];
  if (alerts) {
    if (alerts.unassignedOrders > 0)
      items.push({ level: 'error', message: `${plural(alerts.unassignedOrders, 'order')} unassigned for > 10 minutes`, href: '/orders' });
    if (alerts.pastDueSubs > 0)
      items.push({ level: 'warning', message: `${plural(alerts.pastDueSubs, 'subscription')} past due`, href: '/finance' });
    if (alerts.pendingVendors > 0)
      items.push({ level: 'warning', message: `${plural(alerts.pendingVendors, 'vendor')} pending approval`, href: '/vendors' });
  }

  return (
    <div className="mc-card">
      <h3 className="mc-section-title">Needs you</h3>
      <div className="space-y-2">
        {unavailable ? (
          // [A-06] The panel that most needed this: an operator reading
          // "All clear" during an outage believes safety and money are quiet.
          <DataUnavailable
            what="Alerts"
            notAnAllClear="This is NOT an all-clear — there may be alerts you cannot see."
            lastSuccessAt={lastSuccessAt}
          />
        ) : items.length === 0 ? (
          <div className="mc-note mc-note-good flex items-center gap-3">
            <CheckCircle2 size={16} className="shrink-0" />
            <span className="text-sm">All clear — no active alerts.</span>
          </div>
        ) : (
          items.map((alert, i) => (
            <Link
              key={i}
              href={alert.href}
              className="group flex min-h-[44px] items-center gap-3 rounded-[var(--mc-radius-sm)] border border-[var(--mc-line)] p-3 hover:border-[var(--mc-accent)]"
            >
              {alert.level === 'error' ? (
                <AlertCircle size={16} className="mc-text-bad shrink-0" />
              ) : (
                <AlertTriangle size={16} className="mc-text-warn shrink-0" />
              )}
              <span className="flex-1 font-semibold">{alert.message}</span>
              <ChevronRight size={15} className="mc-muted group-hover:text-[var(--mc-accent)]" />
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
