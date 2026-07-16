/**
 * Earnings / sales statements (marketplace-mechanics spec §12, the receipt's
 * sibling) — the artifact an earner shows a bank and a store shows their
 * accountant. Same doctrine as receipt.ts: server-rendered print-ready HTML,
 * derived on demand from the ledger rows, no stored copies to govern.
 */

import crypto from 'node:crypto';

export type StatementLine = {
  date: Date;
  label: string;
  amount: unknown;
};

export type StatementInput = {
  title: string;
  holder: string;
  periodLabel: string;
  lines: StatementLine[];
  totalLabel: string;
  totalAmount: unknown;
  footNote: string;
};

const money = (n: unknown) => `$${Math.round(Number(n ?? 0)).toLocaleString()} GYD`;
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const day = (d: Date) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export function renderStatementHtml(input: StatementInput): string {
  const rows = input.lines
    .map(
      (l) => `<tr>
        <td class="date">${day(l.date)}</td>
        <td>${esc(l.label)}</td>
        <td class="num">${money(l.amount)}</td>
      </tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)} — Swift</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; color: #111; margin: 0; background: #f6f6f6; }
  .sheet { max-width: 640px; margin: 24px auto; background: #fff; border-radius: 16px; padding: 32px; }
  .brand { color: #e8192c; font-weight: 800; font-size: 22px; }
  h1 { font-size: 16px; margin: 4px 0 0; font-weight: 600; color: #555; }
  .meta { margin: 16px 0; font-size: 14px; color: #555; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 6px 0; border-bottom: 1px solid #eee; }
  .date { color: #888; white-space: nowrap; padding-right: 12px; }
  .num { text-align: right; white-space: nowrap; }
  .grand td { font-weight: 800; font-size: 16px; border-top: 2px solid #111; padding-top: 8px; border-bottom: none; }
  .empty { padding: 24px 0; color: #888; text-align: center; }
  .foot { margin-top: 24px; font-size: 12px; color: #888; line-height: 1.6; }
  @media print { body { background: #fff; } .sheet { margin: 0; border-radius: 0; } }
</style>
</head>
<body>
<div class="sheet">
  <div class="brand">Swift</div>
  <h1>${esc(input.title)}</h1>
  <div class="meta">
    ${esc(input.holder)}<br>
    ${esc(input.periodLabel)}
  </div>
  <table>
    ${rows || '<tr><td class="empty" colspan="3">Nothing in this period.</td></tr>'}
    <tr class="grand"><td colspan="2">${esc(input.totalLabel)}</td><td class="num">${money(input.totalAmount)}</td></tr>
  </table>
  <div class="foot">${esc(input.footNote)}</div>
</div>
</body>
</html>`;
}

/** Shared period parsing: explicit from/to or the last 30 days. */
export function statementPeriod(query: { from?: string; to?: string }): { from: Date; to: Date; label: string } {
  const to = query.to ? new Date(query.to) : new Date();
  to.setHours(23, 59, 59, 999);
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 24 * 3600 * 1000);
  from.setHours(0, 0, 0, 0);
  const label = `${day(from)} — ${day(to)}`;
  return { from, to, label };
}

// ── Statement builders ───────────────────────────────────────────────────────
// One builder per statement kind, shared by the authed routes and the signed
// render route — the link opens EXACTLY what the app would have shown.

type PrismaLike = {
  earning: { findMany: (args: unknown) => Promise<Array<{ orderId: string; createdAt: Date; type: unknown; amount: unknown }>> };
  order: { findMany: (args: unknown) => Promise<Array<Record<string, unknown>>> };
  user: { findUniqueOrThrow: (args: unknown) => Promise<{ firstName: string | null; lastName: string | null; phone: string }> };
  vendor: { findUniqueOrThrow: (args: unknown) => Promise<{ name: string; addressLine1: string; city: string }> };
};

async function earnerStatement(
  prisma: PrismaLike,
  opts: { title: string; footNote: string; where: Record<string, string>; userId: string },
  period: { from: Date; to: Date; label: string },
): Promise<string> {
  const earnings = await prisma.earning.findMany({
    where: { ...opts.where, createdAt: { gte: period.from, lte: period.to } },
    orderBy: { createdAt: 'asc' },
    take: 1000,
  });
  const orders = (await prisma.order.findMany({
    where: { id: { in: earnings.map((e) => e.orderId) } },
    select: { id: true, orderNumber: true },
  })) as Array<{ id: string; orderNumber: string }>;
  const numberOf = new Map(orders.map((o) => [o.id, o.orderNumber]));
  const total = earnings.reduce((s, e) => s + Number(e.amount), 0);
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: opts.userId },
    select: { firstName: true, lastName: true, phone: true },
  });
  return renderStatementHtml({
    title: opts.title,
    holder: `${[user.firstName, user.lastName].filter(Boolean).join(' ')} · ${user.phone}`,
    periodLabel: period.label,
    lines: earnings.map((e) => ({
      date: e.createdAt,
      label: `${numberOf.get(e.orderId) ?? e.orderId} · ${String(e.type).replaceAll('_', ' ').toLowerCase()}`,
      amount: e.amount,
    })),
    totalLabel: `Total earned (${earnings.length} entr${earnings.length === 1 ? 'y' : 'ies'})`,
    totalAmount: total,
    footNote: opts.footNote,
  });
}

export function buildRiderStatement(prisma: unknown, riderId: string, userId: string, period: { from: Date; to: Date; label: string }) {
  return earnerStatement(prisma as PrismaLike, {
    title: 'Rider earnings statement',
    where: { riderId },
    userId,
    footNote:
      'You keep 100% of every fee and tip — Swift charges a flat weekly subscription, never commission. '
      + 'Amounts were collected in cash at handover unless noted. Generated by Swift on request; the earnings ledger is the source of truth.',
  }, period);
}

export function buildDriverStatement(prisma: unknown, driverId: string, userId: string, period: { from: Date; to: Date; label: string }) {
  return earnerStatement(prisma as PrismaLike, {
    title: 'Driver earnings statement',
    where: { driverId },
    userId,
    footNote:
      'You keep 100% of every fare — Swift charges a flat weekly subscription, never commission. '
      + 'Fares were collected in cash from the rider unless noted. Generated by Swift on request; the earnings ledger is the source of truth.',
  }, period);
}

export async function buildVendorStatement(prisma: unknown, vendorId: string, period: { from: Date; to: Date; label: string }): Promise<string> {
  const p = prisma as PrismaLike;
  const vendorRecord = await p.vendor.findUniqueOrThrow({
    where: { id: vendorId },
    select: { name: true, addressLine1: true, city: true },
  });
  const orders = (await p.order.findMany({
    where: {
      vendorId,
      status: { in: ['DELIVERED', 'COMPLETED'] },
      placedAt: { gte: period.from, lte: period.to },
    },
    select: { orderNumber: true, placedAt: true, fulfillment: true, subtotalCustomer: true, discount: true },
    orderBy: { placedAt: 'asc' },
    take: 2000,
  })) as Array<{ orderNumber: string; placedAt: Date; fulfillment: string | null; subtotalCustomer: unknown; discount: unknown }>;
  const takeOf = (o: { subtotalCustomer: unknown; discount: unknown }) =>
    Number(o.subtotalCustomer ?? 0) - Number(o.discount ?? 0);
  const total = orders.reduce((s, o) => s + takeOf(o), 0);
  return renderStatementHtml({
    title: 'Sales statement',
    holder: `${vendorRecord.name} — ${vendorRecord.addressLine1}, ${vendorRecord.city}`,
    periodLabel: period.label,
    lines: orders.map((o) => ({
      date: o.placedAt,
      label: `${o.orderNumber} · ${String(o.fulfillment ?? 'DELIVERY').toLowerCase()}`,
      amount: takeOf(o),
    })),
    totalLabel: `Total sales (${orders.length} order${orders.length === 1 ? '' : 's'})`,
    totalAmount: total,
    footNote:
      'You keep 100% of every sale — Swift charges a flat weekly subscription, never commission. '
      + 'Delivery fees and tips are the rider’s and are not part of these figures. '
      + 'Generated by Swift on request; the order ledger is the source of truth.',
  });
}

// ── Signed statement links ───────────────────────────────────────────────────
// The in-app browser can't send a JWT, so the AUTHED statement route mints a
// short-lived HMAC link (the document render-token model) and the public
// render route verifies it — sharing/printing rides the browser sheet.

const statementSecret = () => process.env['STORAGE_SIGNING_SECRET'] ?? 'dev-signing-secret';

export type StatementKind = 'rider' | 'driver' | 'vendor';

export function signStatementToken(kind: StatementKind, actorId: string, from: string, to: string, expires: number): string {
  return crypto
    .createHmac('sha256', statementSecret())
    .update(`statement:${kind}:${actorId}:${from}:${to}:${expires}`)
    .digest('hex')
    .slice(0, 32);
}

/** Path (relative to the API origin) for a time-limited statement render. */
export function mintStatementPath(
  kind: StatementKind,
  actorId: string,
  period: { from: Date; to: Date },
  ttlSeconds = 600,
): { path: string; expiresInSeconds: number } {
  const from = period.from.toISOString();
  const to = period.to.toISOString();
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signStatementToken(kind, actorId, from, to, expires);
  const q = new URLSearchParams({ kind, actor: actorId, from, to, expires: String(expires), sig });
  return { path: `/api/v1/statements/render?${q.toString()}`, expiresInSeconds: ttlSeconds };
}
