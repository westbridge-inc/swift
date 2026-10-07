import { createHash, randomBytes } from 'node:crypto';
import { OrderStatus, Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { OrderService } from '../order/order.service';
import { applyStockMovements, recordOpeningBalances } from './stock';

// ---------------------------------------------------------------------------
// [POS-SYNC] Re-uploading a till export updates the store.
//
// The bulk import only ever CREATED items, so the second upload of the same
// till export doubled the catalogue. This is the update path:
//
//   file (already relabelled to Swift's columns by automap)
//     -> plan: match rows to items by SKU, inside ONE store, never by name
//     -> preview: the plan as the store sees it; writes nothing
//     -> confirm: the SAME plan re-derived under the store's lock and applied
//        in one transaction, or refused if it is not what was previewed.
//
// What is never guessed: a row without a SKU, a SKU that appears twice in the
// file or twice in the store, an unreadable / zero price, a fractional or
// negative count. Each is listed as "needs attention" and nothing is applied
// for it. A blank cell is "no information": it changes nothing.
//
// What it writes, and how:
//  - stock: the till's count is an absolute number, so the change is a ledger
//    movement of (till count - units promised to open orders - Swift count),
//    reason POS_IMPORT, note naming the upload — through the single writer's
//    batch form. Units sold on Swift but not yet collected are still on the
//    till's shelf; Swift already took them off its count at checkout, so they
//    are taken off the till's figure again rather than sold twice. An item
//    Swift does not count stays uncounted (the till's figure is shown, not
//    applied).
//  - sold out: the inventory engine's own edges — zero hides an item that is
//    switched on; a restock brings back only an item the ENGINE hid. The
//    owner's own "off" is never undone. A till that says "not for sale" switches
//    the item off the way the owner would.
//  - prices: applied and listed old -> new. Orders already placed keep the
//    prices they were placed at (order lines are snapshots); carts hold no
//    price, so an open cart shows the new price when it is next read.
//  - items missing from the file: left alone, unless the store chose
//    "mark them sold out" (switched off, no count invented).
//  - one PosImport row (id = upload id, unique per store + file hash) and one
//    audit row per applied upload. A retried confirm replays the stored
//    result; the same file under a new upload is refused.
// ---------------------------------------------------------------------------

export type MissingPolicy = 'LEAVE' | 'SOLD_OUT';
export type SoldOutEffect = 'BECOMES_SOLD_OUT' | 'BACK_ON_SALE' | 'STAYS_SWITCHED_OFF' | 'SWITCHED_OFF_BY_TILL';

/** The match key: exact SKU, trimmed, case-insensitive. Nothing else. */
export const skuKey = (sku: string | null | undefined): string => (sku ?? '').trim().toLowerCase();

/** sha256 of the file as confirmed, line endings normalised. */
export function contentHashOf(csv: string): string {
  return createHash('sha256').update(csv.replace(/\r\n?/g, '\n').replace(/\n+$/, ''), 'utf8').digest('hex');
}

export const newUploadId = (): string => randomBytes(18).toString('base64url');

const MAX_PRICE = 10_000_000;
const MAX_COUNT = 1_000_000;

/** (Not `kind`: the mobile notification census reads every `kind: '…'` literal in the API as a push kind.) */
type Reading<T> = { reading: 'blank' } | { reading: 'ok'; value: T } | { reading: 'bad'; reason: string };

const GROUPED = /^\d{1,3}(,\d{3})+(\.\d+)?$/;
const PLAIN = /^\d+(\.\d+)?$/;

/** A selling price as a till writes it: "1500", "1,500.00", "$1500", "GYD 1,500", "G$1500". */
export function readPrice(raw: string | undefined): Reading<number> {
  const text = (raw ?? '').trim();
  if (text === '') return { reading: 'blank' };
  const bare = text.replace(/^(?:GY\$|G\$|GYD|\$)\s*/i, '').replace(/\s*GYD$/i, '');
  if (!GROUPED.test(bare) && !PLAIN.test(bare)) return { reading: 'bad', reason: `The price "${text}" is not a number Swift can read.` };
  const [, cents = ''] = bare.split('.');
  if (cents.length > 2) return { reading: 'bad', reason: `The price "${text}" has more than 2 decimal places.` };
  const value = Number(bare.replace(/,/g, ''));
  if (!(value > 0)) return { reading: 'bad', reason: 'The price is zero. Swift never sells an item for nothing from a file.' };
  if (value > MAX_PRICE) return { reading: 'bad', reason: `The price is over Swift's limit of ${MAX_PRICE.toLocaleString('en-US')}.` };
  return { reading: 'ok', value };
}

/** A stock count: whole units, zero or more. "12", "1,200", "12.000" read; "2.5" and "-3" do not. */
export function readCount(raw: string | undefined): Reading<number> {
  const text = (raw ?? '').trim();
  if (text === '') return { reading: 'blank' };
  const negative = text.startsWith('-');
  const bare = negative ? text.slice(1) : text;
  if (!GROUPED.test(bare) && !PLAIN.test(bare)) return { reading: 'bad', reason: `The stock "${text}" is not a number Swift can read.` };
  const value = Number(bare.replace(/,/g, ''));
  if (negative && value !== 0) return { reading: 'bad', reason: 'The stock is below zero in the file.' };
  if (!Number.isInteger(value)) return { reading: 'bad', reason: `The stock "${text}" is not a whole number. Swift counts whole units.` };
  if (value > MAX_COUNT) return { reading: 'bad', reason: `The stock is over Swift's limit of ${MAX_COUNT.toLocaleString('en-US')}.` };
  return { reading: 'ok', value };
}

/** An item of the store, as the plan reads it. */
export interface StoreItem {
  id: string;
  name: string;
  sku: string | null;
  basePrice: Prisma.Decimal | number;
  stockQuantity: number | null;
  isAvailable: boolean;
  autoHiddenAt: Date | null;
}

export interface ChangeView {
  row: number;
  sku: string;
  itemId: string;
  name: string;
  fileName: string;
  /** from -> to on Swift; `till` is the file's count and `held` the units in open orders taken off it. */
  stock: { from: number | null; to: number | null; till: number; held: number } | null;
  price: { from: number; to: number } | null;
  soldOut: SoldOutEffect | null;
  notes: string[];
}

export interface NewItemView {
  row: number; sku: string; name: string; category: string; description: string; unit: string;
  price: number; stock: number | null; isAvailable: boolean;
}

export interface SyncView {
  missingPolicy: MissingPolicy;
  changes: ChangeView[];
  unchanged: number;
  newItems: NewItemView[];
  needsAttention: Array<{ row: number; sku: string; name: string; reason: string }>;
  missing: Array<{ itemId: string; sku: string; name: string; action: 'LEAVE' | 'SWITCH_OFF' | 'ALREADY_OFF' }>;
  notOnSku: number;
  totals: {
    rows: number; matched: number; stockChanges: number; priceChanges: number; becomeSoldOut: number;
    backOnSale: number; switchedOffByTill: number; newItems: number; needsAttention: number; missing: number;
    switchedOffMissing: number; unchanged: number;
  };
}

interface MatchedRow {
  row: number;
  item: StoreItem;
  fileName: string;
  sku: string;
  /** The till's count; null = the file gave none. */
  count: number | null;
  /** The file's price; null = the file gave none. */
  price: number | null;
  /** The till says this item is not for sale. */
  tillOff: boolean;
}

export interface SyncPlan {
  view: SyncView;
  digest: string;
  matched: MatchedRow[];
  switchOffIds: string[];
}

const FIELD_LIMITS = { name: 150, category: 100, description: 2000, unit: 30, sku: 64 } as const;

/**
 * Build the plan for one store. Pure: the same file against the same store
 * state gives the same plan, and the digest covers what will be WRITTEN
 * (which items, to which counts and prices, which new items, which switch-offs)
 * but not the current values — so a sale between preview and confirm does not
 * make the preview stale, while any change to WHAT gets applied does.
 */
export function buildSyncPlan(input: {
  vendorId: string;
  contentHash: string;
  rows: Array<Record<string, string>>;
  items: StoreItem[];
  missingPolicy: MissingPolicy;
  canAddNew: boolean;
  /** Units of each item sold on Swift in orders not yet collected (still on the till's shelf). */
  held?: Map<string, number>;
}): SyncPlan {
  const { rows, items, missingPolicy } = input;
  const held = input.held ?? new Map<string, number>();

  const store = new Map<string, StoreItem[]>();
  let notOnSku = 0;
  for (const item of items) {
    const key = skuKey(item.sku);
    if (!key) { notOnSku += 1; continue; }
    store.set(key, [...(store.get(key) ?? []), item]);
  }

  const inFile = new Map<string, number>();
  for (const r of rows) {
    const key = skuKey(r['sku']);
    if (key) inFile.set(key, (inFile.get(key) ?? 0) + 1);
  }

  const needsAttention: SyncView['needsAttention'] = [];
  const matched: MatchedRow[] = [];
  const newItems: NewItemView[] = [];

  rows.forEach((r, index) => {
    const rowNo = index + 2; // 1-based, after the header
    const sku = (r['sku'] ?? '').trim();
    const key = skuKey(sku);
    const name = (r['name'] ?? '').trim();
    const refuse = (reason: string) => needsAttention.push({ row: rowNo, sku, name, reason });

    if (!key) return refuse('No SKU in the file. Swift only updates items it can match by SKU, so this row was not used.');
    if ((inFile.get(key) ?? 0) > 1) return refuse(`This SKU is in the file ${inFile.get(key)} times. Fix the file so each SKU appears once.`);
    if (sku.length > FIELD_LIMITS.sku) return refuse(`The SKU is longer than ${FIELD_LIMITS.sku} characters.`);
    const owners = store.get(key) ?? [];
    if (owners.length > 1) return refuse(`${owners.length} items in your store have this SKU. Give each one its own SKU on Swift first.`);

    const price = readPrice(r['basePrice']);
    if (price.reading === 'bad') return refuse(price.reason);
    const count = readCount(r['stockQuantity']);
    if (count.reading === 'bad') return refuse(count.reason);
    const available = (r['isAvailable'] ?? '').trim();
    if (available !== '' && available !== 'true' && available !== 'false') {
      return refuse(`The "available for sale" cell says "${available}". It should say yes or no.`);
    }

    if (owners.length === 1) {
      matched.push({
        row: rowNo, item: owners[0]!, fileName: name, sku,
        count: count.reading === 'ok' ? count.value : null,
        price: price.reading === 'ok' ? price.value : null,
        tillOff: available === 'false',
      });
      return;
    }

    // A SKU the store does not have yet: a new item, if the file says enough.
    const category = (r['category'] ?? '').trim();
    const lacking = [!name && 'a name', !category && 'a category', price.reading !== 'ok' && 'a price'].filter(Boolean);
    if (lacking.length > 0) return refuse(`This SKU is not in your store yet, and a new item needs ${lacking.join(', ')}.`);
    const description = (r['description'] ?? '').trim();
    const unit = (r['unit'] ?? '').trim();
    for (const [field, value] of [['name', name], ['category', category], ['description', description], ['unit', unit]] as const) {
      if (value.length > FIELD_LIMITS[field]) return refuse(`The ${field} is longer than ${FIELD_LIMITS[field]} characters.`);
    }
    if (!input.canAddNew) return refuse('Swift has to verify your store before new items can be listed. Your existing items were still updated.');
    newItems.push({
      row: rowNo, sku, name, category, description, unit,
      price: (price as { value: number }).value,
      stock: count.reading === 'ok' ? count.value : null,
      isAvailable: available !== 'false',
    });
  });

  // Items on Swift whose SKU the file never mentions (a SKU that needs
  // attention IS mentioned: it is not missing, it is unresolved).
  const missing: SyncView['missing'] = [];
  const switchOffIds: string[] = [];
  for (const [key, owners] of store) {
    if (inFile.has(key)) continue;
    for (const item of owners) {
      // An item the ENGINE hid at zero is switched off too: the store chose
      // "sold out", and a later restock must not bring it back on its own.
      const action = missingPolicy === 'LEAVE'
        ? 'LEAVE'
        : item.isAvailable || item.autoHiddenAt !== null ? 'SWITCH_OFF' : 'ALREADY_OFF';
      if (action === 'SWITCH_OFF') switchOffIds.push(item.id);
      missing.push({ itemId: item.id, sku: item.sku ?? '', name: item.name, action });
    }
  }
  missing.sort((a, b) => a.sku.localeCompare(b.sku));

  const changes: ChangeView[] = [];
  let unchanged = 0;
  for (const m of matched) {
    const change = describeChange(m, held.get(m.item.id) ?? 0);
    if (change) changes.push(change); else unchanged += 1;
  }

  const digest = createHash('sha256').update(JSON.stringify({
    v: 1,
    vendorId: input.vendorId,
    contentHash: input.contentHash,
    missingPolicy,
    matched: matched
      .map((m) => [m.item.id, m.item.stockQuantity === null ? null : m.count, m.price, m.tillOff])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    newItems: newItems.map((n) => [skuKey(n.sku), n.name, n.category, n.price, n.stock, n.isAvailable]).sort(),
    attention: needsAttention.map((n) => n.row).sort((a, b) => a - b),
    // What happens to each missing item, exactly as the preview said it.
    missing: missing.map((m) => [m.itemId, m.action]).sort(),
  })).digest('hex');

  const count = (effect: SoldOutEffect) => changes.filter((c) => c.soldOut === effect).length;
  const view: SyncView = {
    missingPolicy,
    changes,
    unchanged,
    newItems,
    needsAttention,
    missing,
    notOnSku,
    totals: {
      rows: rows.length,
      matched: matched.length,
      stockChanges: changes.filter((c) => c.stock !== null).length,
      priceChanges: changes.filter((c) => c.price !== null).length,
      becomeSoldOut: count('BECOMES_SOLD_OUT'),
      backOnSale: count('BACK_ON_SALE'),
      switchedOffByTill: count('SWITCHED_OFF_BY_TILL'),
      newItems: newItems.length,
      needsAttention: needsAttention.length,
      missing: missing.length,
      switchedOffMissing: switchOffIds.length,
      unchanged,
    },
  };
  return { view, digest, matched, switchOffIds };
}

/** What confirming would do to one matched item, judged against its current state. Null = nothing. */
function describeChange(m: MatchedRow, heldUnits: number): ChangeView | null {
  const { item } = m;
  const notes: string[] = [];
  const from = item.stockQuantity;
  let stock: ChangeView['stock'] = null;
  if (m.count !== null) {
    if (from === null) {
      notes.push(`Swift does not count stock for this item, so the till's count (${m.count}) is not used. Turn on stock counting in the item editor to use it.`);
    } else {
      const target = Math.max(0, m.count - heldUnits);
      if (heldUnits > 0) {
        notes.push(m.count >= heldUnits
          ? `${heldUnits} of the till's ${m.count} are in Swift orders not yet collected, so Swift shows ${target}.`
          : `${heldUnits} are in Swift orders not yet collected but the till counts only ${m.count}, so Swift shows 0.`);
      }
      if (target !== from) stock = { from, to: target, till: m.count, held: heldUnits };
    }
  }
  const currentPrice = Number(item.basePrice);
  const price = m.price !== null && m.price !== currentPrice ? { from: currentPrice, to: m.price } : null;

  // Sold out, by the engine's own edges (see applyAvailabilityEdges).
  let soldOut: SoldOutEffect | null = null;
  const after = stock ? stock.to! : from;
  if (m.tillOff && (item.isAvailable || item.autoHiddenAt !== null)) {
    soldOut = 'SWITCHED_OFF_BY_TILL';
  } else if (stock && after !== null && after <= 0 && item.isAvailable) {
    soldOut = 'BECOMES_SOLD_OUT';
  } else if (stock && after !== null && after > 0 && !item.isAvailable) {
    soldOut = item.autoHiddenAt !== null ? 'BACK_ON_SALE' : 'STAYS_SWITCHED_OFF';
  }
  if (soldOut === 'STAYS_SWITCHED_OFF') notes.push('You switched this item off on Swift, so it stays off. Switch it back on in Swift when you want to sell it.');

  if (!stock && !price && (soldOut === null || soldOut === 'STAYS_SWITCHED_OFF')) return null;
  return { row: m.row, sku: m.sku, itemId: item.id, name: item.name, fileName: m.fileName, stock, price, soldOut, notes };
}

const ITEM_SELECT = {
  id: true, name: true, sku: true, basePrice: true, stockQuantity: true, isAvailable: true, autoHiddenAt: true,
} as const;

/** Order states in which the goods are still in the store — the states a
 *  cancellation restocks from (OrderService.restocksOnCancel, the one list). */
const GOODS_AT_STORE: OrderStatus[] = (Object.values(OrderStatus) as OrderStatus[]).filter((s) => OrderService.restocksOnCancel(s));

/**
 * Units of each item that Swift has already taken off its count for orders
 * whose goods are still in the store. Read from the ledger: the net of every
 * movement tied to those orders (a sale, a pick, a pick refund), taken per
 * order, so one order that gave back more than it took never cancels what
 * another order still holds.
 */
export async function unitsHeldByOpenOrders(
  db: Prisma.TransactionClient,
  vendorId: string,
  itemIds: string[],
): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const open = await db.order.findMany({ where: { vendorId, status: { in: GOODS_AT_STORE } }, select: { id: true } });
  if (open.length === 0) return new Map();
  const sums = await db.stockMovement.groupBy({
    by: ['itemId', 'orderId'],
    where: { orderId: { in: open.map((o) => o.id) }, itemId: { in: itemIds } },
    _sum: { delta: true },
  });
  const held = new Map<string, number>();
  for (const s of sums) {
    const units = -(s._sum.delta ?? 0);
    if (units > 0) held.set(s.itemId, (held.get(s.itemId) ?? 0) + units);
  }
  return held;
}

/** Tracked store items a file row names (the only ones whose held units matter). */
function trackedSkuItemIds(items: StoreItem[], rows: Array<Record<string, string>>): string[] {
  const keys = new Set(rows.map((r) => skuKey(r['sku'])).filter(Boolean));
  return items.filter((i) => i.stockQuantity !== null && keys.has(skuKey(i.sku))).map((i) => i.id);
}

/** The preview: the plan against the store as it is now. Reads only. */
export async function previewSync(
  db: Prisma.TransactionClient,
  input: { vendorId: string; csv: string; rows: Array<Record<string, string>>; missingPolicy: MissingPolicy; canAddNew: boolean },
) {
  const contentHash = contentHashOf(input.csv);
  const items = await db.item.findMany({ where: { vendorId: input.vendorId }, select: ITEM_SELECT });
  const held = await unitsHeldByOpenOrders(db, input.vendorId, trackedSkuItemIds(items, input.rows));
  const plan = buildSyncPlan({ vendorId: input.vendorId, contentHash, rows: input.rows, items, missingPolicy: input.missingPolicy, canAddNew: input.canAddNew, held });
  const earlier = await db.posImport.findFirst({
    where: { vendorId: input.vendorId, contentHash },
    select: { id: true, createdAt: true },
  });
  return {
    uploadId: newUploadId(),
    contentHash,
    planDigest: plan.digest,
    alreadyApplied: earlier ? { uploadId: earlier.id, appliedAt: earlier.createdAt.toISOString() } : null,
    ...plan.view,
  };
}

export interface ConfirmInput {
  vendorId: string;
  tenantId: string;
  actorId: string;
  uploadId: string;
  contentHash: string;
  planDigest: string;
  csv: string;
  rows: Array<Record<string, string>>;
  missingPolicy: MissingPolicy;
  canAddNew: boolean;
  now?: Date;
}

export type ConfirmResult = SyncView & { uploadId: string; contentHash: string; appliedAt: string; replayed: boolean };

/** Prices listed in the audit row (the full list is in the PosImport summary). */
const AUDIT_PRICE_LINES = 200;

/**
 * Confirm: re-derive the plan under the store's lock and apply it, or refuse.
 *
 * The vendor row lock is the one checkout takes before it moves stock, so a
 * confirm and a checkout at the same store never interleave (and cannot
 * deadlock: both lock the vendor first, then items in id order). It also
 * serialises two confirms of one store, which is what makes a double-click a
 * replay.
 *
 * Every write is SET-BASED, so the lock is held for a handful of statements
 * whatever the size of the file: one UPDATE for the prices, the single
 * writer's batch (one UPDATE + one INSERT) for the counts, one UPDATE per
 * sold-out rule, one INSERT for new items (+ their opening balances). A
 * checkout that does meet the lock waits a bounded time and is told the store
 * is updating (order.service: STORE_BUSY), never a server error.
 */
export async function confirmSync(
  db: { $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, opts?: { timeout?: number; maxWait?: number }) => Promise<T> },
  input: ConfirmInput,
): Promise<ConfirmResult> {
  if (contentHashOf(input.csv) !== input.contentHash) {
    throw new AppError(409, 'PREVIEW_STALE', 'This is not the file you previewed. Preview it again before you apply it.');
  }
  const run = () => db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "vendors" WHERE id = ${input.vendorId} FOR UPDATE`;

    const earlier = await tx.posImport.findUnique({ where: { id: input.uploadId } });
    if (earlier) {
      if (earlier.vendorId !== input.vendorId) throw new AppError(409, 'UPLOAD_ID_TAKEN', 'Preview the file again before you apply it.');
      return { ...(earlier.summary as unknown as Omit<ConfirmResult, 'replayed'>), replayed: true };
    }
    const sameFile = await tx.posImport.findFirst({ where: { vendorId: input.vendorId, contentHash: input.contentHash } });
    if (sameFile) {
      throw new AppError(409, 'ALREADY_APPLIED',
        'You already applied this exact file, so nothing was changed. Export a fresh file from your till and upload that.',
        { uploadId: sameFile.id, appliedAt: sameFile.createdAt.toISOString() });
    }

    // Every item of the store is locked (in id order, like every other path
    // that moves several items) before it is read, so the counts the deltas
    // are taken from cannot move until this commits.
    await tx.$queryRaw`SELECT id FROM "items" WHERE "vendorId" = ${input.vendorId} ORDER BY id FOR UPDATE`;
    const items = await tx.item.findMany({ where: { vendorId: input.vendorId }, select: ITEM_SELECT });
    const held = await unitsHeldByOpenOrders(tx, input.vendorId, trackedSkuItemIds(items, input.rows));
    const plan = buildSyncPlan({
      vendorId: input.vendorId, contentHash: input.contentHash, rows: input.rows, items,
      missingPolicy: input.missingPolicy, canAddNew: input.canAddNew, held,
    });
    if (plan.digest !== input.planDigest) {
      throw new AppError(409, 'PREVIEW_STALE', 'Your store changed since the preview, so it no longer shows what would happen. Preview the file again.');
    }

    const now = input.now ?? new Date();
    const { changes } = plan.view;

    // Prices: one statement.
    const prices = changes.filter((c) => c.price);
    if (prices.length > 0) {
      const values = Prisma.join(prices.map((c) => Prisma.sql`(${c.itemId}::text, ${c.price!.to.toFixed(2)}::numeric)`));
      const priced = await tx.$executeRaw`
        UPDATE "items" AS i SET "basePrice" = v.price, "updatedAt" = now()
          FROM (VALUES ${values}) AS v(id, price)
         WHERE i.id = v.id AND i."vendorId" = ${input.vendorId}`;
      if (priced !== prices.length) throw new AppError(409, 'PREVIEW_STALE', 'Your store changed while the file was being applied. Preview it again.');
    }

    // Counts: the single writer's batch, then the inventory engine's two edges.
    const counts = changes.filter((c) => c.stock && c.stock.from !== null && c.stock.to !== null);
    const moved = await applyStockMovements(tx, {
      vendorId: input.vendorId,
      tenantId: input.tenantId,
      entries: counts.map((c) => ({ itemId: c.itemId, delta: c.stock!.to! - c.stock!.from! })),
      reason: 'POS_IMPORT',
      actorId: input.actorId,
      note: `Till export ${input.uploadId}`,
    });
    const movedIds = [...moved.keys()];
    if (movedIds.length > 0) {
      // Zero hides an item that is switched on (marked as the engine's hide)...
      await tx.item.updateMany({
        where: { id: { in: movedIds }, vendorId: input.vendorId, stockQuantity: { lte: 0 }, isAvailable: true },
        data: { isAvailable: false, autoHiddenAt: now },
      });
      // ...and a restock brings back only an item the engine hid. The owner's
      // own "off" carries no marker, so it is never undone.
      await tx.item.updateMany({
        where: { id: { in: movedIds }, vendorId: input.vendorId, autoHiddenAt: { not: null }, stockQuantity: { gt: 0 } },
        data: { isAvailable: true, autoHiddenAt: null },
      });
    }

    // The till says "not for sale", and items missing from the file when the
    // store chose "mark them sold out": switched off the way the owner would.
    const switchOff = [
      ...changes.filter((c) => c.soldOut === 'SWITCHED_OFF_BY_TILL').map((c) => c.itemId),
      ...plan.switchOffIds,
    ];
    if (switchOff.length > 0) {
      await tx.item.updateMany({
        where: { id: { in: switchOff }, vendorId: input.vendorId },
        data: { isAvailable: false, autoHiddenAt: null },
      });
    }

    if (plan.view.newItems.length > 0) {
      const wanted = new Map(plan.view.newItems.map((n) => [n.category.toLowerCase(), n.category]));
      const existing = await tx.category.findMany({ where: { vendorId: input.vendorId }, select: { id: true, name: true } });
      const have = new Set(existing.map((c) => c.name.toLowerCase()));
      const missingCategories = [...wanted.entries()].filter(([k]) => !have.has(k)).map(([, name]) => name);
      if (missingCategories.length > 0) {
        await tx.category.createMany({
          data: missingCategories.map((name, i) => ({ vendorId: input.vendorId, name, sortOrder: existing.length + i })),
        });
      }
      const categories = await tx.category.findMany({ where: { vendorId: input.vendorId }, select: { id: true, name: true } });
      const categoryIds = new Map<string, string>();
      for (const c of categories) if (!categoryIds.has(c.name.toLowerCase())) categoryIds.set(c.name.toLowerCase(), c.id);

      const created = await tx.item.createManyAndReturn({
        data: plan.view.newItems.map((n) => {
          // Born sold out when the till has none, so a restock brings it in.
          const bornEmpty = n.stock === 0 && n.isAvailable;
          return {
            vendorId: input.vendorId, categoryId: categoryIds.get(n.category.toLowerCase())!,
            name: n.name, description: n.description || null, basePrice: n.price, sku: n.sku, unit: n.unit || null,
            isAvailable: n.isAvailable && !bornEmpty, autoHiddenAt: bornEmpty ? now : null,
            fulfillment: 'DELIVERY' as const, dietaryTags: [], allergens: [],
          };
        }),
        select: { id: true, sku: true },
      });
      if (created.length !== plan.view.newItems.length) throw new AppError(500, 'NEW_ITEMS_MISMATCH', 'New items were not all created');
      // [F2] The ledger explains the count each item is born with.
      const idBySku = new Map(created.map((c) => [skuKey(c.sku), c.id]));
      await recordOpeningBalances(tx, {
        vendorId: input.vendorId,
        tenantId: input.tenantId,
        actorId: input.actorId,
        entries: plan.view.newItems
          .filter((n) => n.stock !== null)
          .map((n) => ({ itemId: idBySku.get(skuKey(n.sku))!, quantity: n.stock! })),
      });
    }

    const summary: Omit<ConfirmResult, 'replayed'> = {
      ...plan.view,
      uploadId: input.uploadId,
      contentHash: input.contentHash,
      appliedAt: now.toISOString(),
    };
    await tx.posImport.create({
      data: {
        id: input.uploadId, vendorId: input.vendorId, tenantId: input.tenantId, contentHash: input.contentHash,
        planDigest: plan.digest, missingPolicy: input.missingPolicy, actorId: input.actorId,
        summary: summary as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: input.actorId,
        action: 'POS_IMPORT_APPLIED',
        entity: 'Vendor',
        entityId: input.vendorId,
        changes: {
          uploadId: input.uploadId,
          contentHash: input.contentHash,
          missingPolicy: input.missingPolicy,
          ...plan.view.totals,
          prices: prices.slice(0, AUDIT_PRICE_LINES).map((c) => ({ itemId: c.itemId, sku: c.sku, from: c.price!.from, to: c.price!.to })),
          pricesListed: Math.min(prices.length, AUDIT_PRICE_LINES),
        },
      },
    });
    return { ...summary, replayed: false };
  }, { timeout: 60_000, maxWait: 10_000 });

  try {
    return await run();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // A racer committed the same upload or the same file first; answer as it would have.
      return run();
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2034' || err.code === 'P2028')) {
      throw new AppError(409, 'STORE_BUSY', 'Your store was busy with orders for a moment. Try again.');
    }
    throw err;
  }
}
