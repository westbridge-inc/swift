import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { OrderService } from '../order/order.service';
import { AppError, NotFoundError } from '../../utils/errors';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Ops agent (spec Part B) — ON by default wherever an ANTHROPIC_API_KEY is
// configured (i.e. production); set AGENT_ENABLED=0 to disable. Founder decision
// 2026-07-25 ("the app should run automatically") — the agent auto-activates
// once the key is present. Dev/test/CI have no key → it stays off, no surprise
// LLM cost. Default mode is `assist`: it acts on the safe things and routes the
// one dangerous action (cancel) through human approval.
//
// Division of labour, per the hard rules:
//   - DETECTION is deterministic SQL (thresholds, never a model).
//   - The model only CLASSIFIES a PII-free snapshot (ids, states, minutes —
//     no names, phones, addresses or free text) into ONE action from a fixed
//     allowlist. Hard rule 3 holds by construction: nothing scrubbable is
//     ever sent because nothing free-form is included.
//   - EXECUTION is deterministic services through the gate: safe actions may
//     auto-run; money-adjacent ones (cancel) always wait for a human in
//     `assist` mode (the default). Money is never an AI call — the AI only
//     files a request a human decides.
// ---------------------------------------------------------------------------

export type AgentMode = 'suggest' | 'assist' | 'auto';

export const SENSITIVE_ACTIONS = new Set(['request_cancel']);
export const SAFE_ACTIONS = new Set(['requeue_dispatch', 'ping_vendor', 'notify_customer_delay', 'ops_alert']);

export interface OpsDecision {
  likelyCause: string;
  recommendedAction: 'requeue_dispatch' | 'ping_vendor' | 'notify_customer_delay' | 'request_cancel' | 'ops_alert' | 'none';
  urgency: 'low' | 'medium' | 'high';
  rationale: string;
}

/** PII-free by construction: enums, ids, counts and minutes only. */
export interface ProblemSnapshot {
  orderId: string;
  problem: 'unaccepted' | 'unassigned' | 'not_picked_up' | 'overdue' | 'taxi_unmatched';
  orderType: string;
  fulfillment: string | null;
  status: string;
  isExpress: boolean;
  paymentMethod: string;
  minutesSincePlaced: number;
  minutesInCurrentStatus: number;
  estimatedDeliveryMinutes: number | null;
  hasRider: boolean;
  hasDriver: boolean;
  vendorAcceptingOrders: boolean | null;
  timeline: Array<{ status: string; minutesAgo: number }>;
}

export function agentEnabled(): boolean {
  // On by default when a key is present; AGENT_ENABLED=0 is the explicit off switch.
  return process.env['AGENT_ENABLED'] !== '0' && Boolean(process.env['ANTHROPIC_API_KEY']);
}

export function agentMode(): AgentMode {
  const mode = process.env['AGENT_MODE'];
  return mode === 'suggest' || mode === 'auto' ? mode : 'assist';
}

const SCAN_CAP = () => Math.max(1, Number(process.env['AGENT_MAX_ORDERS_PER_RUN'] ?? 25));
const LLM_TIMEOUT_MS = () => Math.max(1000, Number(process.env['AGENT_LLM_TIMEOUT_MS'] ?? 20_000));
const OPS_MODEL = () => process.env['AGENT_MODEL_OPS'] ?? 'claude-haiku-4-5-20251001';

const OPS_PROMPT =
  "You are Swift's operations agent for a Caribbean delivery + taxi platform. " +
  'You receive a read-only snapshot of ONE problem order: ids, states and timings only. ' +
  'Identify the single most likely cause and choose exactly one recommendedAction. ' +
  'Prefer the least invasive action that resolves it: requeue_dispatch when no mover is attached and dispatch likely stalled; ' +
  'ping_vendor when the vendor is sitting on an unaccepted or unprepared order; ' +
  'notify_customer_delay when work is progressing but late; ' +
  'ops_alert when a human should look but nothing mechanical helps; ' +
  'request_cancel ONLY when the order is clearly dead (it requires human approval); ' +
  "none when the snapshot doesn't justify acting. Respond via the decide tool only.";

export class AgentService {
  private notifications: NotificationService;
  private orders: OrderService;

  constructor(
    private prisma: PrismaClient,
    private io: Server,
    /** Enqueue a dispatch-order job (the existing cascade). */
    private enqueueDispatch: (orderId: string) => Promise<void>,
    /** Injectable model call for tests. Defaults to the Anthropic API. */
    private modelCall: (system: string, user: string) => Promise<OpsDecision | null> = defaultModelCall,
  ) {
    this.notifications = new NotificationService(prisma, io);
    this.orders = new OrderService(prisma, io);
  }

  // -------------------------------------------------------------------------
  // Detection — deterministic thresholds, no model involved
  // -------------------------------------------------------------------------

  async findProblems(now = new Date()): Promise<ProblemSnapshot[]> {
    const min = (m: number) => new Date(now.getTime() - m * 60_000);
    const notHeld = { OR: [{ holdExpiresAt: null }, { holdExpiresAt: { lte: now } }] };
    // An ACTIVE incident window: stuck-for-20-minutes is an ops problem the
    // agent can still save; stuck-since-yesterday is dead history the daily
    // reconcile sweep owns. Without the bound, ancient orders re-enter every
    // scan forever, fill the cap, and drown fresh incidents.
    const ACTIVE_WINDOW = { gte: min(24 * 60) };
    // Oldest active problem first — deterministic under the cap, and the
    // most-stuck order is exactly the one to look at first.
    const oldestFirst = { updatedAt: 'asc' as const };

    const [unaccepted, unassigned, notPickedUp, taxiUnmatched] = await Promise.all([
      // Released but the vendor never accepted
      this.prisma.order.findMany({
        where: { status: 'PENDING', orderType: { not: 'TAXI' }, placedAt: { lt: min(15), ...ACTIVE_WINDOW }, ...notHeld },
        take: SCAN_CAP(),
        orderBy: oldestFirst,
        include: PROBLEM_INCLUDE,
      }),
      // Accepted/prepared but no rider bound long past release
      this.prisma.order.findMany({
        where: {
          status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
          fulfillment: 'DELIVERY',
          orderType: { not: 'TAXI' },
          riderId: null,
          updatedAt: { lt: min(20), ...ACTIVE_WINDOW },
          ...notHeld,
        },
        take: SCAN_CAP(),
        orderBy: oldestFirst,
        include: PROBLEM_INCLUDE,
      }),
      // A rider owns it but the parcel never left
      this.prisma.order.findMany({
        where: {
          status: { in: ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'] },
          updatedAt: { lt: min(25), ...ACTIVE_WINDOW },
        },
        take: SCAN_CAP(),
        orderBy: oldestFirst,
        include: PROBLEM_INCLUDE,
      }),
      // Taxi request that never matched
      this.prisma.order.findMany({
        where: { status: 'PENDING', orderType: 'TAXI', placedAt: { lt: min(6), ...ACTIVE_WINDOW } },
        take: SCAN_CAP(),
        orderBy: oldestFirst,
        include: PROBLEM_INCLUDE,
      }),
    ]);

    const seen = new Set<string>();
    const snapshots: ProblemSnapshot[] = [];
    const add = (rows: typeof unaccepted, problem: ProblemSnapshot['problem']) => {
      for (const o of rows) {
        if (seen.has(o.id)) continue;
        seen.add(o.id);
        snapshots.push(this.snapshot(o, problem, now));
      }
    };
    add(unaccepted, 'unaccepted');
    add(unassigned, 'unassigned');
    add(notPickedUp, 'not_picked_up');
    add(taxiUnmatched, 'taxi_unmatched');
    return snapshots.slice(0, SCAN_CAP());
  }

  private snapshot(o: ProblemOrder, problem: ProblemSnapshot['problem'], now: Date): ProblemSnapshot {
    return {
      orderId: o.id,
      problem,
      orderType: o.orderType,
      fulfillment: o.fulfillment,
      status: o.status,
      isExpress: o.isExpress,
      paymentMethod: o.paymentMethod,
      minutesSincePlaced: Math.round((now.getTime() - o.placedAt.getTime()) / 60_000),
      minutesInCurrentStatus: Math.round((now.getTime() - o.updatedAt.getTime()) / 60_000),
      estimatedDeliveryMinutes: o.estimatedDeliveryTime,
      hasRider: !!o.riderId,
      hasDriver: !!o.driverId,
      vendorAcceptingOrders: o.vendor?.acceptingOrders ?? null,
      timeline: o.statusHistory.map((h) => ({
        status: h.status,
        minutesAgo: Math.round((now.getTime() - h.createdAt.getTime()) / 60_000),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // One scan: detect → classify → gate → act. Every step fail-safe.
  // -------------------------------------------------------------------------

  async runOpsScan(now = new Date()): Promise<{ scanned: number; executed: number; queued: number; suggested: number; errors: number }> {
    const out = { scanned: 0, executed: 0, queued: 0, suggested: 0, errors: 0 };
    if (!agentEnabled()) return out;

    const problems = await this.findProblems(now);
    for (const snapshot of problems) {
      out.scanned += 1;

      // One open request per problem — a scan every minute must not re-file.
      const actionKey = `${snapshot.problem}:${snapshot.orderId}`;
      const openRequest = await this.prisma.agentActionRequest.findUnique({ where: { actionKey } });
      if (openRequest && openRequest.status === 'PENDING') continue;
      const recentlyHandled = await this.prisma.agentAuditEvent.findFirst({
        where: { subjectId: snapshot.orderId, at: { gte: new Date(now.getTime() - 30 * 60_000) }, outcome: { in: ['executed', 'auto_executed', 'suggested'] } },
      });
      if (recentlyHandled) continue;

      let decision: OpsDecision | null = null;
      try {
        decision = await this.modelCall(OPS_PROMPT, JSON.stringify(snapshot));
      } catch (err) {
        log().error({ err, orderId: snapshot.orderId }, 'agent: model call failed — order untouched');
      }
      if (!decision || decision.recommendedAction === 'none') {
        if (!decision) out.errors += 1;
        await this.audit('ops', snapshot.orderId, 'diagnose', snapshot, decision ? 'suggested' : 'error', decision?.rationale ?? 'model unavailable');
        continue;
      }

      const outcome = await this.gate(decision.recommendedAction, snapshot, decision);
      if (outcome === 'executed') out.executed += 1;
      else if (outcome === 'pending_approval') out.queued += 1;
      else if (outcome === 'suggested') out.suggested += 1;
      else out.errors += 1;
    }
    return out;
  }

  /** §6.3 — the gate is where autonomy is enforced, never in the model. */
  private async gate(action: string, snapshot: ProblemSnapshot, decision: OpsDecision): Promise<string> {
    const mode = agentMode();
    const input = { orderId: snapshot.orderId, problem: snapshot.problem, urgency: decision.urgency };

    if (mode === 'suggest') {
      await this.audit('ops', snapshot.orderId, action, input, 'suggested', decision.rationale);
      return 'suggested';
    }

    if (SENSITIVE_ACTIONS.has(action) && mode !== 'auto') {
      try {
        await this.prisma.agentActionRequest.create({
          data: {
            action,
            input,
            reasoning: `${decision.likelyCause} — ${decision.rationale}`,
            orderId: snapshot.orderId,
            actionKey: `${snapshot.problem}:${snapshot.orderId}`,
          },
        });
      } catch {
        return 'pending_approval'; // unique actionKey: already filed
      }
      await this.audit('ops', snapshot.orderId, action, input, 'pending_approval', decision.rationale);
      await notifyAdmins(this.prisma, this.notifications, {
        // Scoped to the order the agent is acting on [NOC-A F45].
        tenantId: (await this.prisma.order.findUnique({ where: { id: snapshot.orderId }, select: { tenantId: true } }).catch(() => null))?.tenantId ?? null,
        title: 'Ops agent needs a decision',
        body: `${decision.likelyCause} — review the ${action.replaceAll('_', ' ')} request in the approval queue.`,
        data: { orderId: snapshot.orderId, kind: 'agent_approval_needed' },
      }).catch(() => {});
      return 'pending_approval';
    }

    try {
      await this.execute(action, snapshot.orderId, decision);
      await this.audit('ops', snapshot.orderId, action, input, mode === 'auto' && SENSITIVE_ACTIONS.has(action) ? 'auto_executed' : 'executed', decision.rationale);
      return 'executed';
    } catch (err) {
      log().error({ err, action, orderId: snapshot.orderId }, 'agent: action failed');
      await this.audit('ops', snapshot.orderId, action, input, 'error', (err as Error).message);
      return 'error';
    }
  }

  // -------------------------------------------------------------------------
  // Executors — every one an EXISTING deterministic pathway
  // -------------------------------------------------------------------------

  async execute(action: string, orderId: string, decision?: OpsDecision): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { vendor: { select: { id: true, owner: { select: { userId: true } } } } },
    });
    if (!order) throw new NotFoundError('Order', orderId);

    switch (action) {
      case 'requeue_dispatch': {
        if (order.riderId || order.driverId) return; // already matched — no-op
        await this.enqueueDispatch(orderId);
        return;
      }
      case 'ping_vendor': {
        if (!order.vendor) return;
        await this.notifications.send({
          userId: order.vendor.owner.userId,
          type: 'ORDER_UPDATE',
          title: 'Order waiting on you',
          body: `Order #${order.orderNumber} has been waiting ${Math.round((Date.now() - order.placedAt.getTime()) / 60_000)} min. Accept it or mark it — the customer is watching the clock.`,
          // This goes to the STORE. Untagged, it carried only an orderId, and
          // the tap-router's generic order branch sent it to the CUSTOMER
          // tracking screen — a route VendorStack never mounts, so "Order
          // waiting on you" opened the app on whatever was last there. The
          // router already routes audience:'business' + orderId to the order
          // desk; this is the server stating the fact it alone knows.
          audience: 'business',
          data: { orderId, kind: 'agent_vendor_ping' },
        });
        return;
      }
      case 'notify_customer_delay': {
        await this.notifications.send({
          userId: order.customerId,
          type: 'ORDER_UPDATE',
          title: 'Your order is taking longer than usual',
          body: `Order #${order.orderNumber} is delayed — we're on it. You can track it live in the app.`,
          data: { orderId, kind: 'agent_delay_notice' },
        });
        return;
      }
      case 'ops_alert': {
        await notifyAdmins(this.prisma, this.notifications, {
          // Scoped to the flagged order [NOC-A F45].
          tenantId: order.tenantId ?? null,
          title: `Ops attention: order #${order.orderNumber}`,
          body: decision?.likelyCause ?? 'The agent flagged this order for a human look.',
          data: { orderId, kind: 'agent_ops_alert' },
        });
        return;
      }
      case 'request_cancel': {
        // The ONLY money-adjacent action — reaches here exclusively via human
        // approval (or explicit AGENT_MODE=auto policy). The state machine's
        // CAS + centralized side effects (mover freed, sockets, the central
        // UNATTESTED status-log marker) do the work.
        const fresh = await this.prisma.order.findUnique({
          where: { id: orderId },
          select: { paymentMethod: true, paymentStatus: true },
        });
        await this.orders.updateStatus(orderId, 'CANCELLED', 'agent', decision?.likelyCause ?? 'Cancelled after ops-agent review');
        // [REPORT-011 F-01 → REPORT-012 F-012-04] Both money parties, through
        // the ONE publication seam: the CUSTOMER gets the direct-refund
        // guidance, and the STORE gets the durable liability notice — it may
        // be holding the customer's unconfirmed transfer and is the only rail
        // that can send it back.
        if (fresh?.paymentMethod === 'MOBILE_MONEY' && fresh.paymentStatus === 'PENDING') {
          const { publishUnattestedMmgCancellation } = await import('../order/order.service');
          await publishUnattestedMmgCancellation(this.prisma, this.notifications, {
            orderId,
            orderNumber: order.orderNumber,
            vendorId: order.vendor?.id ?? null,
            customer: {
              userId: order.customerId,
              title: 'Order cancelled',
              body: `Order #${order.orderNumber} was cancelled after review. If you already sent the MMG payment, the store refunds you directly.`,
              data: { kind: 'agent_cancel' },
            },
          });
        }
        return;
      }
      default:
        throw new AppError(400, 'UNKNOWN_AGENT_ACTION', `No executor for ${action}`);
    }
  }

  // -------------------------------------------------------------------------
  // Approvals — humans decide; execution replays through the same executor
  // -------------------------------------------------------------------------

  async decideRequest(id: string, decidedBy: string, approve: boolean) {
    const request = await this.prisma.agentActionRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundError('AgentActionRequest', id);
    if (request.status !== 'PENDING') {
      throw new AppError(409, 'ALREADY_DECIDED', `This request is already ${request.status.toLowerCase()}`);
    }

    if (!approve) {
      const updated = await this.prisma.agentActionRequest.update({
        where: { id },
        data: { status: 'REJECTED', decidedAt: new Date(), decidedBy },
      });
      await this.audit('approval', request.orderId, request.action, request.input as object, 'rejected', `rejected by admin`);
      return updated;
    }

    try {
      await this.execute(request.action, request.orderId!, undefined);
      const updated = await this.prisma.agentActionRequest.update({
        where: { id },
        data: { status: 'EXECUTED', decidedAt: new Date(), decidedBy },
      });
      await this.audit('approval', request.orderId, request.action, request.input as object, 'executed', `approved by admin`);
      return updated;
    } catch (err) {
      await this.prisma.agentActionRequest.update({
        where: { id },
        data: { status: 'FAILED', decidedAt: new Date(), decidedBy },
      });
      await this.audit('approval', request.orderId, request.action, request.input as object, 'error', (err as Error).message);
      throw err;
    }
  }

  private async audit(job: string, subjectId: string | null | undefined, action: string, input: object, outcome: string, reasoning?: string) {
    await this.prisma.agentAuditEvent
      .create({ data: { job, subjectId: subjectId ?? null, action, input: input as any, outcome, reasoning } })
      .catch((err) => log().error({ err }, 'agent: audit write failed'));
  }

}

const PROBLEM_INCLUDE = {
  vendor: { select: { acceptingOrders: true } },
  statusHistory: { orderBy: { createdAt: 'desc' as const }, take: 6, select: { status: true, createdAt: true } },
} as const;

type ProblemOrder = {
  id: string;
  orderType: string;
  fulfillment: string | null;
  status: string;
  isExpress: boolean;
  paymentMethod: string;
  placedAt: Date;
  updatedAt: Date;
  estimatedDeliveryTime: number | null;
  riderId: string | null;
  driverId: string | null;
  vendor: { acceptingOrders: boolean } | null;
  statusHistory: Array<{ status: string; createdAt: Date }>;
};

// ---------------------------------------------------------------------------
// Default model call — Anthropic Messages API with a forced tool so the
// output is schema-validated JSON, hard-timed-out, and null on ANY failure
// (the caller's deterministic path carries on; an order is never half-changed).
// ---------------------------------------------------------------------------

const DECIDE_TOOL = {
  name: 'decide',
  description: 'Report the diagnosis for this problem order.',
  input_schema: {
    type: 'object',
    properties: {
      likelyCause: { type: 'string' },
      recommendedAction: {
        type: 'string',
        enum: ['requeue_dispatch', 'ping_vendor', 'notify_customer_delay', 'request_cancel', 'ops_alert', 'none'],
      },
      urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
      rationale: { type: 'string' },
    },
    required: ['likelyCause', 'recommendedAction', 'urgency', 'rationale'],
  },
} as const;

async function defaultModelCall(system: string, user: string): Promise<OpsDecision | null> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS());
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OPS_MODEL(),
        max_tokens: 500,
        system,
        messages: [{ role: 'user', content: user }],
        tools: [DECIDE_TOOL],
        tool_choice: { type: 'tool', name: 'decide' },
      }),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const toolUse = (body?.content ?? []).find((c: any) => c?.type === 'tool_use' && c?.name === 'decide');
    const input = toolUse?.input;
    if (!input || typeof input.recommendedAction !== 'string') return null;
    return input as OpsDecision;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
