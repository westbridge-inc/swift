import { money } from '../../lib/money';

type WireRecord = Record<string, unknown>;

const FEE_TYPES = new Set(['DELIVERY_FEE', 'COURIER_FEE', 'TAXI_FARE']);
const COMPLETED_STATUSES = new Set(['DELIVERED', 'COMPLETED']);

export function serverRecord(value: unknown): WireRecord | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as WireRecord
    : undefined;
}

export function serverRecords(value: unknown): WireRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const record = serverRecord(row);
    return record ? [record] : [];
  });
}

/** Preserve a real server zero while rejecting every absent or malformed value. */
export function serverNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function serverCount(value: unknown): number | undefined {
  const parsed = serverNumber(value);
  return parsed != null && parsed >= 0 && Number.isInteger(parsed) ? parsed : undefined;
}

export function serverText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function serverDate(value: unknown): string | undefined {
  const text = serverText(value);
  return text && !Number.isNaN(new Date(text).getTime()) ? text : undefined;
}

export function moneyOrDash(value: unknown): string {
  const amount = serverNumber(value);
  return amount == null ? '—' : money(amount);
}

/** Live summary windows are objects; the read-only preview still uses bare totals. */
export function earningsWindowTotal(
  summary: unknown,
  liveKey: string,
  previewKey?: string,
): number | undefined {
  const source = serverRecord(summary);
  if (!source) return undefined;
  const raw = source[liveKey] ?? (previewKey ? source[previewKey] : undefined);
  const window = serverRecord(raw);
  return serverNumber(window ? window['total'] : raw);
}

export function earningRows(payload: unknown): WireRecord[] {
  if (Array.isArray(payload)) return serverRecords(payload);
  const source = serverRecord(payload);
  if (!source) return [];
  const rows = Array.isArray(source['data'])
    ? source['data']
    : Array.isArray(source['earnings'])
      ? source['earnings']
      : [];
  return serverRecords(rows);
}

export function hasEarningRowsPayload(payload: unknown): boolean {
  const source = serverRecord(payload);
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(source?.['data'])
      ? source['data']
      : Array.isArray(source?.['earnings'])
        ? source['earnings']
        : undefined;
  return Array.isArray(raw) && serverRecords(raw).length === raw.length;
}

export function recentEarningsBreakdown(
  rows: WireRecord[],
): { fees?: number; tips?: number } | undefined {
  if (rows.length === 0) return undefined;
  let fees = 0;
  let tips = 0;
  let sawFee = false;
  let sawTip = false;
  for (const row of rows) {
    const type = serverText(row['type'])?.toUpperCase();
    const amount = serverNumber(row['amount']);
    if (!type || amount == null || (type !== 'TIP' && !FEE_TYPES.has(type))) return undefined;
    if (type === 'TIP') {
      sawTip = true;
      tips += amount;
    } else {
      sawFee = true;
      fees += amount;
    }
  }
  return {
    ...(sawFee ? { fees } : {}),
    ...(sawTip ? { tips } : {}),
  };
}

const EARNING_LABELS: Record<string, string> = {
  DELIVERY_FEE: 'Delivery',
  COURIER_FEE: 'Courier',
  TAXI_FARE: 'Taxi ride',
  TIP: 'Tip',
};

export function earningLabel(value: unknown): string | undefined {
  const type = serverText(value)?.toUpperCase();
  if (!type) return undefined;
  if (EARNING_LABELS[type]) return EARNING_LABELS[type];
  const words = type.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function isCompletedStatus(value: unknown): boolean {
  const status = serverText(value)?.toUpperCase();
  return !!status && COMPLETED_STATUSES.has(status);
}

/**
 * History exposes earned delivery totals, but only quoted fields for taxis.
 * A completed taxi's ledger is minted from fare + tip, so that sum is safe;
 * cancelled/nonterminal rows have no earned-amount field and deliberately dash.
 */
export function historyEarningAmount(job: unknown, isDriver: boolean): number | undefined {
  const row = serverRecord(job);
  if (!row || !isCompletedStatus(row['status'])) return undefined;
  if (!isDriver) return serverNumber(row['totalEarning']);
  const fare = serverNumber(row['taxiFareTotal']);
  if (fare == null) return undefined;
  const tip = serverNumber(row['tipAmount']);
  return tip == null ? fare : fare + tip;
}

export function historyTip(job: unknown): number | undefined {
  const row = serverRecord(job);
  if (!row || !isCompletedStatus(row['status'])) return undefined;
  const tip = serverNumber(row['tipAmount']);
  return tip != null && tip > 0 ? tip : undefined;
}

export function historyItemSummary(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((item) => {
    const row = serverRecord(item);
    const name = serverText(row?.['name']);
    if (!name) return [];
    const quantity = serverCount(row?.['quantity']);
    return [quantity == null ? name : `${quantity}× ${name}`];
  });
  return items.length ? items.join(' · ') : undefined;
}

/** A page refetch replaces matching ids instead of duplicating loaded history. */
export function mergeUniqueRows<T extends WireRecord>(previous: T[], incoming: T[]): T[] {
  const next = [...previous];
  const positions = new Map<string, number>();
  next.forEach((row, index) => {
    const id = serverText(row['id']);
    if (id) positions.set(id, index);
  });
  for (const row of incoming) {
    const id = serverText(row['id']);
    if (!id) continue;
    const at = positions.get(id);
    if (at == null) {
      positions.set(id, next.length);
      next.push(row);
    } else {
      next[at] = row;
    }
  }
  return next;
}
