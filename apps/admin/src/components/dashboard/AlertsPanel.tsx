'use client';

import Link from 'next/link';
import { AlertTriangle, AlertCircle, CheckCircle2, ChevronRight, HelpCircle } from 'lucide-react';
import { DataUnavailable } from './DataUnavailable';
import type { WaitingCounts, WaitingKey } from '@/lib/api';

type Alerts = { pendingVendors: number; pastDueSubs: number; unassignedOrders: number };

type Level = 'warning' | 'error';
type Item = { level: Level | 'unknown'; message: string; href: string };

const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;

// [ADMIN-AUDIT S2-1] Every queue the server counts, in the words of its own page. SOS / ops pages and
// safety tickets first. `many` also names the queue when its count could not be read.
const QUEUES: Record<WaitingKey, { one: string; many: string; href: string; level: Level }> = {
  opsAlerts: { one: 'SOS or ops page waiting to be acknowledged', many: 'SOS or ops pages waiting to be acknowledged', href: '/ops-alerts', level: 'error' },
  supportSafety: { one: 'safety ticket open', many: 'safety tickets open', href: '/support', level: 'error' },
  documents: { one: 'document waiting for review', many: 'documents waiting for review', href: '/verification', level: 'warning' },
  approvals: { one: 'request waiting for a second admin', many: 'requests waiting for a second admin', href: '/approvals', level: 'warning' },
  paymentConfirmations: { one: 'weekly-fee payment waiting for PAID or NOT PAID', many: 'weekly-fee payments waiting for PAID or NOT PAID', href: '/payment-confirmations', level: 'warning' },
  support: { one: 'support ticket open', many: 'support tickets open', href: '/support', level: 'warning' },
  catalogue: { one: 'item or store held by a banned word', many: 'items or stores held by a banned word', href: '/catalogue-check', level: 'warning' },
  storeVat: { one: 'store VAT certificate to check', many: 'store VAT certificates to check', href: '/store-vat', level: 'warning' },
  custody: { one: 'custody case open', many: 'custody cases open', href: '/custody', level: 'warning' },
  claimsToDecide: { one: 'claim to decide', many: 'claims to decide', href: '/claims', level: 'warning' },
  claimsToPay: { one: 'approved claim to pay', many: 'approved claims to pay', href: '/claims', level: 'warning' },
  returnsToDecide: { one: 'return to decide', many: 'returns to decide', href: '/returns', level: 'warning' },
  refundsOwed: { one: 'refund owed', many: 'refunds owed', href: '/returns', level: 'warning' },
  moderation: { one: 'report or held review to moderate', many: 'reports or held reviews to moderate', href: '/moderation', level: 'warning' },
};

/** The server's answer, only when it has the shape this page reads: anything else is not a count. */
function readable(waiting: WaitingCounts | undefined): WaitingCounts | null {
  if (!waiting || !Array.isArray(waiting.queues) || !Array.isArray(waiting.notCounted)) return null;
  return {
    queues: waiting.queues.filter((q) => q && q.key in QUEUES),
    notCounted: waiting.notCounted.filter((k) => k in QUEUES),
  };
}

export function AlertsPanel({
  alerts,
  unavailable,
  lastSuccessAt,
  waiting,
  waitingUnavailable,
  waitingLoading,
}: {
  alerts?: Alerts;
  /** [A-06] the read failed — say so; "all clear" here is the lie the register named */
  unavailable?: boolean;
  lastSuccessAt?: number;
  /** [ADMIN-AUDIT S2-1] every waiting queue's server count (GET /admin/dashboard/waiting) */
  waiting?: WaitingCounts;
  /** the waiting read failed: the queues are unknown, never clear */
  waitingUnavailable?: boolean;
  waitingLoading?: boolean;
}) {
  const counts = readable(waiting);
  // A failed read, or an answer this page cannot read, is the same thing: the queues are unknown.
  const queuesUnknown = !!waitingUnavailable || (!waitingLoading && !counts);
  // Every alert is a door, not a label — it deep-links to where the work is.
  const items: Item[] = [];
  const queue = (key: WaitingKey) => {
    const q = counts?.queues.find((row) => row.key === key);
    if (!q) return;
    const words = QUEUES[key];
    if (q.count === null) items.push({ level: 'unknown', message: `Could not count ${words.many}. This is not zero.`, href: words.href });
    else if (q.count > 0) items.push({ level: words.level, message: `${q.count} ${q.count === 1 ? words.one : words.many}`, href: words.href });
  };
  queue('opsAlerts');
  queue('supportSafety');
  if (alerts && alerts.unassignedOrders > 0)
    items.push({ level: 'error', message: `${plural(alerts.unassignedOrders, 'order')} unassigned for > 10 minutes`, href: '/orders' });
  for (const key of Object.keys(QUEUES) as WaitingKey[]) if (key !== 'opsAlerts' && key !== 'supportSafety') queue(key);
  if (alerts) {
    if (alerts.pastDueSubs > 0)
      items.push({ level: 'warning', message: `${plural(alerts.pastDueSubs, 'subscription')} past due`, href: '/finance' });
    if (alerts.pendingVendors > 0)
      items.push({ level: 'warning', message: `${plural(alerts.pendingVendors, 'vendor')} pending approval`, href: '/vendors' });
  }
  const notCounted = counts?.notCounted.length ?? 0;
  const clear = !unavailable && !queuesUnknown && !waitingLoading && items.length === 0;

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
        ) : (
          <>
            {items.map((alert, i) => (
              <Link
                key={i}
                href={alert.href}
                className="group flex min-h-[44px] items-center gap-3 rounded-[var(--mc-radius-sm)] border border-[var(--mc-line)] p-3 hover:border-[var(--mc-accent)]"
              >
                {alert.level === 'error' ? (
                  <AlertCircle size={16} className="mc-text-bad shrink-0" />
                ) : alert.level === 'unknown' ? (
                  <HelpCircle size={16} className="mc-text-warn shrink-0" />
                ) : (
                  <AlertTriangle size={16} className="mc-text-warn shrink-0" />
                )}
                <span className="flex-1 font-semibold">{alert.message}</span>
                <ChevronRight size={15} className="mc-muted group-hover:text-[var(--mc-accent)]" />
              </Link>
            ))}
            {queuesUnknown && (
              // [ADMIN-AUDIT S2-1] The queue counts did not arrive: SOS pages, documents and the rest are unknown.
              <DataUnavailable
                what="The queue counts"
                notAnAllClear="This is NOT an all-clear — SOS pages, documents and other queues could not be counted."
              />
            )}
            {waitingLoading && !queuesUnknown && <p className="mc-muted text-sm">Counting every queue…</p>}
            {clear && (
              <div className="mc-note mc-note-good flex items-center gap-3">
                <CheckCircle2 size={16} className="shrink-0" />
                <span className="text-sm">
                  {notCounted === 0
                    ? 'All clear — no active alerts.'
                    : 'All clear in the queues you can open.'}
                </span>
              </div>
            )}
            {notCounted > 0 && !queuesUnknown && (
              <p className="mc-muted text-sm">
                {plural(notCounted, 'other queue')} need{notCounted === 1 ? 's' : ''} a permission your account does not have, so {notCounted === 1 ? 'it is' : 'they are'} not counted here.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
