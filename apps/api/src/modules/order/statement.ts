import { formatMoney } from '../../utils/currency-amount';
import { aggregateSalesComponents, orderComponents } from '../billing/sales-components';
/**
 * Earnings / sales statements (marketplace-mechanics spec §12, the receipt's
 * sibling) — the artifact an earner shows a bank and a store shows their
 * accountant. Same doctrine as receipt.ts: server-rendered print-ready HTML,
 * derived on demand from the ledger rows, no stored copies to govern.
 */

import crypto from 'node:crypto';
import { storageSigningKeys, signingKeyFor, type SigningKey } from '../../utils/signing-keys';

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
  /** [M-36] The currency every line and the total are in. */
  currencyCode: string;
  /** [M-38] Separated columns rendered before the total (a vendor statement). */
  breakdown?: Array<{ label: string; amount: unknown; negative?: boolean }>;
  /** [M-38] Present when any figure is an estimate (legacy orders without a snapshot). */
  estimatedNote?: string;
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const day = (d: Date) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export function renderStatementHtml(input: StatementInput): string {
  // [M-36] Rendered through the registry in the statement's own currency.
  const money = (n: unknown) => formatMoney(n, input.currencyCode, { code: true, whole: true }); // statement lines are MAJOR_WHOLE
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
    ${(input.breakdown ?? []).map((b) => `<tr class="totals"><td colspan="2">${esc(b.label)}</td><td class="num">${b.negative ? '−' : ''}${money(b.amount)}</td></tr>`).join('\n')}
    <tr class="grand"><td colspan="2">${esc(input.totalLabel)}</td><td class="num">${money(input.totalAmount)}</td></tr>
  </table>
  ${input.estimatedNote ? `<div class="foot"><b>Estimated, not settled:</b> ${esc(input.estimatedNote)}</div>` : ''}
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
  earning: {
    findMany: (args: unknown) => Promise<Array<{ orderId: string; createdAt: Date; type: unknown; amount: unknown }>>;
    aggregate: (args: unknown) => Promise<{ _sum: { amount: unknown } }>;
  };
  order: {
    findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
    aggregate: (args: unknown) => Promise<{ _sum: { subtotalCustomer: unknown; discount: unknown } }>;
  };
  user: { findUniqueOrThrow: (args: unknown) => Promise<{ firstName: string | null; lastName: string | null; phone: string }> };
  vendor: { findUniqueOrThrow: (args: unknown) => Promise<{ name: string; addressLine1: string; city: string }> };
};

async function earnerStatement(
  prisma: PrismaLike,
  opts: { title: string; footNote: string; where: Record<string, string>; userId: string },
  period: { from: Date; to: Date; label: string },
): Promise<string> {
  // DASH-04: TRUE period total from a SQL aggregate (not a capped-list reduce),
  // so a high-volume statement never understates.
  const LINE_CAP = 1000;
  const periodWhere = { ...opts.where, createdAt: { gte: period.from, lte: period.to } };
  const [totalAgg, earnings] = await Promise.all([
    prisma.earning.aggregate({ where: periodWhere, _sum: { amount: true } }),
    prisma.earning.findMany({ where: periodWhere, orderBy: { createdAt: 'asc' }, take: LINE_CAP }),
  ]);
  const total = Number(totalAgg._sum.amount ?? 0);
  const capped = earnings.length === LINE_CAP;
  const orders = (await prisma.order.findMany({
    where: { id: { in: earnings.map((e) => e.orderId) } },
    select: { id: true, orderNumber: true, currencyCode: true },
  })) as Array<{ id: string; orderNumber: string; currencyCode: string }>;
  // [M-36] The statement's currency is its orders' (one market per holder); a
  // statement with no lines has no money to label and names the platform default.
  const currencyCode = orders[0]?.currencyCode ?? 'GYD';
  const numberOf = new Map(orders.map((o) => [o.id, o.orderNumber]));
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: opts.userId },
    select: { firstName: true, lastName: true, phone: true },
  });
  return renderStatementHtml({
    currencyCode,
    title: opts.title,
    holder: `${[user.firstName, user.lastName].filter(Boolean).join(' ')} · ${user.phone}`,
    periodLabel: period.label,
    lines: earnings.map((e) => ({
      date: e.createdAt,
      label: `${numberOf.get(e.orderId) ?? e.orderId} · ${String(e.type).replaceAll('_', ' ').toLowerCase()}`,
      amount: e.amount,
    })),
    totalLabel: capped
      ? `Total earned (full period; showing the first ${LINE_CAP} entries)`
      : `Total earned (${earnings.length} entr${earnings.length === 1 ? 'y' : 'ies'})`,
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
  // DASH-04: TRUE sales total from a SQL aggregate (sum of subtotals minus sum
  // of discounts = sum of the per-order take), so a busy vendor's statement
  // never understates past the line cap.
  const LINE_CAP = 2000;
  const periodWhere = {
    vendorId,
    status: { in: ['DELIVERED', 'COMPLETED'] },
    placedAt: { gte: period.from, lte: period.to },
  };
  // [M-38] The separated columns from each order's redemption snapshot — the
  // vendor's own promotions are the only discount that reduces its sales; a
  // platform-funded discount is money Swift owes the vendor; fees and tips
  // are the rider's. In SQL over the whole period, so the total never
  // understates past the line cap.
  const [components, orders] = await Promise.all([
    aggregateSalesComponents(p as unknown as Parameters<typeof aggregateSalesComponents>[0], { vendorId, from: period.from, to: period.to }),
    p.order.findMany({
      where: periodWhere,
      select: { orderNumber: true, placedAt: true, fulfillment: true, subtotalCustomer: true, discount: true, deliveryFee: true, tipAmount: true, currencyCode: true, promoRedemption: { select: { goodsDiscount: true, deliveryDiscount: true, funder: true } } },
      orderBy: { placedAt: 'asc' },
      take: LINE_CAP,
    }) as Promise<Array<{ orderNumber: string; placedAt: Date; fulfillment: string | null; subtotalCustomer: unknown; discount: unknown; deliveryFee: unknown; tipAmount: unknown; currencyCode: string; promoRedemption: { goodsDiscount: unknown; deliveryDiscount: unknown; funder: string } | null }>>,
  ]);
  // A line is what the vendor KEEPS from that order's goods: sales less its own promotion.
  const takeOf = (o: Parameters<typeof orderComponents>[0]) => {
    const c = orderComponents(o);
    return c.goodsSales - c.vendorPromoDiscount;
  };
  const total = components.netSales;
  const capped = orders.length === LINE_CAP;
  const breakdown: StatementInput['breakdown'] = [
    { label: 'Goods sales', amount: components.goodsSales },
    ...(components.vendorPromoDiscount > 0 ? [{ label: 'Your promotions', amount: components.vendorPromoDiscount, negative: true }] : []),
    ...(components.sponsorReceivable > 0 ? [{ label: 'Platform promotions — owed to you by Swift', amount: components.sponsorReceivable }] : []),
    { label: 'Collected from customers for goods', amount: components.customerCollection },
    { label: 'Delivery fees and tips (the rider’s, not part of your sales)', amount: components.moverPayable },
    ...(components.feeFunding > 0 ? [{ label: 'Delivery-fee promotions funded by Swift (the rider’s)', amount: components.feeFunding }] : []),
  ];
  const estimatedNote = components.estimatedOrders > 0
    ? `${components.estimatedOrders} order${components.estimatedOrders === 1 ? '' : 's'} in this period carry a discount with no funding record (placed before the record existed); their discount is counted as your own, which may understate your sales.`
    : undefined;
  return renderStatementHtml({
    // [M-36] The vendor's orders name the currency; none → the platform default.
    currencyCode: orders[0]?.currencyCode ?? 'GYD',
    title: 'Sales statement',
    holder: `${vendorRecord.name} — ${vendorRecord.addressLine1}, ${vendorRecord.city}`,
    periodLabel: period.label,
    lines: orders.map((o) => ({
      date: o.placedAt,
      label: `${o.orderNumber} · ${String(o.fulfillment ?? 'DELIVERY').toLowerCase()}`,
      amount: takeOf(o),
    })),
    breakdown,
    estimatedNote,
    totalLabel: capped
      ? `Your sales, net of your own promotions (full period; showing the first ${LINE_CAP} orders)`
      : `Your sales, net of your own promotions (${components.orders} order${components.orders === 1 ? '' : 's'})`,
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

// [M-37] The keyring never falls open in production; see utils/signing-keys.
const statementKeys = (env?: Record<string, string | undefined>) => storageSigningKeys(env);
/** Statement links are short-lived by design; no caller may mint a longer one. */
export const MAX_STATEMENT_TTL_SECONDS = 3600;

export type StatementKind = 'rider' | 'driver' | 'vendor';

/**
 * [F-027-10] Length-prefix every field so the signed material is UNAMBIGUOUS.
 *
 * Plain colon concatenation meant two different tuples could sign the same
 * bytes: (actor="A:B", from="C") and (actor="A", from="B:C") both produced
 * `statement:rider:A:B:C:...`. Server-generated ids and ISO dates make that
 * hard to reach today, but the render route accepts arbitrary non-empty
 * components, and a signature protocol should not depend on its inputs
 * happening not to contain the delimiter.
 *
 * Declaring each field's byte length first makes collision impossible: the
 * verifier can only parse the material one way.
 */
const field = (s: string) => `${Buffer.byteLength(s, 'utf8')}:${s}`;

/** [F-028-15] The PRE-F-027-10 signature, kept ONLY for verification during a
 *  rolling deployment: v2 landed without a protocol version in the URL, so a
 *  mixed fleet had new instances rejecting old links and old instances
 *  rejecting new ones — for links that live ten minutes. New links are v2 and
 *  say so (`v=2`); a versionless link is verified as v1 so an old instance's
 *  mint survives the roll. SUNSET: delete this and the v1 branch one release
 *  after every instance signs v2 — the format's delimiter weakness is exactly
 *  why v2 exists, and verification-only is the largest surface it may keep.
 */
export function signStatementTokenV1(kind: StatementKind, actorId: string, from: string, to: string, expires: number, secret = statementKeys().current.secret): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`statement:${kind}:${actorId}:${from}:${to}:${expires}`)
    .digest('hex')
    .slice(0, 32);
}

export function signStatementToken(kind: StatementKind, actorId: string, from: string, to: string, expires: number, secret = statementKeys().current.secret): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`statement:v2:${field(kind)}${field(actorId)}${field(from)}${field(to)}${field(String(expires))}`)
    .digest('hex')
    .slice(0, 32);
}

/** [M-37] v3: the signed material names the KEY that signed it (its id), so a
 *  verifier can only accept a token under a key it actually holds — the
 *  current one, or the previous one during a rotation — and never a key
 *  nobody holds, least of all the repository default. */
export function signStatementTokenV3(kind: StatementKind, actorId: string, from: string, to: string, expires: number, key: SigningKey): string {
  return crypto
    .createHmac('sha256', key.secret)
    .update(`statement:v3:${field(kind)}${field(actorId)}${field(from)}${field(to)}${field(String(expires))}${field(key.kid)}`)
    .digest('hex')
    .slice(0, 32);
}

export interface StatementLinkQuery {
  v?: '1' | '2' | '3' | undefined;
  k?: string | undefined;
  kind: StatementKind;
  actor: string;
  from: string;
  to: string;
  expires: number;
  sig: string;
}

/** [M-37] ONE verifier for every protocol version, constant-time, keyring-bound.
 *  v3 verifies under the key the token names (current or previous); v2 and
 *  versionless v1 links — minted before key ids existed — verify under the
 *  current key only, for the rolling deployment that carries them out. */
export function verifyStatementSignature(q: StatementLinkQuery, env?: Record<string, string | undefined>): boolean {
  const keyring = statementKeys(env);
  let expected: string;
  if (q.v === '3') {
    const key = signingKeyFor(q.k, keyring);
    if (!key) return false;
    expected = signStatementTokenV3(q.kind, q.actor, q.from, q.to, q.expires, key);
  } else if (q.v === '2') {
    expected = signStatementToken(q.kind, q.actor, q.from, q.to, q.expires, keyring.current.secret);
  } else {
    expected = signStatementTokenV1(q.kind, q.actor, q.from, q.to, q.expires, keyring.current.secret);
  }
  const provided = Buffer.from(q.sig, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
}

/** Path (relative to the API origin) for a time-limited statement render. */
export function mintStatementPath(
  kind: StatementKind,
  actorId: string,
  period: { from: Date; to: Date },
  ttlSeconds = 600,
  env?: Record<string, string | undefined>,
): { path: string; expiresInSeconds: number } {
  const from = period.from.toISOString();
  const to = period.to.toISOString();
  // [M-37] Short-lived by design: a caller asking for longer gets the cap.
  const ttl = Math.max(1, Math.min(ttlSeconds, MAX_STATEMENT_TTL_SECONDS));
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const key = statementKeys(env).current;
  const sig = signStatementTokenV3(kind, actorId, from, to, expires, key);
  const q = new URLSearchParams({ v: '3', k: key.kid, kind, actor: actorId, from, to, expires: String(expires), sig });
  return { path: `/api/v1/statements/render?${q.toString()}`, expiresInSeconds: ttl };
}
