import type { OrderStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// FUL-008: order SLA clocks (Fulfillment Part 10B — dwell time per state).
//
// An order that silently sits too long in one state is a failing order nobody
// is looking at: a vendor who accepted but never cooks, food that's ready but
// no rider collects it, a rider who picked up but never arrives. This computes
// the dwell time in each stage of a delivery order from its first-class state
// timestamps and flags the ones over their SLA — so ops can watch a live
// "breaching orders" board instead of finding out from an angry customer.
//
// Stages (delivery path):
//   ACCEPT       placedAt   → acceptedAt    (vendor took the order)
//   PREP         acceptedAt → readyAt       (kitchen cooked it)
//   PICKUP_WAIT  readyAt    → pickedUpAt    (rider collected it — food cooling)
//   DELIVERY     pickedUpAt → deliveredAt   (rider reached the customer)
//
// Pure and timestamp-driven: no schema change, no event-log parsing.
// ---------------------------------------------------------------------------

export type SlaStage = 'ACCEPT' | 'PREP' | 'PICKUP_WAIT' | 'DELIVERY';

export interface SlaThresholdsMin {
  accept: number;
  prep: number;
  pickupWait: number;
  delivery: number;
}

/** Operational tunables — env-overridable per deployment (CountryConfig can
 *  layer on top later). Defaults are conservative Georgetown-scale minutes. */
export function defaultSlaThresholds(): SlaThresholdsMin {
  const min = (key: string, def: number) => {
    const v = Number(process.env[key]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return {
    accept: min('SLA_ACCEPT_MIN', 5),
    prep: min('SLA_PREP_MIN', 25),
    pickupWait: min('SLA_PICKUP_WAIT_MIN', 10),
    delivery: min('SLA_DELIVERY_MIN', 30),
  };
}

const TERMINAL: OrderStatus[] = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];

/** The subset of an Order this engine reads — keeps it decoupled from the row. */
export interface SlaOrderInput {
  id: string;
  status: OrderStatus;
  placedAt: Date;
  acceptedAt: Date | null;
  readyAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
}

export interface SlaStageResult {
  stage: SlaStage;
  startedAt: Date;
  endedAt: Date | null; // null = still running (live order)
  elapsedMs: number;
  thresholdMs: number;
  breached: boolean;
  open: boolean;
}

export interface OrderSla {
  orderId: string;
  status: OrderStatus;
  stages: SlaStageResult[];
  openStage: SlaStage | null; // the stage whose clock is still ticking, if any
  breached: boolean; // any stage over its threshold
  worstOverMs: number; // how far past threshold the worst stage is (0 if none)
}

/**
 * Compute per-stage dwell + SLA breaches for one delivery order.
 *
 * A stage counts only if it has started (its start timestamp exists). Its end
 * is the recorded timestamp, or — while the order is still live — `now` (the
 * clock is running). For a terminal order a stage that never recorded its end
 * (e.g. cancelled mid-prep) is frozen at the terminal time, never `now`, so it
 * doesn't count up forever.
 */
export function computeOrderSla(
  order: SlaOrderInput,
  now: Date,
  thresholds: SlaThresholdsMin = defaultSlaThresholds(),
): OrderSla {
  const isTerminal = TERMINAL.includes(order.status);
  const terminalAt = order.deliveredAt ?? order.cancelledAt ?? now;

  const defs: Array<{ stage: SlaStage; start: Date | null; end: Date | null; thrMin: number }> = [
    { stage: 'ACCEPT', start: order.placedAt, end: order.acceptedAt, thrMin: thresholds.accept },
    { stage: 'PREP', start: order.acceptedAt, end: order.readyAt, thrMin: thresholds.prep },
    { stage: 'PICKUP_WAIT', start: order.readyAt, end: order.pickedUpAt, thrMin: thresholds.pickupWait },
    { stage: 'DELIVERY', start: order.pickedUpAt, end: order.deliveredAt, thrMin: thresholds.delivery },
  ];

  const stages: SlaStageResult[] = [];
  let openStage: SlaStage | null = null;
  let worstOverMs = 0;

  for (const d of defs) {
    if (!d.start) continue; // stage never started
    const open = !d.end && !isTerminal;
    const effectiveEnd = d.end ?? (isTerminal ? terminalAt : now);
    const elapsedMs = Math.max(0, effectiveEnd.getTime() - d.start.getTime());
    const thresholdMs = d.thrMin * 60_000;
    const breached = elapsedMs > thresholdMs;
    if (open) openStage = d.stage;
    if (breached) worstOverMs = Math.max(worstOverMs, elapsedMs - thresholdMs);
    stages.push({ stage: d.stage, startedAt: d.start, endedAt: d.end, elapsedMs, thresholdMs, breached, open });
  }

  return {
    orderId: order.id,
    status: order.status,
    stages,
    openStage,
    breached: worstOverMs > 0,
    worstOverMs,
  };
}
