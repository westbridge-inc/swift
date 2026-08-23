'use client';

import Link from 'next/link';
import { AlertTriangle, AlertCircle, CheckCircle2, ChevronRight } from 'lucide-react';

type Alerts = { pendingVendors: number; pastDueSubs: number; unassignedOrders: number };

const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;

export function AlertsPanel({ alerts }: { alerts?: Alerts }) {
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
    <div className="bg-[var(--panel)] rounded-xl p-6 border border-[var(--border)]">
      <h3 className="text-lg font-semibold mb-4">Alerts & Issues</h3>
      <div className="space-y-2">
        {items.length === 0 ? (
          <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5 text-[var(--muted)]">
            <CheckCircle2 size={16} className="text-green-400 shrink-0" />
            <span className="text-sm">All clear — no active alerts.</span>
          </div>
        ) : (
          items.map((alert, i) => (
            <Link
              key={i}
              href={alert.href}
              className="flex items-center gap-3 p-3 rounded-lg bg-white/5 hover:bg-white/10 transition-colors group"
            >
              {alert.level === 'error' ? (
                <AlertCircle size={16} className="text-red-400 shrink-0" />
              ) : (
                <AlertTriangle size={16} className="text-yellow-400 shrink-0" />
              )}
              <span className="text-sm flex-1">{alert.message}</span>
              <ChevronRight size={15} className="text-[var(--muted)] group-hover:text-white transition-colors" />
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
