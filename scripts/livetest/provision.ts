// Provision the seeded vendors into an orderable state [SWIFT-081], using the
// kept SUPER_ADMIN + each vendor's own owner session: admin-approve (ACTIVE +
// verified) → open + accepting → one category → one item (ST1 gets stock=1, R2
// is pickup-only). Defensive: logs each step's status and continues, so the run
// reports the real reachable state rather than aborting on the first gap.

import { login, POST, PUT, type Session } from './client.js';
import type { Roster } from './roster.js';

export interface Item { itemId: string; categoryId: string; price: number }
export interface Provisioned { admin: Session; items: Record<string, Item>; live: string[] }

const ORDERABLE = ['R1', 'R2', 'ST1', 'OV1']; // SERVICE (SV1) needs a licence gate — out of scope

// The open/accepting routes are registered as `/vendor/toggle-*` UNDER the
// `/api/v1/vendor` prefix, so the real path is double-prefixed (the mobile app
// calls it this way; the single-prefix path 404s). They FLIP the flag rather
// than set it, so "ensure true" reads the returned state and toggles again only
// if a prior run had already left it on.
async function ensureFlag(token: string, path: string, field: 'isCurrentlyOpen' | 'acceptingOrders'): Promise<boolean> {
  let r = await PUT(path, {}, token);
  if (r.json?.data?.[field] === false) r = await PUT(path, {}, token);
  return r.json?.data?.[field] === true;
}

export async function provisionVendors(roster: Roster, log: (s: string) => void): Promise<Provisioned> {
  const admin = await login('+5926001000');
  const items: Record<string, Item> = {};
  const live: string[] = [];

  for (const id of ORDERABLE) {
    const v = roster.vendors[id];
    if (!v?.vendorId) { log(`  ${id}: no vendorId (become did not return one) — skip`); continue; }

    const appr = await PUT(`/admin/vendors/${v.vendorId}/approve`, {}, admin.token);
    // ALREADY_ACTIVE (400) is fine on a re-run.
    const opened = await ensureFlag(v.session.token, '/vendor/vendor/toggle-open', 'isCurrentlyOpen');
    const accepting = await ensureFlag(v.session.token, '/vendor/vendor/toggle-orders', 'acceptingOrders');
    const cat = await POST('/vendor/categories', { name: 'Menu', sortOrder: 0 }, v.session.token);
    const categoryId = cat.json?.data?.id ?? cat.json?.data?.category?.id;
    const price = 1500;
    const body: Record<string, unknown> = { categoryId, name: `${id} Plate`, basePrice: price, isAvailable: true };
    if (id === 'ST1') body.stockQuantity = 1;
    if (id === 'R2') body.fulfillment = 'PICKUP';
    const it = categoryId ? await POST('/vendor/items', body, v.session.token) : null;
    const itemId = it?.json?.data?.id ?? it?.json?.data?.item?.id;
    if (itemId) { items[id] = { itemId, categoryId, price }; live.push(id); }
    log(`  ${id}: approve=${appr.status} open=${opened} accepting=${accepting} cat=${cat.status} item=${it?.status ?? '-'}${itemId ? ' ✓' : ''}`);
  }

  return { admin, items, live };
}
