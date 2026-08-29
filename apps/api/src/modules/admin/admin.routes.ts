import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  Prisma,
  UserRole,
  UserStatus,
  VendorStatus,
  VendorType,
  RiderType,
  OrderStatus,
  OrderType,
  SettlementStatus,
  CashSettlementStatus,
  AgentActionStatus,
  SubscriptionStatus,
  SubscriptionType,
  DiscountType,
  VerificationDocumentStatus,
  ClaimStatus,
  ReturnStatus,
  RideClass,
} from '@prisma/client';
import { NotificationService } from '../notification/notification.service';
import { SupportService } from '../support/support.service';
import { VerificationService, REJECTION_REASON_CODES } from '../verification/verification.service';
import { AdvertiserService } from '../ads/advertiser.service';
import { CreativeService, CREATIVE_REJECT_REASONS, looksLikeMp4 } from '../ads/creative.service';
import { AdsLifecycleService } from '../ads/lifecycle.service';
import { AdsRevenueService } from '../ads/revenue.service';
import { looksLikeImage } from '../../utils/images';
import { ComplianceAuditService } from '../verification/compliance-audit.service';
import { scheduleVendorSearchSync } from '../search/search-sync';
import { BillingService } from '../billing/billing.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { CashRulesService } from '../cash/cash-rules.service';
import { AgentService } from '../agent/agent.service';
import { OrderService, TERMINAL_ORDER_STATUSES } from '../order/order.service';
import { DiscoveryGovernanceService } from '../discovery/admin-governance';
import { RatingStatsService } from '../rating/rating-stats.service';
import { assertFounderAccess } from './founder-access';
import { getKycProvider } from '../../providers/kyc/kyc-provider';
import { getPaymentProvider } from '../../providers/payment/payment-provider';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { mintRenderPath } from '../../providers/storage/envelope';
import { parsePagination, paginatedResponse } from '../../utils/pagination';
import { computeOrderSla } from '../fulfillment/order-sla';
import { startOfDayGY, GUYANA_UTC_OFFSET_HOURS } from '../../utils/time-gy';
import { AppError, NotFoundError, ForbiddenError } from '../../utils/errors';
import { transitionUserStatusAuthority } from '../mover-authority';
import { beginRequestTenantContext, getTenantId } from '../../plugins/tenant-context';

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const reasonSchema = z.object({
  reason: z.string().max(500).optional(),
});

const featureSchema = z.object({
  featured: z.boolean().optional(),
});

const verifyDocsSchema = z.object({
  verified: z.boolean().optional(),
  rejectionReason: z.string().max(500).optional(),
});

const rideClassSchema = z.object({
  rideClass: z.nativeEnum(RideClass),
});

const cancelOrderSchema = z.object({
  reason: z.string().max(500).optional(),
  refund: z.boolean().optional(),
});

const processSettlementSchema = z.object({
  reference: z.string().max(200).optional(),
});

const configValueSchema = z.object({
  // Free-form JSON, but bounded: a config value must serialise under 16KB so a
  // stray blob can't bloat the table or a response. (No key drives live
  // behaviour today — real config is CountryConfig — so we bound rather than
  // allowlist; add a semantic allowlist when a key starts gating behaviour.)
  value: z.any().refine(
    (v) => { try { return JSON.stringify(v ?? null).length <= 16_384; } catch { return false; } },
    'Config value must be JSON-serialisable and under 16KB',
  ),
});
// Keys are identifiers, not free text — keep them greppable and injection-inert.
const configKeySchema = z.string().regex(/^[a-z0-9_.-]{1,64}$/i, 'Invalid config key');

const usersQuerySchema = z.object({
  role: z.nativeEnum(UserRole).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  search: z.string().max(100).optional(),
});

const vendorsQuerySchema = z.object({
  status: z.nativeEnum(VendorStatus).optional(),
  type: z.nativeEnum(VendorType).optional(),
  search: z.string().max(100).optional(),
});

// Riders/drivers list filters use UI keywords, not DB enums
const moverFilterQuerySchema = z.object({
  status: z.enum(['online', 'offline', 'verified', 'unverified']).optional(),
  type: z.nativeEnum(RiderType).optional(),
  search: z.string().max(100).optional(),
});

const adminOrdersQuerySchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  type: z.nativeEnum(OrderType).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  search: z.string().max(100).optional(),
});

const settlementsQuerySchema = z.object({
  status: z.nativeEnum(SettlementStatus).optional(),
  vendorId: z.string().optional(),
});

const cashSettlementsQuerySchema = z.object({
  status: z.nativeEnum(CashSettlementStatus).optional(),
  vendorId: z.string().optional(),
  riderId: z.string().optional(),
});

const globalSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(60),
});

const promosQuerySchema = z.object({
  active: z.enum(['true', 'false']).optional(),
});

const createPromoSchema = z.object({
  code: z.string().trim().min(2).max(40),
  description: z.string().max(500),
  discountType: z.nativeEnum(DiscountType),
  // SWIFT-AUD-D3-04: bound the discount + cap a PERCENTAGE at 100 (mirrors the
  // vendor promo schema). discountValue feeds order totals, so an unbounded /
  // >100% value is a fat-finger money-wrong risk even from a trusted admin.
  // min(0) not positive(): FREE_DELIVERY promos legitimately carry value 0.
  discountValue: z.number().min(0).max(10_000_000),
  minOrderAmount: z.number().min(0).max(10_000_000).optional(),
  maxDiscount: z.number().min(0).max(10_000_000).optional(),
  applicableTo: z.array(z.string().max(50)).max(20).optional(),
  validFrom: z.coerce.date(),
  validUntil: z.coerce.date(),
  maxUses: z.number().int().min(1).max(1_000_000).optional(),
  maxUsesPerUser: z.number().int().min(1).max(100).optional(),
}).refine((d) => d.discountType !== 'PERCENTAGE' || d.discountValue <= 100, {
  message: 'A percentage discount cannot exceed 100',
  path: ['discountValue'],
});

const updatePromoSchema = z.object({
  description: z.string().max(500).optional(),
  discountValue: z.number().min(0).optional(),
  minOrderAmount: z.number().min(0).optional(),
  maxDiscount: z.number().min(0).optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
  maxUses: z.number().int().min(1).optional(),
  maxUsesPerUser: z.number().int().min(1).optional(),
  isActive: z.boolean().optional(),
});

const createZoneSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  // GeoJSON blob — stored as JSON, shape owned by the maps layer
  boundary: z.any(),
  deliveryBaseFee: z.number().min(0).optional(),
  deliveryPerKm: z.number().min(0).optional(),
  surgeMultiplier: z.number().min(0.5).max(10).optional(),
});

const updateZoneSchema = createZoneSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const subscriptionsQuerySchema = z.object({
  status: z.nativeEnum(SubscriptionStatus).optional(),
  type: z.nativeEnum(SubscriptionType).optional(),
});

const broadcastSchema = z.object({
  title: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(1000),
  role: z.nativeEnum(UserRole).optional(),
  data: z.record(z.unknown()).optional(),
  /** [REPORT-021 F-021-03] Every broadcast declares its PURPOSE. 'service'
   *  = operational notices (goes to everyone); 'marketing' = offers/promos —
   *  delivered ONLY to subjects whose marketing consent is granted at the
   *  CURRENT legal version. */
  category: z.enum(['service', 'marketing']),
});

const topUpSchema = z.object({
  amount: z.number().positive().max(10_000_000),
  reference: z.string().max(200).optional(),
});

const verificationQueueQuerySchema = z.object({
  status: z.nativeEnum(VerificationDocumentStatus).default('PENDING'),
});

const claimsQueueQuerySchema = z.object({
  status: z.nativeEnum(ClaimStatus).default('PENDING_REVIEW'),
});

const returnsQuerySchema = z.object({
  status: z.nativeEnum(ReturnStatus).optional(),
});
const resolveReturnSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'REFUNDED']),
  note: z.string().max(1000).optional(),
});

const approveDocSchema = z.object({
  // Optional document expiry (e.g. licence end date entered during review)
  expiresAt: z.coerce.date().optional(),
  // Insurance 5-point manual check (spec §3.4) — supplied for hire-insurance docs
  insurance: z.object({
    insurerName: z.string().min(1).max(120),
    policyNumber: z.string().min(1).max(60),
    coverageClass: z.enum(['HIRE', 'PRIVATE']),
    hireClassConfirmed: z.boolean(),
    plateCrossChecked: z.boolean(),
  }).optional(),
});

const rejectDocSchema = z.object({
  reason: z.string().min(3).max(500),
  // Templated opener (spec §9.3) — consistent applicant messaging across reviewers.
  reasonCode: z.enum(REJECTION_REASON_CODES).optional(),
});

const auditLogsQuerySchema = z.object({
  action: z.string().max(100).optional(),
  entity: z.string().max(100).optional(),
  userId: z.string().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

// Ordinary admin reads are intentionally not logged. These two routes are the
// exception because they expose Swift's platform-wide identity graph; the
// trial-integrity law requires every successful founder view to leave a trail.
const auditedAdminReadRoutes = [
  '/integrity/identity/:userId',
  '/integrity/appeals',
];

// ---------------------------------------------------------------------------
// MONEY AT THE RESPONSE SEAM
//
// A Prisma `Decimal` is an object, not a JS number. `JSON.stringify` calls its
// `toJSON()`, so a row handed straight to the client carries `"1200.00"` where
// the shared admin type (`apps/admin/src/lib/api.ts`) promises `1200`. The
// dashboard-overview route already coerces its own money for exactly this
// reason (SWIFT-119, see `todayDeliveryFees` below); the paginated LIST routes
// never did, and they carry far more money columns — an Order alone has 13,
// plus 7 more on every OrderItem.
//
// Today each render site rescues itself with a local `Number(...)`, which is
// the fork this is meant to end: one missed call site and `a + b` concatenates
// ("1200.00" + "300.00" = "1200.00300.00"), `.toFixed()` throws, and a sort
// compares lexicographically so "9" outranks "1200".
//
// Detect the Decimal itself rather than a list of field names — a name list
// silently misses the next money column added to the schema, and that miss is
// invisible until a total is wrong on screen.
// ---------------------------------------------------------------------------

/** A value that cannot become a finite number becomes `null`, NEVER `0`: a real
 *  zero and an invented zero look identical and mean opposite things, so the
 *  server must not manufacture the zero. (Whether each client then renders the
 *  null honestly is the client's half — `apps/admin/src/app/finance/page.tsx`
 *  does; two other `gyd` copies still coerce it to $0. Logged as a finding.) */
function decimalToNumber(value: unknown): number | null {
  const n = Number((value as { toString(): string }).toString());
  return Number.isFinite(n) ? n : null;
}

/** Deep-coerce every Prisma `Decimal` in a response payload to a real number.
 *  Non-Decimal values (Dates, Buffers, strings, nested relations) pass through
 *  untouched, so the response shape is otherwise byte-identical. */
function coerceMoney<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Prisma.Decimal.isDecimal(value)) return decimalToNumber(value) as unknown as T;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map((v) => coerceMoney(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = coerceMoney(v);
  return out as unknown as T;
}

export async function adminRoutes(app: FastifyInstance) {
  const notifications = new NotificationService(app.prisma, app.io);
  const orderService = new OrderService(app.prisma, app.io);
  const discoveryGovernance = new DiscoveryGovernanceService(app.prisma);

  const requireTenantId = (): string => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    return tenantId;
  };

  const subscriptionTenantScope = (tenantId: string) => ({
    OR: [
      { vendor: { tenantId }, riderId: null, driverId: null },
      { rider: { user: { tenantId } }, vendorId: null, driverId: null },
      { driver: { user: { tenantId } }, vendorId: null, riderId: null },
    ],
  });

  const requireDefaultTenantBilling = (): void => {
    const tenantId = requireTenantId();
    if (tenantId !== 'swift-default') {
      // BillingService's receipt helper still defaults its raw counter SQL to
      // swift-default. Until that helper accepts a tenant explicitly, failing
      // closed is the only route-local behavior that cannot corrupt another
      // tenant's counter or issue a receipt from the wrong namespace.
      throw new AppError(
        503,
        'TENANT_BILLING_UNAVAILABLE',
        'Admin billing mutations are unavailable for this tenant until receipt counters are tenant-aware.',
      );
    }
  };

  const requireDefaultTenantCompliance = (): void => {
    if (requireTenantId() !== 'swift-default') {
      // ComplianceAuditRun has no tenant key or owning relation. The mover,
      // document, violation and review queries below are scoped, but a second
      // tenant cannot safely create/read run summaries until the run itself is
      // attributable. Keep that surface closed instead of mixing evidence.
      throw new AppError(
        503,
        'TENANT_COMPLIANCE_UNAVAILABLE',
        'Compliance audit runs are unavailable for this tenant until audit runs are tenant-attributed.',
      );
    }
  };

  // Several mature billing/identity helpers accept a Prisma client and issue
  // their own child-model queries. Those children do not carry tenantId, so
  // the base Prisma extension cannot scope them. Give admin services a derived
  // client that appends the same relation boundary to every where-operation;
  // tenantId is read at query time so this singleton remains request-safe.
  const childWhereOperations = new Set([
    'findUnique', 'findUniqueOrThrow', 'findMany', 'findFirst', 'findFirstOrThrow',
    'count', 'aggregate', 'groupBy', 'update', 'updateMany', 'updateManyAndReturn',
    'upsert', 'delete', 'deleteMany',
  ]);
  const childScope = (
    scope: (tenantId: string) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ) => ({
    $allOperations: async ({ operation, args, query }: any) => {
      if (childWhereOperations.has(operation)) {
        const where = (args.where ?? {}) as Record<string, unknown>;
        const existingAnd = where['AND'];
        args.where = {
          ...where,
          AND: [
            ...(Array.isArray(existingAnd) ? existingAnd : existingAnd ? [existingAnd] : []),
            await scope(requireTenantId()),
          ],
        };
      }
      return query(args);
    },
  });
  const tenantPrisma = app.prisma.$extends({
    name: 'admin-indirect-tenant-scope',
    query: {
      rider: childScope((tenantId) => ({ user: { tenantId } })),
      driver: childScope((tenantId) => ({ user: { tenantId } })),
      subscription: childScope(subscriptionTenantScope),
      settlement: childScope((tenantId) => ({ vendor: { tenantId } })),
      deliveryCashSettlement: childScope((tenantId) => ({
        order: { tenantId },
        rider: { user: { tenantId } },
        vendor: { tenantId },
      })),
      billingEvent: childScope((tenantId) => ({ subscription: subscriptionTenantScope(tenantId) })),
      prepaidBalance: childScope((tenantId) => ({ subscription: subscriptionTenantScope(tenantId) })),
      subscriptionPayment: childScope((tenantId) => ({ subscription: subscriptionTenantScope(tenantId) })),
      subscriptionRefund: childScope((tenantId) => ({ subscription: subscriptionTenantScope(tenantId) })),
      adCreative: childScope((tenantId) => ({ campaign: { tenantId } })),
      supportTicket: childScope((tenantId) => ({ user: { tenantId } })),
      item: childScope((tenantId) => ({ vendor: { tenantId } })),
      // ContentReport keeps only a loose reporter id. Treat the reporter's
      // tenant as the report boundary; target previews are independently
      // scoped below so a bad cross-tenant target id cannot disclose content.
      contentReport: childScope(async (tenantId) => {
        const reporterIds = (await app.prisma.user.findMany({
          where: { tenantId },
          select: { id: true },
        })).map((user) => user.id);
        return { reporterId: { in: reporterIds } };
      }),
      // ChatMessage has no sender relation. Require both a local sender and a
      // local order-backed room; unattributable service chats fail closed.
      chatMessage: childScope(async (tenantId) => {
        const [orders, senders] = await Promise.all([
          app.prisma.order.findMany({ where: { tenantId }, select: { id: true } }),
          app.prisma.user.findMany({ where: { tenantId }, select: { id: true } }),
        ]);
        return {
          senderId: { in: senders.map((sender) => sender.id) },
          chatRoom: { orderId: { in: orders.map((order) => order.id) } },
        };
      }),
      // ReturnRequest has no relations or tenantId. Require both loose owner
      // ids to resolve inside this tenant so a malformed cross-tenant row is
      // hidden rather than being accepted through either side alone.
      returnRequest: childScope(async (tenantId) => {
        const [orders, customers] = await Promise.all([
          app.prisma.order.findMany({ where: { tenantId }, select: { id: true } }),
          app.prisma.user.findMany({ where: { tenantId }, select: { id: true } }),
        ]);
        return {
          orderId: { in: orders.map((order) => order.id) },
          customerId: { in: customers.map((customer) => customer.id) },
        };
      }),
      // Rating's orderId is loose, while rater/ratee are User relations. All
      // populated ownership legs must agree with the request tenant; this also
      // prevents moderation side effects from reaching a foreign participant.
      rating: childScope(async (tenantId) => {
        const orderIds = (await app.prisma.order.findMany({
          where: { tenantId },
          select: { id: true },
        })).map((order) => order.id);
        return {
          orderId: { in: orderIds },
          rater: { tenantId },
          OR: [{ rateeId: null }, { ratee: { tenantId } }],
        };
      }),
      // Agent request/audit subjects are loose order ids in the legacy schema.
      // Derive their allowed set through the tenant-owned Order root.
      agentActionRequest: childScope(async (tenantId) => {
        const orderIds = (await app.prisma.order.findMany({
          where: { tenantId },
          select: { id: true },
        })).map((order) => order.id);
        return { orderId: { in: orderIds } };
      }),
      agentAuditEvent: childScope(async (tenantId) => {
        const orderIds = (await app.prisma.order.findMany({
          where: { tenantId },
          select: { id: true },
        })).map((order) => order.id);
        return { subjectId: { in: orderIds } };
      }),
      alertDelivery: childScope(async (tenantId) => {
        const [orders, recipients] = await Promise.all([
          app.prisma.order.findMany({ where: { tenantId }, select: { id: true } }),
          app.prisma.user.findMany({ where: { tenantId }, select: { id: true } }),
        ]);
        return {
          subjectId: { in: orders.map((order) => order.id) },
          recipientId: { in: recipients.map((recipient) => recipient.id) },
        };
      }),
      verificationDocument: childScope((tenantId) => ({ user: { tenantId } })),
      complianceViolation: childScope((tenantId) => ({ user: { tenantId } })),
      complianceReviewCase: childScope((tenantId) => ({ user: { tenantId } })),
      // ReimbursementClaim predates relations and carries only loose ids.
      // Require its rider, order and customer to resolve in the same tenant;
      // this hides malformed bridge rows rather than accepting whichever leg
      // happened to be local. The CashRulesService CAS and its re-read both
      // inherit this scope.
      reimbursementClaim: childScope(async (tenantId) => {
        const [riders, orders, customers] = await Promise.all([
          app.prisma.rider.findMany({ where: { user: { tenantId } }, select: { id: true } }),
          app.prisma.order.findMany({ where: { tenantId }, select: { id: true } }),
          app.prisma.user.findMany({ where: { tenantId }, select: { id: true } }),
        ]);
        return {
          riderId: { in: riders.map((rider) => rider.id) },
          orderId: { in: orders.map((order) => order.id) },
          customerId: { in: customers.map((customer) => customer.id) },
        };
      }),
      // bank-recon's legacy compound lookup embeds swift-default. Correct only
      // that nested discriminator; the base extension still applies the same
      // tenant at the top level and stamps creates.
      settlementBatch: {
        findUnique: async ({ args, query }: any) => {
          const compound = args.where?.tenantId_provider_periodStart;
          if (compound) compound.tenantId = requireTenantId();
          return query(args);
        },
      },
      // RatingStatsService's legacy default embeds swift-default inside this
      // compound selector. Keep the service request-safe for other tenants.
      actorRatingStat: {
        upsert: async ({ args, query }: any) => {
          const compound = args.where?.tenantId_subjectRole_subjectId;
          if (compound) compound.tenantId = requireTenantId();
          return query(args);
        },
      },
    },
  }) as unknown as typeof app.prisma;

  const billing = new BillingService(tenantPrisma, notifications, getPaymentProvider());
  const subscriptions = new SubscriptionService(tenantPrisma);
  const verification = new VerificationService(tenantPrisma, notifications, getKycProvider());
  const cashRules = new CashRulesService(tenantPrisma, notifications, orderService);
  const ratingStats = new RatingStatsService(tenantPrisma);

  const mutationOrNotFound = async <T>(entity: string, id: string, mutate: () => Promise<T>): Promise<T> => {
    try {
      return await mutate();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundError(entity, id);
      }
      throw error;
    }
  };

  // Middleware: verify ADMIN or SUPER_ADMIN role
  const adminGuard = async (request: any, reply: any) => {
    // The production server opens this store globally. Admin routes also do it
    // locally so isolated plugin/test hosts cannot authenticate successfully
    // and then lose the tenant binding across the auth await boundary.
    beginRequestTenantContext();
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (!['ADMIN', 'SUPER_ADMIN'].includes(request.user.role)) {
      throw new ForbiddenError('Admin access required');
    }
    requireTenantId();
  };

  // Trial-integrity Part 0.2: the platform-wide identity graph is the one
  // sanctioned tenant-isolation exception, so ordinary operators must never
  // reach its evidence or enforcement controls. Authenticate locally as well
  // as through the plugin hook so the route-level law remains self-contained.
  const founderGuard = async (request: any, reply: any) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    assertFounderAccess(request.user.role);
  };

  // FX, price-book and PlatformConfig rows are platform-global rather than
  // tenant-owned. Keep their control plane on the canonical tenant as well as
  // founder-only: SUPER_ADMIN is otherwise deliberately tenant-local.
  const platformControlGuard = async (request: any, reply: any) => {
    await founderGuard(request, reply);
    if (reply.sent) return;
    if (requireTenantId() !== 'swift-default') {
      throw new ForbiddenError('Platform controls require the default tenant');
    }
  };

  // Belt-and-suspenders (pre-launch audit): the guard is applied per-route on
  // all 42 routes today, but a future admin route that forgets its preHandler
  // would be unauthenticated. This plugin-scoped onRequest hook enforces admin
  // on EVERY admin route — encapsulation means it touches nothing else. The
  // per-route guards stay (re-running auth is idempotent) so nothing changes
  // for existing routes; this just closes the forgot-the-guard gap.
  app.addHook('onRequest', adminGuard);

  // Every successful admin STATE CHANGE is audited, automatically. A scoped
  // onResponse hook (plugin encapsulation: admin routes only) means a new
  // mutating route is covered the day it ships — the same philosophy as the
  // authz matrix. Ordinary reads stay out of the log; the two founder-only
  // identity reads above are the deliberate exception. Failures (4xx/5xx)
  // changed or revealed nothing, so they stay out too. Route templates keep
  // action names stable and free of raw URL data.
  app.addHook('onResponse', async (request, reply) => {
    const routeUrl = request.routeOptions?.url ?? request.url;
    const isAuditedRead = request.method === 'GET'
      && auditedAdminReadRoutes.some((template) => routeUrl === template || routeUrl.endsWith(template));
    if ((request.method === 'GET' && !isAuditedRead) || reply.statusCode >= 400) return;
    const userId = (request as { user?: { userId?: string } }).user?.userId;
    if (!userId) return;
    try {
      const params = (request.params ?? {}) as Record<string, string>;
      const body = request.body ? JSON.stringify(request.body).slice(0, 2000) : undefined;
      await app.prisma.auditLog.create({
        data: {
          userId,
          action: `ADMIN ${request.method} ${routeUrl}`,
          entity: isAuditedRead ? 'integrity' : (routeUrl.split('/').filter(Boolean)[0] ?? 'admin'),
          entityId: params['id'] ?? params['key'] ?? params['userId'] ?? '-',
          changes: body ? { params, body } : { params },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        },
      });
    } catch (err) {
      app.log.error({ err }, '[admin-audit] failed to write audit log');
    }
  });

  // Helper: write an audit log entry
  async function audit(
    userId: string,
    action: string,
    entity: string,
    entityId: string,
    changes?: Record<string, unknown>,
    request?: any,
  ) {
    await app.prisma.auditLog.create({
      data: {
        userId,
        action,
        entity,
        entityId,
        changes: (changes ?? undefined) as any,
        ipAddress: request?.ip,
        userAgent: request?.headers?.['user-agent'],
      },
    });
  }

  // ─── Dashboard ─────────────────────────────────────────────────────────

  app.get('/dashboard/overview', { preHandler: [adminGuard] }, async () => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const subscriptionScope = subscriptionTenantScope(tenantId);
    const today = startOfDayGY(); // DASH-06: Guyana-local "today", not UTC midnight

    const [
      totalUsers,
      totalOrders,
      todayOrders,
      todayRevenue,
      activeRiders,
      activeDrivers,
      activeVendors,
      totalVendors,
      subscriptionCounts,
      activeSubRevenue,
      todayNewUsers,
      pendingVendors,
      pastDueSubs,
      unassignedOrders,
    ] = await Promise.all([
      app.prisma.user.count(),
      app.prisma.order.count(),
      app.prisma.order.count({ where: { placedAt: { gte: today } } }),
      app.prisma.order.aggregate({
        where: { placedAt: { gte: today }, status: { in: ['DELIVERED', 'COMPLETED'] } },
        _sum: { deliveryFee: true, totalAmount: true },
        _count: true,
      }),
      app.prisma.rider.count({ where: { isOnline: true, user: { tenantId } } }),
      app.prisma.driver.count({ where: { isOnline: true, user: { tenantId } } }),
      app.prisma.vendor.count({ where: { status: 'ACTIVE' } }),
      app.prisma.vendor.count(),
      // DASH-01: real per-type revenue = the SUMMED weeklyRate of ACTIVE subs,
      // never count × a hardcoded rate table (which undercounted large vendors
      // 33% and counted TRIAL/PAST_DUE/CANCELLED as revenue). ACTIVE-only so
      // the per-type lines reconcile with the weeklySubscriptionRevenue total.
      app.prisma.subscription.groupBy({
        by: ['type'],
        where: { status: 'ACTIVE', ...subscriptionScope },
        _count: true,
        _sum: { weeklyRate: true },
      }),
      app.prisma.subscription.aggregate({
        where: { status: 'ACTIVE', ...subscriptionScope },
        _sum: { weeklyRate: true },
      }),
      app.prisma.user.count({ where: { createdAt: { gte: today } } }),
      // SWIFT-118: the weeklyTrend raw SQL was removed — it was computed on every
      // 30s dashboard poll (an UNSCOPED FROM orders, cross-tenant) but never
      // rendered by any admin component. Deleted (rule 17); re-add scoped + wired
      // if a trend chart ships.
      // Operational alerts — real counts for the dashboard AlertsPanel.
      app.prisma.vendor.count({ where: { status: 'PENDING_APPROVAL' } }),
      app.prisma.subscription.count({ where: { status: 'PAST_DUE', ...subscriptionScope } }),
      app.prisma.order.count({
        where: {
          riderId: null,
          status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
          placedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) },
          // A held order (LIFECYCLE_V2) is waiting on the customer, not ops.
          AND: [{ OR: [{ holdExpiresAt: null }, { holdExpiresAt: { lte: new Date() } }] }],
        },
      }),
    ]);

    // Real weekly rates from subscriptions (set from CountryConfig tiers),
    // never a hardcoded rate table.
    const weeklySubscriptionRevenue = Number(activeSubRevenue._sum.weeklyRate ?? 0);

    return {
      success: true,
      data: {
        totalUsers,
        todayNewUsers,
        totalOrders,
        todayOrders,
        todayCompletedOrders: todayRevenue._count,
        activeRiders,
        activeDrivers,
        activeVendors,
        totalVendors,
        revenue: {
          // Platform revenue = weekly subscriptions only (no markup, no commission).
          weeklySubscriptionRevenue,
          // Context only — mover earnings / GMV, NOT platform revenue.
          // SWIFT-119: Number() at the seam — a Prisma Decimal is truthy, so
          // `|| 0` let the raw Decimal through and it JSON-serialized to a STRING,
          // not the number the admin client's type promises (→ NaN in the UI math).
          todayDeliveryFees: Number(todayRevenue._sum.deliveryFee ?? 0),
          todayTotal: Number(todayRevenue._sum.totalAmount ?? 0),
        },
        // Per-type ACTIVE count + real summed weekly revenue (Decimal → number).
        subscriptionBreakdown: subscriptionCounts.map((s) => ({
          type: s.type,
          count: s._count,
          weeklyRevenue: Number(s._sum.weeklyRate ?? 0),
        })),
        alerts: { pendingVendors, pastDueSubs, unassignedOrders },
      },
    };
  });

  // ─── Users ─────────────────────────────────────────────────────────────

  app.get('/users', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { role, status, search } = usersQuerySchema.parse(request.query);

    const where: any = {
      ...(role && { activeRole: role }),
      ...(status && { status }),
      ...(search && {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [users, total] = await Promise.all([
      app.prisma.user.findMany({
        where,
        select: {
          id: true,
          phone: true,
          email: true,
          firstName: true,
          lastName: true,
          avatar: true,
          roles: true,
          activeRole: true,
          status: true,
          isPhoneVerified: true,
          createdAt: true,
          lastActiveAt: true,
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.user.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(users, total, { page, limit, skip }) };
  });

  app.get('/users/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const user = await app.prisma.user.findUnique({
      where: { id },
      include: {
        customer: true,
        rider: { include: { subscription: true } },
        driver: { include: { subscription: true } },
        vendorOwner: { include: { vendors: true } },
        addresses: true,
        // The trust story + the paper trail the operator acts on.
        strikes: { orderBy: { createdAt: 'desc' }, take: 20 },
        orders: {
          orderBy: { placedAt: 'desc' },
          take: 10,
          select: { id: true, orderNumber: true, status: true, orderType: true, totalAmount: true, placedAt: true },
        },
        _count: { select: { orders: true, notifications: true, transactions: true, strikes: true } },
      },
    });
    if (!user) throw new NotFoundError('User', id);

    return { success: true, data: user };
  });

  /** GET /users/:id/risk — one deterministic number from existing signals
   *  (marketplace §10). Throttles inform decisions; bans stay with the
   *  explicit strike rules. */
  app.get('/users/:id/risk', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await app.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw new NotFoundError('User', id);
    const { riskScoreFor } = await import('../cash/risk-score.service');
    return { success: true, data: await riskScoreFor(app.prisma, id) };
  });

  app.put('/users/:id/suspend', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reason } = reasonSchema.parse(request.body ?? {});

    const user = await app.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError('User', id);
    const { updated } = await transitionUserStatusAuthority(app, id, 'SUSPENDED', {
      actorUserId: request.user.userId,
      reason: reason ?? null,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    await notifications.send({
      userId: id,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Account Suspended',
      body: reason || 'Your account has been suspended. Please contact support for more information.',
    });

    return { success: true, data: updated };
  });

  app.put('/users/:id/unsuspend', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const user = await app.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError('User', id);
    const { updated } = await transitionUserStatusAuthority(app, id, 'ACTIVE', {
      actorUserId: request.user.userId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    await notifications.send({
      userId: id,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Account Restored',
      body: 'Your account has been reinstated. Welcome back!',
    });

    return { success: true, data: updated };
  });

  app.put('/users/:id/ban', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reason } = reasonSchema.parse(request.body ?? {});

    const user = await app.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError('User', id);
    // Prevent banning other admins unless SUPER_ADMIN
    if (user.roles.includes('ADMIN') && request.user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenError('Only SUPER_ADMIN can ban admin users');
    }

    const { updated } = await transitionUserStatusAuthority(app, id, 'BANNED', {
      actorUserId: request.user.userId,
      reason: reason ?? null,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    // DPA §3.5 — a banned participant has left: schedule document deletion
    await verification.scheduleDocumentRetention(id);

    return { success: true, data: updated };
  });

  // ─── Vendors ───────────────────────────────────────────────────────────

  app.get('/vendors', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, type, search } = vendorsQuerySchema.parse(request.query);

    const where: any = {
      ...(status && { status }),
      ...(type && { vendorType: type }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { slug: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [vendors, total] = await Promise.all([
      app.prisma.vendor.findMany({
        where,
        include: {
          owner: { include: { user: { select: { id: true, firstName: true, lastName: true, phone: true } } } },
          subscription: { select: { id: true, status: true, type: true, weeklyRate: true } },
          _count: { select: { orders: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.vendor.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(vendors, total, { page, limit, skip }) };
  });

  app.get('/vendors/pending', { preHandler: [adminGuard] }, async () => {
    const vendors = await app.prisma.vendor.findMany({
      where: { status: 'PENDING_APPROVAL' },
      include: {
        owner: { include: { user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return { success: true, data: vendors };
  });

  /** One business, whole story: profile, owner, sibling stores, subscription,
   *  catalogue size, order volume, recent orders. Read-only. */
  app.get('/vendors/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const vendor = await app.prisma.vendor.findUnique({
      where: { id },
      include: {
        owner: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true, status: true } },
            vendors: { select: { id: true, name: true, status: true, vendorType: true } },
          },
        },
        subscription: true,
        _count: { select: { items: true, orders: true } },
      },
    });
    if (!vendor) throw new NotFoundError('Vendor', id);

    const recentOrders = await app.prisma.order.findMany({
      where: { vendorId: id },
      orderBy: { placedAt: 'desc' },
      take: 10,
      select: { id: true, orderNumber: true, status: true, totalAmount: true, paymentMethod: true, placedAt: true },
    });

    return {
      success: true,
      data: {
        ...vendor,
        recentOrders: recentOrders.map((o) => ({ ...o, totalAmount: Number(o.totalAmount) })),
      },
    };
  });

  app.put('/vendors/:id/approve', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const vendor = await app.prisma.vendor.findUnique({
      where: { id },
      include: { owner: true },
    });
    if (!vendor) throw new NotFoundError('Vendor', id);
    if (vendor.status === 'ACTIVE') throw new AppError(400, 'ALREADY_ACTIVE', 'Vendor is already approved');

    // [ACTIVATION AUTHORITY / EV-ACT-11] This button is no longer a
    // checklist-free ACTIVE writer. The founder invariant is: submit owner ID
    // + required business documents → restricted per-document review →
    // activation. Approval here CONFIRMS that evidence; it cannot substitute
    // for it — a store whose checklist is incomplete, expired, or purged
    // stays pending and the reviewer is pointed at the Verification queue.
    const checklistComplete = await verification.isRoleVerified(
      vendor.owner.userId,
      vendor.vendorType as Parameters<typeof verification.isRoleVerified>[1],
    );
    if (!checklistComplete) {
      throw new AppError(
        409,
        'CHECKLIST_INCOMPLETE',
        `${vendor.name}'s required documents are not all approved and current — review them in the Verification queue first.`,
      );
    }

    // CAS [EV-ACT-11]: exactly one approval transitions the store, so a
    // double-tap cannot double-fire the trial/notification side effects.
    const won = await app.prisma.vendor.updateMany({
      where: { id, status: { not: 'ACTIVE' } },
      data: { status: 'ACTIVE', isVerified: true },
    });
    if (won.count === 0) throw new AppError(400, 'ALREADY_ACTIVE', 'Vendor is already approved');
    const updated = await app.prisma.vendor.findUniqueOrThrow({ where: { id } });

    // On-write search sync [SWIFT-UG-SRCH-01]: status changes gate the vendor in/out of the index.
    scheduleVendorSearchSync(app, id);

    await audit(request.user.userId, 'APPROVE_VENDOR', 'Vendor', id, { previousStatus: vendor.status }, request);

    // A subscription is born as a 14-day trial the moment the vendor goes live.
    await subscriptions.startTrialForVendor(id);

    await notifications.send({
      userId: vendor.owner.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Vendor Approved!',
      body: `Congratulations! ${vendor.name} has been approved and is now live on Swift.`,
      data: { vendorId: id },
    });

    return { success: true, data: updated };
  });

  app.put('/vendors/:id/suspend', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reason } = reasonSchema.parse(request.body ?? {});

    const vendor = await app.prisma.vendor.findUnique({
      where: { id },
      include: { owner: true },
    });
    if (!vendor) throw new NotFoundError('Vendor', id);

    const updated = await app.prisma.vendor.update({
      where: { id },
      data: { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'ADMIN' },
    });

    scheduleVendorSearchSync(app, id);

    await audit(request.user.userId, 'SUSPEND_VENDOR', 'Vendor', id, { reason, previousStatus: vendor.status }, request);

    await notifications.send({
      userId: vendor.owner.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Vendor Suspended',
      body: reason || `${vendor.name} has been suspended. Please contact support.`,
      data: { vendorId: id },
    });

    return { success: true, data: updated };
  });

  app.put('/vendors/:id/feature', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { featured } = featureSchema.parse(request.body ?? {});

    const vendor = await app.prisma.vendor.findUnique({ where: { id } });
    if (!vendor) throw new NotFoundError('Vendor', id);

    const isFeatured = featured !== undefined ? featured : !vendor.isFeatured;

    const updated = await app.prisma.vendor.update({
      where: { id },
      data: { isFeatured },
    });

    await audit(request.user.userId, 'TOGGLE_FEATURED_VENDOR', 'Vendor', id, { isFeatured }, request);

    return { success: true, data: updated };
  });

  // ─── Riders ────────────────────────────────────────────────────────────

  app.get('/riders', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, type, search } = moverFilterQuerySchema.parse(request.query);

    const where: any = {
      user: {
        tenantId,
        ...(search && {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
          ],
        }),
      },
      ...(type && { riderType: type }),
      ...(status === 'online' && { isOnline: true }),
      ...(status === 'offline' && { isOnline: false }),
      ...(status === 'verified' && { documentsVerified: true }),
      ...(status === 'unverified' && { documentsVerified: false }),
    };

    const [riders, total] = await Promise.all([
      app.prisma.rider.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, phone: true, avatar: true, status: true } },
          subscription: { select: { id: true, status: true, type: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.rider.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(riders, total, { page, limit, skip }) };
  });

  app.get('/riders/:id', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { id } = request.params as { id: string };

    const rider = await app.prisma.rider.findFirst({
      where: { id, user: { tenantId } },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true, avatar: true, status: true, createdAt: true } },
        subscription: { include: { payments: { take: 5, orderBy: { createdAt: 'desc' } } } },
        earnings: { take: 20, orderBy: { createdAt: 'desc' } },
        _count: { select: { orders: true, earnings: true } },
      },
    });
    if (!rider) throw new NotFoundError('Rider', id);

    return { success: true, data: rider };
  });

  app.put('/riders/:id/verify-documents', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { id } = request.params as { id: string };
    const { verified, rejectionReason } = verifyDocsSchema.parse(request.body ?? {});

    const rider = await app.prisma.rider.findFirst({
      where: { id, user: { tenantId } },
      include: { user: true },
    });
    if (!rider) throw new NotFoundError('Rider', id);

    const isVerified = verified !== false; // default true

    // [ACTIVATION AUTHORITY / EV-ACT-15] The legacy flag can no longer bless
    // missing evidence: verifying requires the canonical checklist for this
    // rider's PERSISTED vehicle class to be individually APPROVED and current
    // (the founder invariant: the admin verifies the vehicle is right and the
    // documents match — this button confirms that review, it cannot replace
    // it). An empty request body used to mean "approve on no evidence".
    if (isVerified) {
      const live = await verification.getLiveOperationStatus(rider.userId, { vehicleType: rider.vehicleType });
      if (!live.allowed) {
        throw new AppError(
          409,
          'CHECKLIST_INCOMPLETE',
          live.reason === 'insurance'
            ? 'This rider’s vehicle needs current HIRE-class insurance approved before they can be verified.'
            : 'This rider’s required documents are not all approved and current — review them in the Verification queue first.',
        );
      }
    }

    const updated = await mutationOrNotFound('Rider', id, () => app.prisma.rider.update({
      where: { id, user: { tenantId } },
      data: {
        documentsVerified: isVerified,
        documentsVerifiedAt: isVerified ? new Date() : null,
        documentsVerifiedBy: isVerified ? request.user.userId : null,
        // [EV-ACT-15] A negative decision is a live supply revocation, not
        // just a cache clear: an already-online rider must not stay
        // dispatchable until the next daily sweep.
        ...(isVerified ? {} : { isOnline: false, locationSessionId: null }),
      },
    }));

    await audit(
      request.user.userId,
      isVerified ? 'VERIFY_RIDER_DOCUMENTS' : 'REJECT_RIDER_DOCUMENTS',
      'Rider',
      id,
      { verified: isVerified, rejectionReason },
      request,
    );

    // Verification is the founder-chosen trigger: start the 14-day trial.
    if (isVerified) await subscriptions.startTrialForRider(id);

    await notifications.send({
      userId: rider.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: isVerified ? 'Documents Verified!' : 'Document Review Update',
      body: isVerified
        ? 'Your documents have been verified. You can now go online and start accepting deliveries!'
        : `Your documents need attention: ${rejectionReason || 'Please resubmit your documents.'}`,
    });

    return { success: true, data: updated };
  });

  // ─── Drivers ───────────────────────────────────────────────────────────

  app.get('/drivers', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, search } = moverFilterQuerySchema.parse(request.query);

    const where: any = {
      user: {
        tenantId,
        ...(search && {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
          ],
        }),
      },
      ...(status === 'online' && { isOnline: true }),
      ...(status === 'offline' && { isOnline: false }),
      ...(status === 'verified' && { documentsVerified: true }),
      ...(status === 'unverified' && { documentsVerified: false }),
    };

    const [drivers, total] = await Promise.all([
      app.prisma.driver.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, phone: true, avatar: true, status: true } },
          subscription: { select: { id: true, status: true, type: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.driver.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(drivers, total, { page, limit, skip }) };
  });

  app.get('/drivers/:id', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { id } = request.params as { id: string };

    const driver = await app.prisma.driver.findFirst({
      where: { id, user: { tenantId } },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true, avatar: true, status: true, createdAt: true } },
        subscription: { include: { payments: { take: 5, orderBy: { createdAt: 'desc' } } } },
        earnings: { take: 20, orderBy: { createdAt: 'desc' } },
        _count: { select: { orders: true, earnings: true } },
      },
    });
    if (!driver) throw new NotFoundError('Driver', id);

    return { success: true, data: driver };
  });

  app.put('/drivers/:id/verify-documents', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { id } = request.params as { id: string };
    const { verified, rejectionReason } = verifyDocsSchema.parse(request.body ?? {});

    const driver = await app.prisma.driver.findFirst({
      where: { id, user: { tenantId } },
      include: { user: true },
    });
    if (!driver) throw new NotFoundError('Driver', id);

    const isVerified = verified !== false;

    // [ACTIVATION AUTHORITY / EV-ACT-15] Same law as riders: verifying a taxi
    // driver requires the canonical checklist for their PERSISTED vehicle
    // class — including current HIRE-class insurance for passenger work — to
    // be individually APPROVED and current. The button confirms review; it
    // cannot bless missing evidence.
    if (isVerified) {
      const live = await verification.getLiveOperationStatus(driver.userId, { vehicleType: driver.vehicleType });
      if (!live.allowed) {
        throw new AppError(
          409,
          'CHECKLIST_INCOMPLETE',
          live.reason === 'insurance'
            ? 'This driver needs current HIRE-class insurance approved before they can be verified for passenger work.'
            : 'This driver’s required documents are not all approved and current — review them in the Verification queue first.',
        );
      }
    }

    const updated = await mutationOrNotFound('Driver', id, () => app.prisma.driver.update({
      where: { id, user: { tenantId } },
      data: {
        documentsVerified: isVerified,
        documentsVerifiedAt: isVerified ? new Date() : null,
        documentsVerifiedBy: isVerified ? request.user.userId : null,
        // [EV-ACT-15] A negative decision revokes live supply atomically —
        // an online driver must not stay dispatchable until the daily sweep.
        ...(isVerified ? {} : { isOnline: false, locationSessionId: null }),
      },
    }));

    await audit(
      request.user.userId,
      isVerified ? 'VERIFY_DRIVER_DOCUMENTS' : 'REJECT_DRIVER_DOCUMENTS',
      'Driver',
      id,
      { verified: isVerified, rejectionReason },
      request,
    );

    // Verification is the founder-chosen trigger: start the 14-day trial.
    if (isVerified) await subscriptions.startTrialForDriver(id);

    await notifications.send({
      userId: driver.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: isVerified ? 'Documents Verified!' : 'Document Review Update',
      body: isVerified
        ? 'Your documents have been verified. You can now go online and start accepting rides!'
        : `Your documents need attention: ${rejectionReason || 'Please resubmit your documents.'}`,
    });

    return { success: true, data: updated };
  });

  // Premium-fleet onboarding: set the top taxi tier a vehicle serves. This is the
  // assignment surface that makes Comfort/XL dispatchable (the #112 gap).
  app.put('/drivers/:id/ride-class', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { id } = request.params as { id: string };
    const { rideClass } = rideClassSchema.parse(request.body ?? {});

    const driver = await app.prisma.driver.findFirst({ where: { id, user: { tenantId } }, select: { id: true } });
    if (!driver) throw new NotFoundError('Driver', id);

    const updated = await mutationOrNotFound('Driver', id, () => app.prisma.driver.update({
      where: { id, user: { tenantId } },
      data: { rideClass },
    }));
    await audit(request.user.userId, 'SET_DRIVER_RIDE_CLASS', 'Driver', id, { rideClass }, request);

    return { success: true, data: updated };
  });

  // ─── Orders ────────────────────────────────────────────────────────────

  app.get('/orders', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, type, dateFrom, dateTo, search } = adminOrdersQuerySchema.parse(request.query);

    const where: any = {
      ...(status && { status }),
      ...(type && { orderType: type }),
      ...(dateFrom || dateTo
        ? {
            placedAt: {
              ...(dateFrom && { gte: dateFrom }),
              ...(dateTo && { lte: dateTo }),
            },
          }
        : {}),
      ...(search && {
        OR: [
          { orderNumber: { contains: search, mode: 'insensitive' } },
          { deliveryAddress: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [orders, total] = await Promise.all([
      app.prisma.order.findMany({
        where,
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
          vendor: { select: { id: true, name: true } },
          rider: { include: { user: { select: { firstName: true, lastName: true } } } },
          driver: { include: { user: { select: { firstName: true, lastName: true } } } },
          items: true,
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.order.count({ where }),
    ]);

    // 13 Decimal columns on the order + 7 more on every included OrderItem,
    // all of which the admin client types as `number`. Coerce at the seam.
    return { success: true, ...paginatedResponse(coerceMoney(orders), total, { page, limit, skip }) };
  });

  /** Live ops snapshot for the command map: every online mover's position +
   *  every order in flight. Read-only; the console polls it. */
  app.get('/ops/live', { preHandler: [adminGuard] }, async () => {
    const tenantId = requireTenantId();
    const ACTIVE_STATUSES = [
      'PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP',
      'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED',
      'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS',
    ] as const;

    // A POSITION IS BOTH COORDINATES OR IT IS NOT A POSITION.
    // `currentLat`/`currentLng` are two independent nullable `Float?` columns
    // with no constraint tying them, so a half-written fix is representable.
    // Every other reader in the codebase already defends against it — the two
    // PostGIS partial indexes (`..._dispatch_postgis`, `..._hot_path_indexes`)
    // and `rides/queue.service.ts:297` all require BOTH IS NOT NULL. This one
    // required only lat, and `OpsMap.tsx:65` renders `position={[m.lat, m.lng]}`
    // with no guard of its own, so a lat-without-lng row throws inside Leaflet
    // and takes the whole live-ops map down — not one missing dot, the map.
    // Match the index predicate exactly rather than adding a second rule.
    const [riders, drivers, orders, exhausted] = await Promise.all([
      app.prisma.rider.findMany({
        where: { isOnline: true, currentLat: { not: null }, currentLng: { not: null }, user: { tenantId } },
        select: {
          id: true, currentLat: true, currentLng: true, isAvailable: true, currentOrderId: true,
          user: { select: { firstName: true, lastName: true } },
        },
        take: 500,
      }),
      app.prisma.driver.findMany({
        where: { isOnline: true, currentLat: { not: null }, currentLng: { not: null }, user: { tenantId } },
        select: {
          id: true, currentLat: true, currentLng: true, isAvailable: true, currentRideId: true, rideClass: true,
          user: { select: { firstName: true, lastName: true } },
        },
        take: 500,
      }),
      app.prisma.order.findMany({
        where: { status: { in: ACTIVE_STATUSES as any } },
        select: {
          id: true, orderNumber: true, status: true, orderType: true,
          pickupLat: true, pickupLng: true, deliveryLat: true, deliveryLng: true,
          vendor: { select: { name: true, latitude: true, longitude: true } },
        },
        orderBy: { placedAt: 'asc' },
        take: 300,
      }),
      // Availability spec §6: exhausted searches float to the top in danger —
      // unresolved means no retry took over, nobody switched, nobody cancelled.
      // DispatchSearch has no tenantId and no Prisma relation to Order. Join
      // the tenant-owned parent explicitly; reading first and filtering in JS
      // would still pull another tenant's operational journal into memory.
      app.prisma.$queryRaw<Array<{
        id: string;
        subjectId: string;
        vertical: string;
        wave: number;
        candidatesTried: string[];
        exhaustedAt: Date | null;
      }>>`
        SELECT ds.id,
               ds."subjectId",
               ds.vertical,
               ds.wave,
               ds."candidatesTried",
               ds."exhaustedAt"
        FROM dispatch_searches ds
        INNER JOIN orders o ON o.id = ds."subjectId"
        WHERE o."tenantId" = ${tenantId}
          AND ds.status = 'EXHAUSTED'
          AND ds.resolution IS NULL
          AND ds."startedAt" >= ${new Date(Date.now() - 24 * 3600_000)}
        ORDER BY ds."exhaustedAt" ASC NULLS LAST
        LIMIT 50
      `,
    ]);
    const exhaustedOrders = exhausted.length
      ? await app.prisma.order.findMany({
          where: { id: { in: exhausted.map((s) => s.subjectId) } },
          select: { id: true, orderNumber: true, status: true, orderType: true, vendor: { select: { name: true } } },
        })
      : [];
    const orderById = new Map(exhaustedOrders.map((o) => [o.id, o]));

    const mover = (m: any, kind: 'rider' | 'driver') => ({
      id: m.id,
      kind,
      lat: m.currentLat,
      lng: m.currentLng,
      name: [m.user?.firstName, m.user?.lastName].filter(Boolean).join(' '),
      busy: !!(m.currentOrderId ?? m.currentRideId) || !m.isAvailable,
      ...(kind === 'driver' ? { rideClass: m.rideClass } : {}),
    });

    return {
      success: true,
      data: {
        movers: [...riders.map((r) => mover(r, 'rider')), ...drivers.map((d) => mover(d, 'driver'))],
        activeOrders: orders.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          status: o.status,
          orderType: o.orderType,
          pickupLat: o.pickupLat ?? o.vendor?.latitude ?? null,
          pickupLng: o.pickupLng ?? o.vendor?.longitude ?? null,
          deliveryLat: o.deliveryLat,
          deliveryLng: o.deliveryLng,
          vendorName: o.vendor?.name ?? null,
        })),
        exhaustedSearches: exhausted.map((s) => {
          const o = orderById.get(s.subjectId);
          return {
            id: s.id,
            orderId: s.subjectId,
            orderNumber: o?.orderNumber ?? null,
            orderStatus: o?.status ?? null,
            vendorName: o?.vendor?.name ?? null,
            vertical: s.vertical,
            waves: s.wave,
            candidatesTried: s.candidatesTried.length,
            exhaustedAt: s.exhaustedAt,
          };
        }),
      },
    };
  });

  /** POST /orders/:id/retry-dispatch — availability spec §6: one-tap re-run
   *  for an exhausted search from Live Ops. Same engine as the vendor button;
   *  audited because an admin is acting on someone else's order. */
  app.post('/orders/:id/retry-dispatch', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const order = await app.prisma.order.findUnique({ where: { id }, select: { id: true, orderNumber: true } });
    if (!order) throw new NotFoundError('Order', id);
    const { makeDispatchService } = await import('../dispatch/dispatch.service');
    const result = await makeDispatchService(app).retryDispatch(id);
    await audit(request.user.userId, 'RETRY_DISPATCH', 'Order', id, { result }, request);
    return { success: true, data: result };
  });

  /** The 13 Caribbean markets — CountryConfig read-only (editing arrives with
   *  the billing-rail work; blind edits to money thresholds are not a UI). */
  app.get('/countries', { preHandler: [adminGuard] }, async () => {
    const countries = await app.prisma.countryConfig.findMany({ orderBy: { name: 'asc' } });
    return {
      success: true,
      data: countries.map((c) => ({
        ...c,
        usdExchangeRate: Number(c.usdExchangeRate),
        idGateThresholdUsd: Number(c.idGateThresholdUsd),
        floatL1: Number(c.floatL1),
        floatL2: Number(c.floatL2),
        floatL3: Number(c.floatL3),
      })),
    };
  });

  /** Global ⌘K search — one query fans out across orders (number), users
   *  (phone/name) and vendors (name). Read-only, capped, for the console's
   *  jump-to-anything box. */
  app.get('/search', { preHandler: [adminGuard] }, async (request) => {
    const { q } = globalSearchQuerySchema.parse(request.query);
    const contains = { contains: q, mode: 'insensitive' as const };

    const [orders, users, vendors] = await Promise.all([
      app.prisma.order.findMany({
        where: { orderNumber: contains },
        select: { id: true, orderNumber: true, status: true, orderType: true, totalAmount: true, placedAt: true },
        orderBy: { placedAt: 'desc' },
        take: 5,
      }),
      app.prisma.user.findMany({
        where: {
          OR: [{ phone: contains }, { firstName: contains }, { lastName: contains }, { email: contains }],
        },
        select: { id: true, firstName: true, lastName: true, phone: true, roles: true, status: true },
        take: 5,
      }),
      app.prisma.vendor.findMany({
        where: { name: contains },
        select: { id: true, name: true, vendorType: true, status: true, city: true },
        take: 5,
      }),
    ]);

    return {
      success: true,
      data: {
        orders: orders.map((o) => ({ ...o, totalAmount: Number(o.totalAmount) })),
        users,
        vendors,
      },
    };
  });

  // FUL-008: SLA-breach board (Part 10B). The live delivery orders whose dwell
  // in some stage is past its threshold — a stuck-order watchlist for ops.
  // Bounded scan of the oldest live orders (they're the ones that can breach);
  // for V1 Guyana the live-order set is small. Worst breach first.
  app.get('/orders/sla-breaches', { preHandler: [adminGuard] }, async () => {
    const SCAN_CAP = 500;
    const live = await app.prisma.order.findMany({
      where: {
        fulfillment: 'DELIVERY',
        status: { notIn: TERMINAL_ORDER_STATUSES }, // ONE definition [order/order-status.ts]
      },
      select: {
        id: true, orderNumber: true, status: true, vendorId: true,
        placedAt: true, acceptedAt: true, readyAt: true, pickedUpAt: true, deliveredAt: true, cancelledAt: true,
      },
      orderBy: { placedAt: 'asc' },
      take: SCAN_CAP,
    });
    const now = new Date();
    const breaches = live
      .map((o) => ({ orderNumber: o.orderNumber, vendorId: o.vendorId, ...computeOrderSla(o, now) }))
      .filter((s) => s.breached)
      .sort((a, b) => b.worstOverMs - a.worstOverMs);
    return {
      success: true,
      scanCap: SCAN_CAP,
      scanned: live.length,
      truncated: live.length === SCAN_CAP,
      data: breaches,
    };
  });

  app.get('/orders/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const order = await app.prisma.order.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
        vendor: { select: { id: true, name: true, phone: true, addressLine1: true, city: true } },
        rider: { include: { user: { select: { id: true, firstName: true, lastName: true, phone: true } } } },
        driver: { include: { user: { select: { id: true, firstName: true, lastName: true, phone: true } } } },
        items: { include: { selectedOptions: true } },
        statusHistory: { orderBy: { createdAt: 'desc' } },
        promoCode: true,
      },
    });
    if (!order) throw new NotFoundError('Order', id);

    // FUL-008: attach this order's live SLA so an admin drilling into one order
    // sees where its clock stands (open stage, whether it's breaching) without
    // cross-referencing the breach board. Delivery-path only.
    const sla = order.fulfillment === 'DELIVERY' ? computeOrderSla(order, new Date()) : null;

    return { success: true, data: { ...order, sla } };
  });

  // STORE-001: the content-moderation queue (admin side of UGC reporting).
  // POST /reports (moderation.routes) files a report; these two surfaces let an
  // admin work the queue and record a decision — the "act on reports" half the
  // stores require. The onResponse audit hook records every resolution.
  const moderationQuerySchema = z.object({
    status: z.enum(['PENDING', 'REVIEWING', 'ACTIONED', 'DISMISSED']).optional(),
    reason: z.enum(['SPAM', 'HARASSMENT', 'HATE_SPEECH', 'VIOLENCE', 'SEXUAL_CONTENT', 'CSAE', 'ILLEGAL_GOODS', 'OTHER']).optional(),
  });
  const resolveReportSchema = z.object({
    status: z.enum(['REVIEWING', 'ACTIONED', 'DISMISSED']),
    note: z.string().trim().max(2000).optional(),
  });

  app.get('/moderation/reports', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, reason } = moderationQuerySchema.parse(request.query);
    // Default view is the open work: PENDING, first-in-first-out so nothing
    // rots at the back. The reason filter floats CSAE to the top of the queue.
    const where = { ...(status ? { status } : { status: 'PENDING' as const }), ...(reason ? { reason } : {}) };
    const [reports, total, pendingTotal] = await Promise.all([
      tenantPrisma.contentReport.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take: limit }),
      tenantPrisma.contentReport.count({ where }),
      tenantPrisma.contentReport.count({ where: { status: 'PENDING' } }),
    ]);

    // STORE-002: enrich each report with a snapshot of WHAT was reported, so the
    // reviewer sees the content, not an opaque id. Batched by type (no N+1). A
    // null target means the content was already removed — itself a useful signal.
    const idsOf = (t: string) => [...new Set(reports.filter((r) => r.targetType === t).map((r) => r.targetId))];
    const preview = new Map<string, unknown>();
    const stash = (t: string, rows: Array<{ id: string }>) => rows.forEach((row) => preview.set(`${t}:${row.id}`, row));
    const [ratings, messages, users, vendors, items] = await Promise.all([
      idsOf('RATING').length ? tenantPrisma.rating.findMany({ where: { id: { in: idsOf('RATING') } }, select: { id: true, comment: true, score: true, raterId: true } }) : [],
      idsOf('CHAT_MESSAGE').length ? tenantPrisma.chatMessage.findMany({ where: { id: { in: idsOf('CHAT_MESSAGE') } }, select: { id: true, message: true, senderId: true } }) : [],
      idsOf('USER').length ? app.prisma.user.findMany({ where: { id: { in: idsOf('USER') } }, select: { id: true, firstName: true, lastName: true, avatar: true } }) : [],
      idsOf('VENDOR').length ? app.prisma.vendor.findMany({ where: { id: { in: idsOf('VENDOR') } }, select: { id: true, name: true, slug: true } }) : [],
      idsOf('ITEM').length ? tenantPrisma.item.findMany({ where: { id: { in: idsOf('ITEM') } }, select: { id: true, name: true } }) : [],
    ]);
    stash('RATING', ratings); stash('CHAT_MESSAGE', messages); stash('USER', users); stash('VENDOR', vendors); stash('ITEM', items);
    const enriched = reports.map((r) => ({ ...r, target: preview.get(`${r.targetType}:${r.targetId}`) ?? null }));

    return { success: true, pendingTotal, ...paginatedResponse(enriched, total, { page, limit, skip }) };
  });

  app.put('/moderation/reports/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { status, note } = resolveReportSchema.parse(request.body ?? {});
    const existing = await tenantPrisma.contentReport.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('ContentReport', id);
    // ACTIONED/DISMISSED close the report (stamp who + when); REVIEWING just
    // claims it. Enforcement (remove the rating, ban the user) uses the existing
    // admin endpoints — the report records the DECISION, not the mechanism.
    const closing = status === 'ACTIONED' || status === 'DISMISSED';
    const updated = await mutationOrNotFound('ContentReport', id, () => tenantPrisma.contentReport.update({
      where: { id },
      data: {
        status,
        ...(note !== undefined ? { resolutionNote: note } : {}),
        ...(closing ? { resolvedBy: request.user.userId, resolvedAt: new Date() } : {}),
      },
    }));
    return { success: true, data: updated };
  });

  app.put('/orders/:id/cancel', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reason, refund } = cancelOrderSchema.parse(request.body ?? {});

    const order = await app.prisma.order.findUnique({
      where: { id },
      include: { vendor: true },
    });
    if (!order) throw new NotFoundError('Order', id);

    // The canonical set, imported. This list was written by hand with four
    // entries and omitted FAILED. It is NOT exploitable — `ORDER_TRANSITIONS`
    // lists only pre-custody states as predecessors of CANCELLED, so the state
    // machine refuses FAILED → CANCELLED regardless. What the omission cost was
    // the ERROR: an operator force-cancelling a failed order got a transition
    // rejection instead of "Cannot cancel an order with status FAILED".
    if ((TERMINAL_ORDER_STATUSES as string[]).includes(order.status)) {
      throw new AppError(400, 'INVALID_STATUS', `Cannot cancel an order with status ${order.status}`);
    }
    // [REPORT-008 F-03] The legacy boolean refund override is a CASH-era
    // control: on MMG it would mint a REFUNDED terminal (and answer
    // refunded:true) with NO amount, actor, or evidence that the store's
    // external money ever went back — a false financial fact. Fail closed
    // until LB-019 ships the evidence-bearing direct-refund completion rail.
    if (refund && order.paymentMethod === 'MOBILE_MONEY') {
      throw new AppError(
        409,
        'MMG_REFUND_UNAVAILABLE',
        'Swift cannot mark a direct-to-store MMG payment refunded without store refund evidence — the store refunds the customer directly (cancel without the refund flag to close fulfilment).',
      );
    }

    const newStatus: OrderStatus = refund ? 'REFUNDED' : 'CANCELLED';
    const allowedFrom = Object.values(OrderStatus)
      .filter((status) => !(TERMINAL_ORDER_STATUSES as string[]).includes(status)) as OrderStatus[];
    const cancellationReason = reason || 'Cancelled by admin';

    // The fresh source status, order mutation, status evidence, explicit admin
    // audit, booking/search closure, stock, float, and mover release share one
    // transaction. This closes both the crash window and the stale riderId race
    // against a direct board assignment. Socket/push remain post-commit below.
    await orderService.transitionOrderAtomically({
      orderId: id,
      target: newStatus,
      allowedFrom,
      changedBy: request.user.userId,
      note: reason || 'Admin cancellation',
      cancellation: { by: request.user.userId, reason: cancellationReason },
      releaseStaleMoverPointer: true,
      operatorAudit: {
        userId: request.user.userId,
        action: 'CANCEL_ORDER',
        entity: 'Order',
        entityId: id,
        changes: (previousStatus) => ({ reason: reason ?? null, refund: !!refund, previousStatus }),
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      },
      invalidStatus: (current) => new AppError(400, 'INVALID_STATUS', `Cannot cancel an order with status ${current}`),
    });

    // V1 is cash-only: the platform never holds order money, so there is no wallet
    // to credit. A cancellation before handover means no cash changed hands; if cash
    // was already collected, the refund is settled in cash and tracked via the audit
    // log + customer notification below. (Wallet credit is a Part C / fintech-phase
    // concern — see the dormant walletBalance/Transaction schema notes.)

    app.io.to(`order:${id}`).emit('order:status_changed', { orderId: id, status: newStatus });

    // [REPORT-010 F-03] Unattested MMG gets the direct-refund guidance — the
    // customer may have already paid the store's link before this cancel.
    const mmgGuidance = order.paymentMethod === 'MOBILE_MONEY' && order.paymentStatus === 'PENDING'
      ? ' If you already sent the MMG payment, the store refunds you directly.'
      : '';
    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Order Cancelled',
      body: refund
        ? `Your order ${order.orderNumber} has been cancelled. Any cash you paid will be refunded — our team will follow up.`
        : `Your order ${order.orderNumber} has been cancelled. ${reason || ''}${mmgGuidance}`.trim(),
      data: { orderId: id, status: newStatus },
    });

    // [REPORT-012 F-012-04] An admin terminal on an unattested-MMG order must
    // also tell the STORE — it may hold the customer's unconfirmed transfer
    // and is the only rail that can send it back. Same seam as customer
    // cancel, auto-cancel, and the ops agent.
    if (order.paymentMethod === 'MOBILE_MONEY' && order.paymentStatus === 'PENDING' && order.vendorId) {
      const { publishUnattestedMmgCancellation } = await import('../order/order.service');
      await publishUnattestedMmgCancellation(app.prisma, notifications, {
        orderId: id,
        orderNumber: order.orderNumber,
        vendorId: order.vendorId,
      });
    }

    return { success: true, data: { orderId: id, status: newStatus, refunded: !!refund } };
  });

  // ─── Finance ───────────────────────────────────────────────────────────

  app.get('/finance/revenue', { preHandler: [adminGuard] }, async () => {
    // Admin authority is tenant-local. Raw SQL does not pass through Prisma's
    // query extension, and Subscription is an indirect child without its own
    // tenantId, so both paths must carry the authenticated tenant explicitly.
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // [DASH-06] The daily bucket is a GUYANA day, not a UTC one. `placedAt` is
    // `TIMESTAMP(3)` holding UTC, so a bare `DATE("placedAt")` cuts the day at
    // Guyana 20:00 — every order from 20:00 to midnight was filed under
    // TOMORROW. That is the number someone reads to decide whether a day
    // traded well, and four hours of each evening were being handed to the
    // next day. Shift by the same offset `startOfDayGY()` uses (imported, not
    // re-typed as a literal: one implementation of "Guyana is UTC-4") and emit
    // a plain `YYYY-MM-DD` LABEL rather than a `date` — a `date` comes back as
    // a Date, JSON-serialises to a UTC midnight instant, and the browser then
    // shifts it a SECOND time in `toLocaleDateString()`. A label cannot be
    // re-zoned by anyone downstream.
    const gyOffset = `${-GUYANA_UTC_OFFSET_HOURS} hours`;

    const [dailyRevenue, subscriptionRevenue, totalDeliveryFees] = await Promise.all([
      // Daily revenue breakdown for last 30 days, bucketed by Guyana-local day
      app.prisma.$queryRaw<
        Array<{ date: string; markup: unknown; delivery_fees: unknown; total: unknown; order_count: number }>
      >`
        SELECT
          to_char("placedAt" - ${gyOffset}::interval, 'YYYY-MM-DD') as date,
          COALESCE(SUM("subtotalMarkup"), 0) as markup,
          COALESCE(SUM("deliveryFee"), 0) as delivery_fees,
          COALESCE(SUM("totalAmount"), 0) as total,
          COUNT(*)::int as order_count
        FROM orders
        WHERE "placedAt" >= ${thirtyDaysAgo}
          AND "tenantId" = ${tenantId}
          AND status IN ('DELIVERED', 'COMPLETED')
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      // Active subscription revenue
      app.prisma.subscription.findMany({
        where: {
          status: 'ACTIVE',
          ...subscriptionTenantScope(tenantId),
        },
        select: { type: true, weeklyRate: true },
      }),
      // Total delivery fees collected
      app.prisma.order.aggregate({
        where: { createdAt: { gte: thirtyDaysAgo }, status: { in: ['DELIVERED', 'COMPLETED'] } },
        _sum: { deliveryFee: true, subtotalMarkup: true },
      }),
    ]);

    const weeklySubRevenue = subscriptionRevenue.reduce((acc, s) => acc + Number(s.weeklyRate), 0);
    const monthlySubRevenue = weeklySubRevenue * 4; // approximate

    return {
      success: true,
      data: {
        // `SUM(numeric)` comes back from $queryRaw as a Prisma Decimal, i.e. a
        // JSON string, while `RevenueResponse.dailyRevenue[].total` is typed
        // `number`. Coerce at the seam.
        dailyRevenue: coerceMoney(dailyRevenue),
        summary: {
          // SWIFT-119 again: a Prisma Decimal is TRUTHY, so `|| 0` never fired
          // and the raw Decimal went out as a string. `?? 0` for the genuinely
          // absent aggregate (no rows), `Number()` for the present one.
          thirtyDayMarkup: Number(totalDeliveryFees._sum.subtotalMarkup ?? 0),
          thirtyDayDeliveryFees: Number(totalDeliveryFees._sum.deliveryFee ?? 0),
          weeklySubscriptionRevenue: weeklySubRevenue,
          monthlySubscriptionRevenue: monthlySubRevenue,
          activeSubscriptions: subscriptionRevenue.length,
        },
      },
    };
  });

  app.get('/finance/settlements', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, vendorId } = settlementsQuerySchema.parse(request.query);

    if (vendorId) {
      const vendor = await app.prisma.vendor.findFirst({ where: { id: vendorId, tenantId }, select: { id: true } });
      if (!vendor) throw new NotFoundError('Vendor', vendorId);
    }

    const where: any = {
      vendor: { tenantId },
      ...(status && { status }),
      ...(vendorId && { vendorId }),
    };

    const [settlements, total] = await Promise.all([
      app.prisma.settlement.findMany({
        where,
        include: {
          vendor: { select: { id: true, name: true, slug: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.settlement.count({ where }),
    ]);

    // Settlement.totalBase / totalMarkup are Decimal(12,2) — the figure the
    // finance page prints next to a "Mark paid" button. Coerce at the seam.
    return { success: true, ...paginatedResponse(coerceMoney(settlements), total, { page, limit, skip }) };
  });

  app.put('/finance/settlements/:id/process', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { id } = request.params as { id: string };
    const { reference } = processSettlementSchema.parse(request.body ?? {});

    const settlement = await app.prisma.settlement.findFirst({
      where: { id, vendor: { tenantId } },
      include: { vendor: { include: { owner: true } } },
    });
    if (!settlement) throw new NotFoundError('Settlement', id);
    if (settlement.status === 'PAID') throw new AppError(400, 'ALREADY_PAID', 'Settlement has already been processed');

    // Compare-and-set: this is a real payout instruction. Two admins (or a
    // double-click / retry) both passing the in-memory check would otherwise both
    // mark PAID and both fire the payout notification — a duplicate payout.
    const claimed = await app.prisma.settlement.updateManyAndReturn({
      where: { id, status: { not: 'PAID' }, vendor: { tenantId } },
      data: { status: 'PAID', paidAt: new Date(), reference: reference || null },
    });
    if (claimed.length === 0) {
      const stillLocal = await app.prisma.settlement.findFirst({ where: { id, vendor: { tenantId } }, select: { id: true } });
      if (!stillLocal) throw new NotFoundError('Settlement', id);
      throw new AppError(409, 'ALREADY_PAID', 'Settlement has already been processed');
    }
    const updated = claimed[0]!;

    await audit(request.user.userId, 'PROCESS_SETTLEMENT', 'Settlement', id, { amount: settlement.totalBase, reference }, request);

    // SWIFT-031: this is a weekly SALES DIGEST, not a payout. Swift takes no
    // commission and never holds vendor money (cash is customer→vendor direct),
    // so "settlement processed / payment received" was a fiction. Reframe the
    // copy to what it truly is — a record of the vendor's own completed sales.
    await notifications.send({
      userId: settlement.vendor.owner.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Weekly sales digest ready',
      body: `${settlement.vendor.name}: $${Number(settlement.totalBase).toLocaleString()} GYD in completed sales this week. Swift takes no cut — this is your record, not a payout.`,
      data: { settlementId: id },
    });

    return { success: true, data: updated };
  });

  /** MMG direct-pay ledger (visibility ONLY — Swift moves no money): the
   *  delivery fees stores owe riders in cash on MMG-paid orders, with the
   *  dual-confirm state each row is in. Outstanding = anything not SETTLED. */
  app.get('/finance/cash-settlements', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, vendorId, riderId } = cashSettlementsQuerySchema.parse(request.query);

    if (vendorId) {
      const vendor = await app.prisma.vendor.findFirst({ where: { id: vendorId, tenantId }, select: { id: true } });
      if (!vendor) throw new NotFoundError('Vendor', vendorId);
    }
    if (riderId) {
      const rider = await app.prisma.rider.findFirst({ where: { id: riderId, user: { tenantId } }, select: { id: true } });
      if (!rider) throw new NotFoundError('Rider', riderId);
    }

    const where: any = {
      order: { tenantId },
      rider: { user: { tenantId } },
      vendor: { tenantId },
      ...(status && { status }),
      ...(vendorId && { vendorId }),
      ...(riderId && { riderId }),
    };

    const [rows, total, byStatus] = await Promise.all([
      app.prisma.deliveryCashSettlement.findMany({
        where,
        include: {
          order: { select: { orderNumber: true } },
          vendor: { select: { id: true, name: true } },
          rider: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.deliveryCashSettlement.count({ where }),
      // Unfiltered health totals — how much store→rider cash is in each state.
      app.prisma.deliveryCashSettlement.groupBy({
        by: ['status'],
        where: { order: { tenantId }, rider: { user: { tenantId } }, vendor: { tenantId } },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    const summary = Object.fromEntries(
      byStatus.map((b) => [b.status, { total: Number(b._sum.amount ?? 0), count: b._count }]),
    );
    const data = rows.map((s) => ({
      id: s.id,
      orderId: s.orderId,
      orderNumber: s.order?.orderNumber ?? null,
      amount: Number(s.amount),
      status: s.status,
      riderConfirmedAt: s.riderConfirmedAt,
      storeConfirmedAt: s.storeConfirmedAt,
      createdAt: s.createdAt,
      vendor: s.vendor ? { id: s.vendor.id, name: s.vendor.name } : null,
      rider: s.rider
        ? { id: s.rider.id, name: [s.rider.user.firstName, s.rider.user.lastName].filter(Boolean).join(' ') }
        : null,
    }));

    const paged = paginatedResponse(data, total, { page, limit, skip });
    return { success: true, ...paged, summary };
  });

  /** MMG-vs-cash mix, last 30 days of completed orders, plus MMG confirmation
   *  health (UNPAID after delivery = vendor never confirmed / never paid). */
  app.get('/finance/payment-mix', { preHandler: [adminGuard] }, async () => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const completed = { createdAt: { gte: thirtyDaysAgo }, status: { in: ['DELIVERED', 'COMPLETED'] as any } };

    const [byMethod, mmgUnconfirmed] = await Promise.all([
      app.prisma.order.groupBy({
        by: ['paymentMethod'],
        where: completed,
        _sum: { totalAmount: true },
        _count: true,
      }),
      app.prisma.order.count({
        where: { ...completed, paymentMethod: 'MOBILE_MONEY', paymentStatus: { not: 'CAPTURED' } },
      }),
    ]);

    return {
      success: true,
      data: {
        byMethod: byMethod.map((m) => ({
          method: m.paymentMethod,
          count: m._count,
          total: Number(m._sum.totalAmount ?? 0),
        })),
        mmgUnconfirmed,
      },
    };
  });

  // ─── Config ────────────────────────────────────────────────────────────

  app.get('/config', { preHandler: [platformControlGuard] }, async () => {
    const configs = await app.prisma.platformConfig.findMany({
      orderBy: { key: 'asc' },
    });
    return { success: true, data: configs };
  });

  app.put('/config/:key', { preHandler: [platformControlGuard] }, async (request) => {
    const key = configKeySchema.parse((request.params as { key: string }).key);
    const { value } = configValueSchema.parse(request.body);

    const config = await app.prisma.platformConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });

    await audit(request.user.userId, 'UPDATE_CONFIG', 'PlatformConfig', key, { value }, request);

    return { success: true, data: config };
  });

  // ─── Promos ────────────────────────────────────────────────────────────

  app.get('/promos', { preHandler: [platformControlGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { active } = promosQuerySchema.parse(request.query);

    const where: any = {
      ...(active === 'true' && { isActive: true }),
      ...(active === 'false' && { isActive: false }),
    };

    const [promos, total] = await Promise.all([
      app.prisma.promoCode.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      app.prisma.promoCode.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(promos, total, { page, limit, skip }) };
  });

  app.post('/promos', { preHandler: [platformControlGuard] }, async (request) => {
    const body = createPromoSchema.parse(request.body);

    // Ensure code is unique and uppercase
    const existingCode = await app.prisma.promoCode.findUnique({ where: { code: body.code.toUpperCase() } });
    if (existingCode) throw new AppError(409, 'DUPLICATE_CODE', 'A promo code with this code already exists');

    const promo = await app.prisma.promoCode.create({
      data: {
        code: body.code.toUpperCase(),
        description: body.description,
        discountType: body.discountType,
        discountValue: body.discountValue,
        minOrderAmount: body.minOrderAmount,
        maxDiscount: body.maxDiscount,
        applicableTo: (body.applicableTo || []) as any,
        validFrom: new Date(body.validFrom),
        validUntil: new Date(body.validUntil),
        maxUses: body.maxUses,
        maxUsesPerUser: body.maxUsesPerUser || 1,
      },
    });

    await audit(request.user.userId, 'CREATE_PROMO', 'PromoCode', promo.id, { code: promo.code }, request);

    return { success: true, data: promo };
  });

  app.put('/promos/:id', { preHandler: [platformControlGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = updatePromoSchema.parse(request.body);

    const existing = await app.prisma.promoCode.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('PromoCode', id);

    const promo = await app.prisma.promoCode.update({
      where: { id },
      data: {
        ...(body.description !== undefined && { description: body.description }),
        ...(body.discountValue !== undefined && { discountValue: body.discountValue }),
        ...(body.minOrderAmount !== undefined && { minOrderAmount: body.minOrderAmount }),
        ...(body.maxDiscount !== undefined && { maxDiscount: body.maxDiscount }),
        ...(body.validFrom !== undefined && { validFrom: new Date(body.validFrom) }),
        ...(body.validUntil !== undefined && { validUntil: new Date(body.validUntil) }),
        ...(body.maxUses !== undefined && { maxUses: body.maxUses }),
        ...(body.maxUsesPerUser !== undefined && { maxUsesPerUser: body.maxUsesPerUser }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
      },
    });

    await audit(request.user.userId, 'UPDATE_PROMO', 'PromoCode', id, body as Record<string, unknown>, request);

    return { success: true, data: promo };
  });

  app.delete('/promos/:id', { preHandler: [platformControlGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const existing = await app.prisma.promoCode.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('PromoCode', id);

    // Soft-delete: deactivate rather than removing data
    await app.prisma.promoCode.update({
      where: { id },
      data: { isActive: false },
    });

    await audit(request.user.userId, 'DELETE_PROMO', 'PromoCode', id, { code: existing.code }, request);

    return { success: true, message: 'Promo code deactivated' };
  });

  // ─── Zones ─────────────────────────────────────────────────────────────

  app.get('/zones', { preHandler: [platformControlGuard] }, async () => {
    const zones = await app.prisma.zone.findMany({
      orderBy: { name: 'asc' },
    });
    return { success: true, data: zones };
  });

  app.post('/zones', { preHandler: [platformControlGuard] }, async (request) => {
    const body = createZoneSchema.parse(request.body);

    const zone = await app.prisma.zone.create({
      data: {
        name: body.name,
        description: body.description,
        boundary: body.boundary,
        deliveryBaseFee: body.deliveryBaseFee,
        deliveryPerKm: body.deliveryPerKm,
        surgeMultiplier: body.surgeMultiplier || 1.0,
      },
    });

    await audit(request.user.userId, 'CREATE_ZONE', 'Zone', zone.id, { name: zone.name }, request);

    return { success: true, data: zone };
  });

  app.put('/zones/:id', { preHandler: [platformControlGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = updateZoneSchema.parse(request.body);

    const existing = await app.prisma.zone.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Zone', id);

    const zone = await app.prisma.zone.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.boundary !== undefined && { boundary: body.boundary }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        ...(body.deliveryBaseFee !== undefined && { deliveryBaseFee: body.deliveryBaseFee }),
        ...(body.deliveryPerKm !== undefined && { deliveryPerKm: body.deliveryPerKm }),
        ...(body.surgeMultiplier !== undefined && { surgeMultiplier: body.surgeMultiplier }),
      },
    });

    await audit(request.user.userId, 'UPDATE_ZONE', 'Zone', id, body as Record<string, unknown>, request);

    return { success: true, data: zone };
  });

  app.delete('/zones/:id', { preHandler: [platformControlGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const existing = await app.prisma.zone.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Zone', id);

    // Soft-delete: deactivate the zone
    await app.prisma.zone.update({
      where: { id },
      data: { isActive: false },
    });

    await audit(request.user.userId, 'DELETE_ZONE', 'Zone', id, { name: existing.name }, request);

    return { success: true, message: 'Zone deactivated' };
  });

  // ─── Subscriptions ─────────────────────────────────────────────────────

  app.get('/subscriptions', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, type } = subscriptionsQuerySchema.parse(request.query);

    const where: any = {
      ...subscriptionTenantScope(tenantId),
      ...(status && { status }),
      ...(type && { type }),
    };

    const [subscriptions, total] = await Promise.all([
      app.prisma.subscription.findMany({
        where,
        include: {
          rider: { include: { user: { select: { id: true, firstName: true, lastName: true, phone: true } } } },
          driver: { include: { user: { select: { id: true, firstName: true, lastName: true, phone: true } } } },
          vendor: { select: { id: true, name: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.subscription.count({ where }),
    ]);

    // Subscription.weeklyRate / customRate are Decimal(10,2) — this IS Swift's
    // revenue line (flat weekly fee, no commission). Coerce at the seam.
    return { success: true, ...paginatedResponse(coerceMoney(subscriptions), total, { page, limit, skip }) };
  });

  app.put('/subscriptions/:id/waive-fee', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { id } = request.params as { id: string };
    const { reason } = reasonSchema.parse(request.body ?? {});
    const tenantScope = subscriptionTenantScope(tenantId);

    const subscription = await app.prisma.subscription.findFirst({
      where: { id, ...tenantScope },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { owner: { select: { userId: true } } } },
      },
    });
    if (!subscription) throw new NotFoundError('Subscription', id);

    const updated = await mutationOrNotFound('Subscription', id, () => app.prisma.subscription.update({
      where: { id, ...tenantScope },
      data: {
        feeWaived: true,
        feeWaivedBy: request.user.userId,
        feeWaivedReason: reason || 'Waived by admin',
      },
    }));

    await audit(request.user.userId, 'WAIVE_SUBSCRIPTION_FEE', 'Subscription', id, { reason }, request);

    // Notify the subscription holder
    const notifyUserId = subscription.riderId
      ? subscription.rider?.userId
      : subscription.driverId
        ? subscription.driver?.userId
        : subscription.vendorId
          ? subscription.vendor?.owner.userId
          : null;

    if (notifyUserId) {
      await notifications.send({
        userId: notifyUserId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Subscription Fee Waived',
        body: 'Your subscription fee has been waived. You will not be charged for this period.',
      });
    }

    return { success: true, data: updated };
  });

  /** Record a cash/bank-transfer top-up (manual confirm for now).
   *  A top-up while PAST_DUE/SUSPENDED bills immediately and reinstates. */
  app.post('/subscriptions/:id/topup', { preHandler: [adminGuard] }, async (request) => {
    requireDefaultTenantBilling();
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { id } = request.params as { id: string };
    const body = topUpSchema.parse(request.body);

    const subscription = await app.prisma.subscription.findFirst({
      where: {
        id,
        ...subscriptionTenantScope(tenantId),
      },
      select: { id: true },
    });
    if (!subscription) throw new NotFoundError('Subscription', id);

    // SWIFT-030: an Idempotency-Key header makes a retry of the same top-up a
    // no-op (no double-credit). The admin console sends one per top-up action.
    const clientKey = request.headers['idempotency-key'] as string | undefined;
    const balance = await billing.recordTopUp(id, body.amount, request.user.userId, body.reference, clientKey);
    await audit(request.user.userId, 'PREPAID_TOPUP', 'Subscription', id, { amount: body.amount, reference: body.reference }, request);

    return { success: true, data: { balance: Number(balance.balance), currencyCode: balance.currencyCode } };
  });

  /** Billing audit trail for one subscription. */
  app.get('/subscriptions/:id/billing-events', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = getTenantId();
    if (!tenantId) throw new ForbiddenError('Tenant context required');
    const { id } = request.params as { id: string };
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);

    const subscription = await app.prisma.subscription.findFirst({
      where: {
        id,
        ...subscriptionTenantScope(tenantId),
      },
      select: { id: true },
    });
    if (!subscription) throw new NotFoundError('Subscription', id);

    const where = { subscriptionId: id };
    const [events, total] = await Promise.all([
      tenantPrisma.billingEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      tenantPrisma.billingEvent.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(events, total, { page, limit, skip }) };
  });

  // ─── Notifications / Broadcast ─────────────────────────────────────────

  app.post('/notifications/broadcast', { preHandler: [adminGuard] }, async (request) => {
    const { title, body, role, data, category } = broadcastSchema.parse(request.body);

    const where: any = {
      status: 'ACTIVE',
      ...(role && { activeRole: role }),
    };

    const users = await app.prisma.user.findMany({
      where,
      select: { id: true },
    });

    let userIds = users.map((u) => u.id);

    // [F-021-03] Marketing broadcasts pass through the consent ledger: only
    // subjects whose LATEST marketing row is granted/re_granted AT THE
    // CURRENT legal version receive anything. Withdrawn means zero sends.
    if (category === 'marketing' && userIds.length > 0) {
      const { LEGAL_VERSION } = await import('../legal/legal.routes');
      const consented = await app.prisma.$queryRaw<{ subjectId: string }[]>`
        SELECT DISTINCT ON ("subjectId") "subjectId", action, "documentVersion"
        FROM consent_records
        WHERE "subjectType" = 'customer' AND "documentType" = 'marketing_consent'
        ORDER BY "subjectId", "capturedAt" DESC`;
      const allowed = new Set(
        consented
          .filter((r: any) => (r.action === 'granted' || r.action === 're_granted') && r.documentVersion === LEGAL_VERSION)
          .map((r) => r.subjectId),
      );
      userIds = userIds.filter((id) => allowed.has(id));
    }

    if (userIds.length === 0) {
      return { success: true, data: { sent: 0 } };
    }

    // Batch create notifications
    await app.prisma.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        type: 'SYSTEM_ANNOUNCEMENT' as const,
        title,
        body,
        data: (data ?? undefined) as any,
      })),
    });

    // Push via Socket.IO to each user's room
    const payload = {
      type: 'SYSTEM_ANNOUNCEMENT',
      title,
      body,
      data,
      createdAt: new Date().toISOString(),
    };

    for (const userId of userIds) {
      app.io.to(`user:${userId}`).emit('notification', payload);
    }

    await audit(
      request.user.userId,
      'BROADCAST_NOTIFICATION',
      'Notification',
      'broadcast',
      { title, role: role || 'ALL', recipientCount: userIds.length },
      request,
    );

    return { success: true, data: { sent: userIds.length, role: role || 'ALL' } };
  });

  // ─── Verification Review Queue ───────────────────────────────

  // ── Swift Ads — advertiser application queue (ads-platform spec §4.3) ──────
  // A new queue TYPE on the existing admin surface, not a new system. The
  // global adminGuard + onResponse auto-audit already cover these; the service
  // also writes AdsAuditLog with before/after per action.
  const advertiserSvc = new AdvertiserService(app.prisma, app.io);

  app.get('/ads/advertisers/queue', { preHandler: [adminGuard] }, async (request) => {
    const { status } = z.object({ status: z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED']).default('PENDING_REVIEW') }).parse(request.query ?? {});
    return { success: true, data: await advertiserSvc.queue(status) };
  });

  app.put('/ads/advertisers/:id/approve', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    return { success: true, data: await advertiserSvc.approve(id, request.user.userId) };
  });

  app.put('/ads/advertisers/:id/reject', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(request.body ?? {});
    return { success: true, data: await advertiserSvc.reject(id, request.user.userId, reason) };
  });

  app.put('/ads/advertisers/:id/suspend', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(request.body ?? {});
    return { success: true, data: await advertiserSvc.suspend(id, request.user.userId, reason) };
  });

  app.put('/ads/advertisers/:id/reinstate', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    return { success: true, data: await advertiserSvc.reinstate(id, request.user.userId) };
  });

  // ── Ad creative review queue + campaign kill (spec §10 / §6.1) ────────────
  const creativeSvc = new CreativeService(tenantPrisma, app.io);
  const adsLifecycle = new AdsLifecycleService(tenantPrisma, app.io);

  app.get('/ads/creatives/queue', { preHandler: [adminGuard] }, async () => {
    return { success: true, data: await creativeSvc.queue() };
  });

  app.put('/ads/creatives/:id/approve', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    return { success: true, data: await creativeSvc.approve(id, request.user.userId) };
  });

  app.put('/ads/creatives/:id/reject', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({ reason: z.enum(CREATIVE_REJECT_REASONS), notes: z.string().trim().max(500).optional() }).parse(request.body ?? {});
    return { success: true, data: await creativeSvc.reject(id, request.user.userId, body.reason, body.notes) };
  });

  /** §6.1 kill — admin removes a campaign for a policy violation (audited). */
  app.put('/ads/campaigns/:id/kill', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(request.body ?? {});
    const killed = await adsLifecycle.transition(id, 'kill', request.user.userId, reason);
    // §8.4 row 5: kill refunds future weeks by default (current week 0%).
    const { AdsRefundService } = await import('../ads/refund.service');
    await new AdsRefundService(tenantPrisma, app.io).execute(id, 'ADMIN_KILL', request.user.userId).catch(() => {});
    return { success: true, data: { id: killed.id, status: killed.status } };
  });

  /** §8.2 admin "mark invoice paid" — the Caribbean reality path (bank
   *  transfer / MMG sent outside checkout). Requires a reference note; audited;
   *  idempotent. Confirms bookings + moves the campaign into creative review. */
  app.put('/ads/invoices/:id/mark-paid', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reference } = z.object({ reference: z.string().trim().min(3).max(200) }).parse(request.body ?? {});
    const { AdCheckoutService } = await import('../ads/checkout.service');
    const invoice = await new AdCheckoutService(tenantPrisma, app.io).markPaid(id, { adminUserId: request.user.userId, manualReference: reference });
    return { success: true, data: { id: invoice.id, number: invoice.number, status: invoice.status, paidAt: invoice.paidAt } };
  });

  /** Seed the three home placements + AdsSettings for the tenant (ads §2).
   *  Idempotent, create-only for tunables — the operator edits prices/slots by
   *  updating the AdPlacement rows afterward. */
  app.post('/ads/placements/seed', { preHandler: [adminGuard] }, async () => {
    const { seedAdPlacements } = await import('../ads/placement.seed');
    const { getTenantId } = await import('../../plugins/tenant-context');
    const seeded = await seedAdPlacements(app.prisma, getTenantId() ?? 'swift-default');
    return { success: true, data: { seeded } };
  });

  // ── Ads operator console (spec §15.3/§15.4/§15.5/§15.7/§15.8) ─────────────
  const adsRevenue = new AdsRevenueService(app.prisma);
  const adsTenant = async () => {
    const { getTenantId } = await import('../../plugins/tenant-context');
    return getTenantId() ?? 'swift-default';
  };

  /** §15.8 revenue dashboard — booked vs recognized (§8.5, never conflated) by
   *  week × placement, fill rate, advertiser count, and the invoice tie-out.
   *  Defaults to the last 8 + next 4 weeks. */
  app.get('/ads/revenue', { preHandler: [adminGuard] }, async (request) => {
    const q = z.object({ from: z.string().date().optional(), to: z.string().date().optional() }).parse(request.query ?? {});
    const now = new Date();
    const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(now.getTime() - 8 * 7 * 86_400_000);
    const to = q.to ? new Date(`${q.to}T00:00:00Z`) : new Date(now.getTime() + 4 * 7 * 86_400_000);
    if (to < from) throw new AppError(400, 'BAD_RANGE', 'to must be on or after from.');
    return { success: true, data: await adsRevenue.dashboard(await adsTenant(), from, to) };
  });

  /** §15.3 inventory calendar — placements × next N weeks occupancy per city,
   *  with campaign click-through. */
  app.get('/ads/inventory', { preHandler: [adminGuard] }, async (request) => {
    const q = z.object({ weeks: z.coerce.number().int().min(1).max(26).default(12) }).parse(request.query ?? {});
    return { success: true, data: await adsRevenue.inventoryCalendar(await adsTenant(), q.weeks) };
  });

  /** §15.5 campaigns table with filters. */
  app.get('/ads/campaigns', { preHandler: [adminGuard] }, async (request) => {
    const q = z.object({
      status: z.enum(['DRAFT', 'PENDING_PAYMENT', 'PENDING_REVIEW', 'SCHEDULED', 'LIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'REJECTED']).optional(),
      advertiserId: z.string().optional(),
      placementId: z.string().optional(),
    }).parse(request.query ?? {});
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.advertiserId ? { advertiserId: q.advertiserId } : {}),
      ...(q.placementId ? { placementId: q.placementId } : {}),
    };
    const [campaigns, total] = await Promise.all([
      app.prisma.adCampaign.findMany({
        where,
        include: {
          advertiser: { select: { companyName: true } },
          placement: { select: { key: true, name: true } },
          invoices: { select: { number: true, status: true, amount: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      app.prisma.adCampaign.count({ where }),
    ]);
    return paginatedResponse(
      campaigns.map((c) => ({
        id: c.id, name: c.name, status: c.status, statusReason: c.statusReason,
        advertiser: c.advertiser.companyName, placement: c.placement.key, placementName: c.placement.name,
        cities: c.cities, startWeek: c.startWeek, endWeek: c.endWeek,
        totalAmount: c.totalAmount ? Number(c.totalAmount) : null, currency: c.currency,
        invoices: c.invoices.map((i) => ({ number: i.number, status: i.status, amount: Number(i.amount) })),
        createdAt: c.createdAt,
      })),
      total,
      { page, limit, skip },
    );
  });

  /** §15.4 placement pricing config. Price changes affect FUTURE bookings only
   *  (E4: price is locked on booking rows at checkout). */
  app.put('/ads/placements/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      name: z.string().trim().min(2).max(80).optional(),
      weeklyPrice: z.number().positive().optional(),
      slotsPerWeek: z.number().int().min(1).max(20).optional(),
      rotationSeconds: z.number().int().min(3).max(60).nullable().optional(),
      freqCapPerUserPerDay: z.number().int().min(1).max(100).nullable().optional(),
      active: z.boolean().optional(),
    }).parse(request.body ?? {});
    const existing = await app.prisma.adPlacement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('AdPlacement', id);
    const updated = await app.prisma.adPlacement.update({ where: { id }, data: body });
    return { success: true, data: { id: updated.id, key: updated.key, name: updated.name, weeklyPrice: Number(updated.weeklyPrice), slotsPerWeek: updated.slotsPerWeek, rotationSeconds: updated.rotationSeconds, freqCapPerUserPerDay: updated.freqCapPerUserPerDay, active: updated.active } };
  });

  /** §15.4 tenant knobs (reservation TTL, SLA, refund windows, …). Upsert —
   *  the row is born with schema defaults on first write. */
  app.get('/ads/settings', { preHandler: [adminGuard] }, async () => {
    const tenantId = await adsTenant();
    const s = await app.prisma.adsSettings.findUnique({ where: { tenantId } });
    return { success: true, data: s ?? { tenantId } };
  });

  app.put('/ads/settings', { preHandler: [adminGuard] }, async (request) => {
    const body = z.object({
      reservationMinutes: z.number().int().min(5).max(120).optional(),
      reviewSlaHours: z.number().int().min(1).max(168).optional(),
      cancelFullRefundDays: z.number().int().min(0).max(30).optional(),
      autoCancelUnapprovedHours: z.number().int().min(1).max(168).optional(),
      defaultRotationSeconds: z.number().int().min(3).max(60).optional(),
    }).parse(request.body ?? {});
    const tenantId = await adsTenant();
    const s = await app.prisma.adsSettings.upsert({ where: { tenantId }, create: { tenantId, ...body }, update: body });
    return { success: true, data: s };
  });

  // ── §15.7 house ads manager — the operator's own fallback fills. CRUD +
  //    sort; no hard deletes (§18) — deactivate instead. Serving reads only
  //    active rows ordered by sort. ────────────────────────────────────────────
  app.get('/ads/house', { preHandler: [adminGuard] }, async () => {
    const tenantId = await adsTenant();
    const rows = await app.prisma.houseAd.findMany({
      where: { tenantId },
      include: { placement: { select: { key: true, name: true, mediaKind: true } } },
      orderBy: [{ placementId: 'asc' }, { sort: 'asc' }],
    });
    return { success: true, data: rows };
  });

  /** Create a house ad — multipart: `file` (image/mp4, same §9.1 caps as paid
   *  creatives) + optional `poster` image for videos + form fields. */
  app.post('/ads/house', { preHandler: [adminGuard] }, async (request) => {
    let fileBuffer: Buffer | null = null;
    let fileMime = '';
    let fileName = '';
    let posterBuffer: Buffer | null = null;
    let posterMime = '';
    const fields: Record<string, string> = {};
    // Per-call transport cap: file + optional poster (global limit is 1 file,
    // 5 MB — house videos share the §9.1 25 MB cap).
    for await (const part of request.parts({ limits: { fileSize: 25 * 1024 * 1024, files: 2 } })) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        if (part.fieldname === 'poster') { posterBuffer = buf; posterMime = part.mimetype; }
        else { fileBuffer = buf; fileMime = part.mimetype; fileName = part.filename; }
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
    const body = z.object({
      placementId: z.string().min(1),
      kind: z.enum(['IMAGE', 'VIDEO']).default('IMAGE'),
      headline: z.string().trim().max(60).optional(),
      ctaLabel: z.string().trim().max(15).optional(),
      destinationType: z.enum(['NONE', 'URL', 'DEEPLINK']).default('NONE'),
      destinationValue: z.string().trim().max(500).optional(),
      sort: z.coerce.number().int().min(0).max(999).default(0),
    }).parse(fields);
    const placement = await app.prisma.adPlacement.findUnique({ where: { id: body.placementId } });
    if (!placement) throw new NotFoundError('AdPlacement', body.placementId);
    if (body.kind !== placement.mediaKind) throw new AppError(400, 'WRONG_MEDIA_KIND', `This placement takes ${placement.mediaKind}, not ${body.kind}.`);
    if (!fileBuffer) throw new AppError(400, 'NO_FILE', 'Attach the house ad file.');
    if (body.kind === 'IMAGE') {
      if (!looksLikeImage(fileBuffer)) throw new AppError(400, 'BAD_IMAGE', 'Upload a JPEG, PNG, or WebP image.');
      if (fileBuffer.length > 500 * 1024) throw new AppError(400, 'IMAGE_TOO_LARGE', 'Image must be ≤500 KB.');
    } else {
      if (!looksLikeMp4(fileBuffer)) throw new AppError(400, 'BAD_VIDEO', 'Upload an MP4 video.');
      if (fileBuffer.length > 25 * 1024 * 1024) throw new AppError(400, 'VIDEO_TOO_LARGE', 'Video must be ≤25 MB.');
    }
    if (posterBuffer && !looksLikeImage(posterBuffer)) throw new AppError(400, 'BAD_POSTER', 'Poster must be an image.');

    const tenantId = await adsTenant();
    const { url } = await getStorageProvider().upload({ buffer: fileBuffer, filename: fileName || 'house-ad', mimeType: fileMime, folder: 'ads/house' });
    let posterUrl: string | null = null;
    if (posterBuffer) {
      posterUrl = (await getStorageProvider().upload({ buffer: posterBuffer, filename: 'poster', mimeType: posterMime, folder: 'ads/house' })).url;
    }
    const row = await app.prisma.houseAd.create({
      data: {
        tenantId, placementId: body.placementId, kind: body.kind, fileUrl: url, posterUrl,
        headline: body.headline ?? null, ctaLabel: body.ctaLabel ?? null,
        destinationType: body.destinationType, destinationValue: body.destinationValue ?? null,
        sort: body.sort,
      },
    });
    return { success: true, data: row };
  });

  // ── Trial integrity (spec Part 9) — the identity graph is FOUNDER-ONLY
  //    god's-eye tooling: platform-wide by design (the one sanctioned
  //    cross-tenant system). The platformControlGuard + onResponse auto-audit
  //    cover these surfaces — every view leaves an audit row. ──────────────────

  /** Phase 2 backfill: run the matcher across the existing user base and
   *  return the evidence report. Idempotent; evidence first, decisions second
   *  — nothing here enforces anything. */
  app.post('/integrity/backfill', { preHandler: [platformControlGuard] }, async () => {
    const { runIdentityBackfill } = await import('../integrity/backfill');
    return { success: true, data: await runIdentityBackfill(app.prisma) };
  });

  /** The explainability read (Part 9.1/9.4): one account's cluster — members,
   *  every link's evidence, trial history, enforcement history, exceptions,
   *  and SOFT advisories. Every enforcement must be explainable from here. */
  app.get<{ Params: { userId: string } }>('/integrity/identity/:userId', { preHandler: [platformControlGuard] }, async (request) => {
    const { IdentityService } = await import('../integrity/identity.service');
    const identity = new IdentityService(app.prisma);
    const clusterId = await identity.resolveCluster(request.params.userId);
    if (!clusterId) {
      return { success: true, data: { clusterId: null, members: [], trialGrants: [], enforcement: [], exceptions: [], softAdvisories: await identity.softAdvisories(request.params.userId) } };
    }
    const [members, grants, enforcement, exceptions, advisories] = await Promise.all([
      app.prisma.identityClusterMember.findMany({ where: { clusterId } }),
      app.prisma.trialGrant.findMany({ where: { clusterId }, orderBy: { startedAt: 'asc' } }),
      app.prisma.enforcementAction.findMany({ where: { clusterId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      app.prisma.exceptionGrant.findMany({ where: { clusterId } }),
      identity.softAdvisories(request.params.userId),
    ]);
    const users = await app.prisma.user.findMany({
      where: { id: { in: members.map((m) => m.accountId) } },
      select: { id: true, phone: true, firstName: true, lastName: true, roles: true, status: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    return {
      success: true,
      data: {
        clusterId,
        members: members.map((m) => ({
          accountId: m.accountId,
          user: userById.get(m.accountId) ?? null,
          linkedVia: m.linkedVia,
          addedAt: m.addedAt,
        })),
        trialGrants: grants,
        enforcement,
        exceptions,
        softAdvisories: advisories,
      },
    };
  });

  // ── USD Platform Pricing (batching/USD spec System 2, Part 12/20) — rate
  //    governance: founder-controlled, boring on purpose. Append-only rates;
  //    the fat-finger guard is how 208.72 never becomes 2087.2 in prod. ──────

  app.get('/billing/fx-rates', { preHandler: [platformControlGuard] }, async (request) => {
    const { quote } = z.object({ quote: z.string().length(3).optional() }).parse(request.query ?? {});
    const { rateStaleness } = await import('../billing/fx');
    const rates = await app.prisma.fxRate.findMany({
      where: quote ? { quote } : {},
      orderBy: [{ quote: 'asc' }, { effectiveFrom: 'desc' }],
      take: 100,
    });
    return {
      success: true,
      data: rates.map((r) => ({ ...r, rate: Number(r.rate), staleness: rateStaleness(r.effectiveFrom) })),
    };
  });

  /** Append a rate. >20% moves require typing the quote code back
   *  (confirmQuote) — the delta comes back in words on the first attempt. */
  app.post('/billing/fx-rates', { preHandler: [platformControlGuard] }, async (request) => {
    const body = z.object({
      quote: z.string().length(3).toUpperCase(),
      rate: z.number().positive(),
      source: z.enum(['FOUNDER_MANUAL', 'BOG_REFERENCE']).default('FOUNDER_MANUAL'),
      effectiveFrom: z.string().datetime().optional(),
      confirmQuote: z.string().optional(),
    }).parse(request.body ?? {});
    const { validateNewRate, convertUsdToLocal, formatMoney } = await import('../billing/fx');
    const previous = await app.prisma.fxRate.findFirst({ where: { quote: body.quote }, orderBy: { effectiveFrom: 'desc' } });
    const check = validateNewRate(body.rate, previous ? Number(previous.rate) : null);
    if (!check.ok) throw new AppError(400, 'INVALID_RATE', check.error!);
    if (check.requiresTypedConfirmation && body.confirmQuote !== body.quote) {
      // Show the change in words against a US$25 reference plan (Part 20).
      const tenant = await app.prisma.tenantBillingCurrency.findFirst({ where: { settlementCurrency: body.quote } });
      const inc = tenant ? Number(tenant.roundingIncrement) : 1;
      const before = previous ? convertUsdToLocal(25, Number(previous.rate), inc).amountLocal : null;
      const after = convertUsdToLocal(25, body.rate, inc).amountLocal;
      throw new AppError(
        409,
        'RATE_CONFIRMATION_REQUIRED',
        `This rate moves ${Math.round((check.deltaPct ?? 0) * 100)}% — a US$25.00 plan changes from ${before !== null ? formatMoney(before, body.quote) : 'n/a'} to ${formatMoney(after, body.quote)} per week. Re-send with confirmQuote="${body.quote}" to apply.`,
      );
    }
    const row = await app.prisma.fxRate.create({
      data: {
        quote: body.quote, rate: body.rate, source: body.source,
        setByUserId: request.user.userId,
        effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
      },
    });
    return { success: true, data: { ...row, rate: Number(row.rate) } };
  });

  app.get('/billing/price-book', { preHandler: [platformControlGuard] }, async () => {
    const entries = await app.prisma.priceBookEntry.findMany({ orderBy: [{ role: 'asc' }, { tier: 'asc' }] });
    return { success: true, data: entries.map((e) => ({ ...e, amountUsd: Number(e.amountUsd) })) };
  });

  /** Set a plan price (append semantics: deactivate + create keeps history;
   *  the book is USD-only by law). */
  app.put('/billing/price-book', { preHandler: [platformControlGuard] }, async (request) => {
    const body = z.object({
      role: z.enum(['VENDOR', 'RIDER', 'DRIVER', 'SERVICE']),
      tier: z.string().trim().max(40).optional(),
      amountUsd: z.number().positive().max(10_000),
    }).parse(request.body ?? {});
    const updated = await app.prisma.$transaction(async (tx) => {
      await tx.priceBookEntry.updateMany({
        where: { role: body.role, tier: body.tier ?? null, active: true },
        data: { active: false },
      });
      return tx.priceBookEntry.create({
        data: { role: body.role, tier: body.tier ?? null, amountUsd: body.amountUsd },
      });
    });
    return { success: true, data: { ...updated, amountUsd: Number(updated.amountUsd) } };
  });

  /** Part 13 reporting — one truth, two columns: USD (management view) and
   *  local (books view), summed from the SAME pinned charge rows; plus the
   *  reconcile-mismatch flags that must never be silently absorbed. */
  app.get('/billing/usd-summary', { preHandler: [adminGuard] }, async (request) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(request.query ?? {});
    const since = new Date(Date.now() - days * 86_400_000);
    const charges = await tenantPrisma.billingEvent.findMany({
      where: { type: 'CHARGE_SUCCESS', createdAt: { gte: since } },
      select: { amount: true, amountUsd: true, fxRateId: true, createdAt: true, currencyCode: true },
    });
    const weekKey = (d: Date) => {
      const day = d.getUTCDay();
      const monday = new Date(d.getTime() - ((day === 0 ? 6 : day - 1) * 86_400_000));
      return monday.toISOString().slice(0, 10);
    };
    const weeks = new Map<string, { local: number; usd: number; pinned: number; legacy: number }>();
    for (const c of charges) {
      const k = weekKey(c.createdAt);
      const w = weeks.get(k) ?? { local: 0, usd: 0, pinned: 0, legacy: 0 };
      w.local += Number(c.amount ?? 0);
      if (c.amountUsd) {
        w.usd += Number(c.amountUsd);
        w.pinned += 1;
      } else {
        w.legacy += 1;
      }
      weeks.set(k, w);
    }
    const mismatches = await tenantPrisma.billingEvent.count({
      where: { type: 'REMINDER', idempotencyKey: { startsWith: 'mismatch:' }, createdAt: { gte: since } },
    });
    return {
      success: true,
      data: {
        windowDays: days,
        weeks: [...weeks.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([week, w]) => ({ week, localTotal: Math.round(w.local * 100) / 100, usdTotal: Math.round(w.usd * 100) / 100, pinnedCharges: w.pinned, legacyCharges: w.legacy })),
        reconcileMismatches: mismatches,
      },
    };
  });

  // ── Part 13 migration (founder picks a mode per tenant) ───────────────────

  /** MODE A preview — the mapping table for founder approval. Pure read. */
  app.get('/billing/usd-migration/preview', { preHandler: [adminGuard] }, async () => {
    const { previewModeA } = await import('../billing/usd-migration');
    return { success: true, data: await previewModeA(tenantPrisma) };
  });

  /** MODE A enact — send the deduped 30-day notices; the founder flips
   *  usdPricingEnabled once the window has run. */
  app.post('/billing/usd-migration/mode-a', { preHandler: [adminGuard] }, async () => {
    const { enactModeA } = await import('../billing/usd-migration');
    return { success: true, data: await enactModeA(tenantPrisma, app.io) };
  });

  /** MODE B enable — grandfather existing payers on today's local price via
   *  customRate; the daily sweep owns the T−30/T−7 notices + sunset flip. */
  app.post('/billing/usd-migration/mode-b', { preHandler: [adminGuard] }, async (request) => {
    const body = z.object({ sunsetAt: z.string().datetime() }).parse(request.body ?? {});
    const sunset = new Date(body.sunsetAt);
    if (sunset.getTime() < Date.now() + 30 * 86_400_000) {
      throw new AppError(400, 'SUNSET_TOO_SOON', 'The sunset must be at least 30 days out — the T−30 notice needs its window.');
    }
    const { enableModeB } = await import('../billing/usd-migration');
    return { success: true, data: await enableModeB(tenantPrisma, sunset) };
  });

  /** Pure preview (Part 12): the full plan table at a hypothetical rate —
   *  commit is only ever the POST above. */
  app.get('/billing/fx-preview', { preHandler: [platformControlGuard] }, async (request) => {
    const q = z.object({ quote: z.string().length(3).toUpperCase(), rate: z.coerce.number().positive() }).parse(request.query ?? {});
    const { convertUsdToLocal, formatMoney } = await import('../billing/fx');
    const tenant = await app.prisma.tenantBillingCurrency.findFirst({ where: { settlementCurrency: q.quote } });
    const inc = tenant ? Number(tenant.roundingIncrement) : 1;
    const previous = await app.prisma.fxRate.findFirst({ where: { quote: q.quote }, orderBy: { effectiveFrom: 'desc' } });
    const entries = await app.prisma.priceBookEntry.findMany({ where: { active: true }, orderBy: { role: 'asc' } });
    return {
      success: true,
      data: {
        quote: q.quote,
        rate: q.rate,
        previousRate: previous ? Number(previous.rate) : null,
        plans: entries.map((e) => {
          const next = convertUsdToLocal(Number(e.amountUsd), q.rate, inc);
          const current = previous ? convertUsdToLocal(Number(e.amountUsd), Number(previous.rate), inc).amountLocal : null;
          return {
            role: e.role, tier: e.tier, amountUsd: Number(e.amountUsd),
            currentLocal: current, nextLocal: next.amountLocal, minClamped: next.minClamped,
            display: formatMoney(next.amountLocal, q.quote),
          };
        }),
      },
    };
  });

  /** Part 7/10 KPIs — every number derived from the rows money and state
   *  moved on (the DB testifies). Reading it at t0 IS the baseline capture;
   *  re-read after each friction fix lands. */
  app.get('/integrity/kpis', { preHandler: [platformControlGuard] }, async (request) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(request.query ?? {});
    // [REPORT-021 F-021-17] signup_attempts retains 90d (retention registry):
    // a wider ask silently mixing full-window counters with 90d-truncated
    // inputs would falsify the KPI. Cap and SAY SO in the response.
    const effectiveDays = Math.min(days, 90);
    const { frictionKpis } = await import('../integrity/friction-metrics');
    const kpis = await frictionKpis(tenantPrisma, effectiveDays);
    return {
      success: true,
      data: {
        ...kpis,
        windowDays: effectiveDays,
        ...(days > effectiveDays
          ? { windowCapped: true, requestedDays: days, cappedBy: 'retention:signup_attempts(90d)' }
          : {}),
      },
    };
  });

  // ── Batching System 1 (shadow phase) — evidence read + config ─────────────

  /** Part 8 acceptance #1: the founder's ≥2-week would-batch evidence read.
   *  Pure aggregation over SHADOW_WOULD_BATCH rows; nothing here can turn
   *  batching on. */
  app.get('/batching/shadow-report', { preHandler: [adminGuard] }, async (request) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(request.query ?? {});
    const { shadowReport } = await import('../batching/shadow-scan');
    const settings = await app.prisma.batchingSettings.findUnique({ where: { tenantId: 'swift-default' } });
    return {
      success: true,
      data: {
        ...(await shadowReport(app.prisma, days)),
        shadowMode: settings?.shadowMode ?? true,
        liveEnabled: settings?.enabled ?? false,
      },
    };
  });

  /** Recent evaluations with their full rulesChecked rows — "why did/didn't
   *  this order batch" answered from the DB, per the explainability law. */
  app.get('/batching/evaluations', { preHandler: [adminGuard] }, async (request) => {
    const q = z.object({
      orderId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(request.query ?? {});
    const rows = await app.prisma.batchEvaluation.findMany({
      where: q.orderId ? { orderId: q.orderId } : {},
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    return { success: true, data: rows };
  });

  /** Config, not code — thresholds/matrix editable; the live `enabled` flag
   *  stays founder-explicit and refuses to flip without shadow evidence. */
  app.put('/batching/settings', { preHandler: [adminGuard] }, async (request) => {
    const body = z.object({
      shadowMode: z.boolean().optional(),
      enabled: z.boolean().optional(),
      maxOrdersPerRun: z.number().int().min(1).max(3).optional(),
      addonPickupDetourMaxS: z.number().int().min(60).max(900).optional(),
      dropoffCorridorM: z.number().int().min(200).max(5000).optional(),
      crossTrackMaxM: z.number().int().min(100).max(3000).optional(),
      detourBudgetS: z.number().int().min(120).max(1200).optional(),
      detourBudgetPct: z.number().int().min(5).max(50).optional(),
      hotFoodReadyToDoorMaxS: z.number().int().min(600).max(3600).optional(),
      pickupWaitMaxS: z.number().int().min(60).max(900).optional(),
      verticalMatrix: z.record(z.string(), z.boolean()).optional(),
      sizePoints: z.record(z.string(), z.number().int().min(1).max(10)).optional(),
      capacityPointsByVehicle: z.record(z.string(), z.number().int().min(1).max(20)).optional(),
      addonScanIntervalS: z.number().int().min(10).max(300).optional(),
    }).parse(request.body ?? {});
    if (body.enabled === true) {
      // Acceptance #1: live offers only after ≥14 days of shadow evidence.
      const oldest = await app.prisma.batchEvaluation.findFirst({
        where: { decision: 'SHADOW_WOULD_BATCH' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      if (!oldest || oldest.createdAt.getTime() > Date.now() - 14 * 86_400_000) {
        throw new AppError(400, 'SHADOW_EVIDENCE_REQUIRED', 'Live batching needs at least 14 days of shadow evidence — read /batching/shadow-report first.');
      }
    }
    const settings = await app.prisma.batchingSettings.upsert({
      where: { tenantId: 'swift-default' },
      create: { tenantId: 'swift-default', ...body },
      update: body,
    });
    return { success: true, data: settings };
  });

  app.get('/batching/settings', { preHandler: [adminGuard] }, async () => {
    const settings = await app.prisma.batchingSettings.findUnique({ where: { tenantId: 'swift-default' } });
    return { success: true, data: settings };
  });

  // ── Vehicle visual identity [rides spec 6B] ───────────────────────────────

  /** Backfill: classify every driver's bodyType/colorHex from the fleet
   *  mapping. Idempotent; UNKNOWNs form the classification queue below. */
  app.post('/rides/vehicle-identity-backfill', { preHandler: [adminGuard] }, async () => {
    const tenantId = requireTenantId();
    const { classifyBodyType, resolveColorHex } = await import('../rides/vehicle-identity');
    const out = { classified: 0, unknown: 0, tinted: 0 };
    for (;;) {
      const batch = await app.prisma.driver.findMany({
        where: { bodyType: null, user: { tenantId } },
        select: { id: true, vehicleMake: true, vehicleModel: true, vehicleColor: true },
        take: 500,
      });
      if (batch.length === 0) break;
      for (const driver of batch) {
        const bodyType = classifyBodyType(driver.vehicleMake, driver.vehicleModel);
        const colorHex = resolveColorHex(driver.vehicleColor);
        const claimed = await app.prisma.driver.updateMany({
          where: { id: driver.id, bodyType: null, user: { tenantId } },
          data: { bodyType, colorHex },
        });
        if (claimed.count === 0) continue;
        if (bodyType === 'UNKNOWN') out.unknown += 1;
        else out.classified += 1;
        if (colorHex) out.tinted += 1;
      }
    }
    return { success: true, data: out };
  });

  /** The classification queue: UNKNOWN vehicles, with the photos the reviewer
   *  is already looking at. */
  app.get('/rides/vehicle-identity-queue', { preHandler: [adminGuard] }, async () => {
    const tenantId = requireTenantId();
    const rows = await app.prisma.driver.findMany({
      where: { bodyType: 'UNKNOWN', user: { tenantId } },
      select: {
        id: true, vehicleMake: true, vehicleModel: true, vehicleColor: true,
        vehiclePhotoUrl: true, licensePlate: true,
        user: { select: { firstName: true, lastName: true } },
      },
      take: 200,
    });
    return { success: true, data: rows };
  });

  /** One-tap classification (6B.2): the reviewer names the shape; optional
   *  colorHex override for odd color words. */
  app.put('/rides/drivers/:id/vehicle-identity', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = requireTenantId();
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      bodyType: z.enum(['SEDAN', 'HATCHBACK', 'WAGON', 'SUV', 'PICKUP', 'MINIBUS', 'COMPACT', 'UNKNOWN']),
      colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    }).parse(request.body ?? {});
    const updated = await mutationOrNotFound('Driver', id, () => app.prisma.driver.update({
      where: { id, user: { tenantId } },
      data: { bodyType: body.bodyType, ...(body.colorHex ? { colorHex: body.colorHex } : {}) },
      select: { id: true, bodyType: true, colorHex: true },
    }));
    return { success: true, data: updated };
  });

  // ── Swift Account Numbers (SAN) — the cash-rail payment reference ─────────

  /** Backfill [san spec 2.4]: batched, resumable, ends with the integrity
   *  assertion (zero NULLs, platform-wide distinctness, 100% Luhn). Safe to
   *  re-run any time — assigned rows are skipped. */
  app.post('/billing/san-backfill', { preHandler: [adminGuard] }, async () => {
    const tenantId = requireTenantId();
    const tenantScope = subscriptionTenantScope(tenantId);
    const { ensureSan } = await import('../billing/san.service');
    let assigned = 0;
    for (;;) {
      const batch = await app.prisma.subscription.findMany({
        where: { san: null, ...tenantScope },
        select: { id: true },
        take: 500,
        orderBy: { createdAt: 'asc' },
      });
      if (batch.length === 0) break;
      for (const subscription of batch) {
        // ensureSan receives the relation-scoped client, so its internal
        // findUnique/updateMany winner loop cannot jump to another tenant.
        await ensureSan(tenantPrisma, subscription.id);
        assigned += 1;
      }
    }
    const rows = await app.prisma.subscription.findMany({
      where: { san: { not: null }, ...tenantScope },
      select: { san: true },
    });
    const { luhnValid } = await import('../billing/san');
    const sans = rows.map((row) => row.san!);
    const result = {
      assigned,
      total: sans.length,
      distinct: new Set(sans).size,
      luhnFailures: sans.filter((san) => !luhnValid(san)).length,
    };
    return { success: true, data: { ...result, healthy: result.luhnFailures === 0 && result.distinct === result.total } };
  });

  // ── Agent-cash ingestion [san spec 4.4/4.6] — manual channel + suspense ──

  /** Channel C — manual entry, THE DAY-1 CHANNEL: the founder keys receipts
   *  from the MMG merchant portal each evening and the whole machine
   *  (credit → conversion → reactivation) runs with zero MMG integration.
   *  Law 26.5: entry requires the logged portal-verification confirmation —
   *  never from a photo or screenshot alone. */
  app.post('/billing/agent-payments', { preHandler: [adminGuard] }, async (request) => {
    requireDefaultTenantBilling();
    const body = z.object({
      san: z.string().min(1).max(20),
      amount: z.number().positive(),
      paidAt: z.string().datetime(),
      receiptNumber: z.string().trim().min(3).max(64),
      agentRef: z.string().trim().max(200).optional(),
      payerMsisdn: z.string().trim().max(30).optional(),
      verifiedInPortal: z.literal(true, {
        errorMap: () => ({ message: 'Manual credits require verifying the receipt in the MMG portal/statement first (law 26.5).' }),
      }),
    }).parse(request.body ?? {});
    const { AgentCashService } = await import('../billing/agent-cash.service');
    const svc = new AgentCashService(tenantPrisma, billing);
    const result = await svc.ingest({
      externalId: `MANUAL:${body.receiptNumber}`,
      channel: 'MANUAL_ADMIN',
      sanRaw: body.san,
      amount: body.amount,
      currencyCode: 'GYD',
      paidAt: new Date(body.paidAt),
      agentRef: body.agentRef,
      payerMsisdn: body.payerMsisdn,
      raw: { enteredBy: request.user.userId, receiptNumber: body.receiptNumber, verifiedInPortal: true },
      recordedBy: request.user.userId,
    });
    return { success: true, data: result };
  });

  /** The live payments feed [spec PART 8]. */
  app.get('/billing/agent-payments', { preHandler: [adminGuard] }, async (request) => {
    const q = z.object({
      status: z.enum(['RECEIVED', 'MATCHED', 'UNMATCHED', 'RECONCILED', 'RESOLVED', 'REFUND_FLAGGED']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(request.query ?? {});
    const rows = await app.prisma.mmgAgentPayment.findMany({
      where: q.status ? { status: q.status } : {},
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    return { success: true, data: rows.map((r) => ({ ...r, amount: Number(r.amount) })) };
  });

  /** The suspense queue [4.6] with the Luhn diagnosis + SLA clock. Money in
   *  limbo = a paid-but-suspended actor — the worst outcome this system can
   *  produce; rows older than 24h page. */
  app.get('/billing/agent-payments/unmatched', { preHandler: [adminGuard] }, async () => {
    const { AgentCashService } = await import('../billing/agent-cash.service');
    const svc = new AgentCashService(tenantPrisma, billing);
    return { success: true, data: await svc.unmatchedQueue() };
  });

  /** Attach a suspensed payment to an account — credits via the NORMAL
   *  pipeline (conversion + reactivation included), original linked. */
  app.post('/billing/agent-payments/:id/attach', { preHandler: [adminGuard] }, async (request) => {
    requireDefaultTenantBilling();
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ subscriptionId: z.string().min(1) }).parse(request.body ?? {});
    // Resolve the requested destination inside the authenticated tenant before
    // looking at the payment's workflow state. Otherwise a local MATCHED row
    // returns NOT_UNMATCHED for a real foreign subscription id, turning this
    // endpoint into a cross-tenant existence/state oracle. The actual credit
    // remains one transaction inside AgentCashService after this authz gate.
    const destination = await tenantPrisma.subscription.findUnique({
      where: { id: body.subscriptionId },
      select: { id: true },
    });
    if (!destination) throw new NotFoundError('Subscription', body.subscriptionId);
    const { AgentCashService } = await import('../billing/agent-cash.service');
    const svc = new AgentCashService(tenantPrisma, billing);
    try {
      // AgentCashService owns the single transaction: payment-row claim,
      // immutable event, receipt, balanced ledger, wallet balance, and final
      // RESOLVED state. Keeping another route transaction open here would
      // reintroduce the nested-connection pool deadlock this boundary removes.
      const result = await svc.attach(id, body.subscriptionId, request.user.userId);
      return { success: true, data: result };
    } catch (e) {
      if ((e as Error).message === 'NOT_UNMATCHED') {
        throw new AppError(409, 'NOT_UNMATCHED', 'Only unmatched payments can be attached.');
      }
      throw e;
    }
  });

  /** Refund flag [S-9]: cash refunds happen OFFLINE at MMG/agent level — the
   *  system records the flag; money never auto-moves. */
  app.post('/billing/agent-payments/:id/refund-flag', { preHandler: [adminGuard] }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ note: z.string().trim().min(3).max(500) }).parse(request.body ?? {});
    const row = await tenantPrisma.mmgAgentPayment.findUnique({ where: { id } });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'No such payment');
    if (row.status !== 'UNMATCHED') throw new AppError(409, 'NOT_UNMATCHED', 'Only unmatched payments can be refund-flagged.');
    const updated = await tenantPrisma.mmgAgentPayment.update({
      where: { id },
      data: { status: 'REFUND_FLAGGED', note: body.note, resolvedBy: request.user.userId, resolvedAt: new Date() },
    });
    return { success: true, data: updated };
  });

  /** Leave with note (stays in the queue). */
  app.post('/billing/agent-payments/:id/note', { preHandler: [adminGuard] }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ note: z.string().trim().min(1).max(500) }).parse(request.body ?? {});
    const updated = await mutationOrNotFound('MmgAgentPayment', id, () => tenantPrisma.mmgAgentPayment.update({
      where: { id },
      data: { note: body.note },
    }));
    return { success: true, data: updated };
  });

  /** Channel B — settlement file upload [san spec 4.3]. Paste/upload the CSV;
   *  every row rides the normal pipeline; the recon report is returned and a
   *  trailer mismatch pages. Re-importing the same file is a proven no-op. */
  app.post('/billing/settlement-import', { preHandler: [adminGuard] }, async (request) => {
    requireDefaultTenantBilling();
    const body = z.object({ csv: z.string().min(10).max(5_000_000), source: z.string().trim().max(120).default('manual-upload') }).parse(request.body ?? {});
    const { AgentCashService } = await import('../billing/agent-cash.service');
    const { importSettlementCsv } = await import('../billing/settlement-import');
    const svc = new AgentCashService(tenantPrisma, billing);
    const report = await importSettlementCsv(tenantPrisma, svc, body.csv, { source: body.source });
    if (report.trailerMismatch) {
      const { notifyAdmins } = await import('../notification/notification.service');
      await notifyAdmins(app.prisma, notifications, {
        // Settlement ops act inside the caller's tenant [NOC-A F45].
        tenantId: getTenantId() ?? null,
        title: 'Settlement file trailer mismatch',
        body: `File "${body.source}": rows sum GY$${report.totalGyd.toLocaleString()} but the trailer claims GY$${(report.trailerTotalGyd ?? 0).toLocaleString()}. Reconcile with MMG before trusting this file.`,
        data: { kind: 'settlement_trailer_mismatch', source: body.source },
      });
    }
    return { success: true, data: report };
  });

  /** Ingestion-mode config [4.5] — drives which jobs run and the activation-
   *  speed copy on every screen (SO-7: never promise webhook speed in manual
   *  mode). Stored in PlatformConfig; read by mobile via /subscription. */
  app.get('/billing/agent-cash-config', { preHandler: [platformControlGuard] }, async () => {
    const row = await app.prisma.platformConfig.findUnique({ where: { key: 'billing.mmg_agent.ingestion_mode' } });
    const mode = (row?.value as string | null) ?? 'MANUAL';
    return { success: true, data: { ingestionMode: mode, webhookConfigured: Boolean(process.env['AGENT_CASH_WEBHOOK_SECRET']) } };
  });

  app.put('/billing/agent-cash-config', { preHandler: [platformControlGuard] }, async (request) => {
    const body = z.object({ ingestionMode: z.enum(['MANUAL', 'SETTLEMENT_DAILY', 'WEBHOOK']) }).parse(request.body ?? {});
    if (body.ingestionMode === 'WEBHOOK' && !process.env['AGENT_CASH_WEBHOOK_SECRET']) {
      throw new AppError(400, 'WEBHOOK_NOT_CONFIGURED', 'Set AGENT_CASH_WEBHOOK_SECRET (MMG onboarding) before promising webhook-speed activation.');
    }
    const row = await app.prisma.platformConfig.upsert({
      where: { key: 'billing.mmg_agent.ingestion_mode' },
      create: { key: 'billing.mmg_agent.ingestion_mode', value: body.ingestionMode },
      update: { value: body.ingestionMode },
    });
    return { success: true, data: { ingestionMode: row.value } };
  });

  // ── Collections workbench [san spec PART 21] — the founder's call list ────

  /** Tabs of who to call, with tap-to-call + WhatsApp links and the promise
   *  tracker. At pilot scale the founder's phone call at the right moment IS
   *  the highest-ROI collections tool; this makes those calls effortless. */
  app.get('/billing/collections', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = requireTenantId();
    const { tab } = z.object({ tab: z.enum(['due72', 'pastdue', 'suspended', 'churned']).default('due72') }).parse(request.query ?? {});
    const now = Date.now();
    const statusWhere =
      tab === 'due72'
        ? { status: 'ACTIVE' as const, feeWaived: false, nextBillingDate: { lte: new Date(now + 72 * 3_600_000) } }
        : tab === 'pastdue'
          ? { status: 'PAST_DUE' as const }
          : tab === 'suspended'
            ? { status: 'SUSPENDED' as const }
            : { status: 'CHURNED' as const };
    const where = { ...statusWhere, ...subscriptionTenantScope(tenantId) };
    const subs = await app.prisma.subscription.findMany({
      where,
      include: {
        vendor: { select: { name: true, city: true, owner: { select: { user: { select: { firstName: true, lastName: true, phone: true } } } } } },
        rider: { select: { user: { select: { firstName: true, lastName: true, phone: true } } } },
        driver: { select: { user: { select: { firstName: true, lastName: true, phone: true } } } },
      },
      orderBy: tab === 'due72' ? { nextBillingDate: 'asc' } : { updatedAt: 'asc' },
      take: 200,
    });
    const ids = subs.map((s) => s.id);
    const [balances, contacts, lastPayments] = await Promise.all([
      tenantPrisma.prepaidBalance.findMany({ where: { subscriptionId: { in: ids } } }),
      app.prisma.collectionContact.findMany({ where: { subscriptionId: { in: ids } }, orderBy: { createdAt: 'desc' } }),
      tenantPrisma.subscriptionPayment.findMany({
        where: { subscriptionId: { in: ids }, status: 'CAPTURED' },
        orderBy: { paidAt: 'desc' },
        distinct: ['subscriptionId'],
        select: { subscriptionId: true, paidAt: true, amount: true },
      }),
    ]);
    const balanceBy = new Map(balances.map((b) => [b.subscriptionId, Number(b.balance)]));
    const lastContactBy = new Map<string, (typeof contacts)[number]>();
    for (const c of contacts) if (!lastContactBy.has(c.subscriptionId)) lastContactBy.set(c.subscriptionId, c);
    const lastPayBy = new Map(lastPayments.map((p) => [p.subscriptionId, p]));

    const rows = subs.map((s) => {
      const person = s.vendor?.owner.user ?? s.rider?.user ?? s.driver?.user;
      const phone = person?.phone ?? '';
      const weekly = Number(s.customRate ?? s.weeklyRate);
      const due = Math.max(0, weekly - (balanceBy.get(s.id) ?? 0));
      const contact = lastContactBy.get(s.id);
      const promiseMissed = Boolean(
        contact && contact.outcome === 'PROMISED' && contact.promisedDate && contact.promisedDate.getTime() < now
        && (!lastPayBy.get(s.id) || lastPayBy.get(s.id)!.paidAt!.getTime() < contact.createdAt.getTime()),
      );
      return {
        subscriptionId: s.id,
        name: s.vendor?.name ?? `${person?.firstName ?? ''} ${person?.lastName ?? ''}`.trim(),
        city: s.vendor?.city ?? null,
        type: s.type,
        san: s.san,
        phone,
        waLink: phone ? `https://wa.me/${phone.replace(/\D/g, '')}` : null,
        amountDueGyd: due,
        status: s.status,
        nextBillingDate: s.nextBillingDate,
        suspendedAt: s.suspendedAt,
        daysInState: Math.floor((now - s.updatedAt.getTime()) / 86_400_000),
        lastPayment: lastPayBy.get(s.id) ?? null,
        lastContact: contact ?? null,
        promiseMissed,
      };
    });
    // Missed promises float to the top — the follow-up IS the system.
    rows.sort((a, b) => Number(b.promiseMissed) - Number(a.promiseMissed));
    return { success: true, data: rows };
  });

  /** Outcome logging [21.2]: reached / promised {date} / refused / wrong
   *  number. Promise-kept rate becomes a KPI. */
  app.post('/billing/collections/:subscriptionId/contact', { preHandler: [adminGuard] }, async (request) => {
    const tenantId = requireTenantId();
    const { subscriptionId } = z.object({ subscriptionId: z.string() }).parse(request.params);
    const body = z.object({
      outcome: z.enum(['REACHED', 'PROMISED', 'REFUSED', 'WRONG_NUMBER']),
      promisedDate: z.string().datetime().optional(),
      note: z.string().trim().max(500).optional(),
    }).parse(request.body ?? {});
    if (body.outcome === 'PROMISED' && !body.promisedDate) {
      throw new AppError(400, 'PROMISE_NEEDS_DATE', 'A promise without a date cannot be tracked.');
    }
    const subscription = await app.prisma.subscription.findFirst({
      where: { id: subscriptionId, ...subscriptionTenantScope(tenantId) },
      select: { id: true },
    });
    if (!subscription) throw new NotFoundError('Subscription', subscriptionId);
    const row = await app.prisma.collectionContact.create({
      data: {
        subscriptionId,
        outcome: body.outcome,
        promisedDate: body.promisedDate ? new Date(body.promisedDate) : null,
        note: body.note ?? null,
        byAdminId: request.user.userId,
      },
    });
    return { success: true, data: row };
  });

  /** Daily cash journal CSV [20.4] — the accountant's export. */
  app.get('/billing/cash-journal', { preHandler: [adminGuard] }, async (request, reply) => {
    const q = z.object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }).parse(request.query ?? {});
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
    const { cashJournalCsv } = await import('../billing/receipts');
    const csv = await cashJournalCsv(tenantPrisma, from, to);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="swift-cash-journal-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv"`);
    return reply.send(csv);
  });

  // ── Bank-truth reconciliation [PART 25] — inert until MMG answers Q10 ─────

  /** The recon read: gross collected → MMG fees → expected net → deposited,
   *  per period. Batches build weekly (job) once the cadence config is set. */
  app.get('/billing/settlement-batches', { preHandler: [adminGuard] }, async () => {
    const { buildExpectedBatches, reconConfig } = await import('../billing/bank-recon');
    const created = await buildExpectedBatches(tenantPrisma); // idempotent; inert without config
    const batches = await app.prisma.settlementBatch.findMany({ orderBy: { periodStart: 'desc' }, take: 60 });
    return {
      success: true,
      data: {
        configured: (await reconConfig(app.prisma)) !== null,
        newlyBuilt: created,
        batches: batches.map((b) => ({
          ...b,
          grossGyd: Number(b.grossGyd),
          providerFeeGyd: b.providerFeeGyd ? Number(b.providerFeeGyd) : null,
          expectedNetGyd: b.expectedNetGyd ? Number(b.expectedNetGyd) : null,
          depositedGyd: b.depositedGyd ? Number(b.depositedGyd) : null,
        })),
      },
    };
  });

  /** The founder confirms a bank deposit; beyond-tolerance deviation goes
   *  MISMATCH and pages. */
  app.post('/billing/settlement-batches/:id/confirm-deposit', { preHandler: [adminGuard] }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      depositedGyd: z.number().positive(),
      depositedAt: z.string().datetime(),
      bankRef: z.string().trim().max(120).optional(),
    }).parse(request.body ?? {});
    const { confirmDeposit } = await import('../billing/bank-recon');
    const result = await confirmDeposit(app.prisma, id, {
      depositedGyd: body.depositedGyd,
      depositedAt: new Date(body.depositedAt),
      bankRef: body.bankRef,
    });
    if (result.status === 'MISMATCH') {
      const { notifyAdmins } = await import('../notification/notification.service');
      await notifyAdmins(app.prisma, notifications, {
        // Settlement ops act inside the caller's tenant [NOC-A F45].
        tenantId: getTenantId() ?? null,
        title: 'Settlement deposit mismatch',
        body: `A bank deposit is off the expected net by GY$${result.deltaGyd.toLocaleString()}. Reconcile with MMG — drill into the batch in Command.`,
        data: { kind: 'settlement_deposit_mismatch', batchId: id, deltaGyd: result.deltaGyd },
      });
    }
    return { success: true, data: result };
  });

  /** The cash-rail KPI tile [PART 12/21.5] — is the rail actually working. */
  app.get('/billing/cash-kpis', { preHandler: [adminGuard] }, async (request) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(request.query ?? {});
    const since = new Date(Date.now() - days * 86_400_000);
    // CollectionContact has no Prisma relation (only a loose subscriptionId),
    // so derive its boundary from the caller's relation-scoped subscriptions.
    const subscriptionIds = (await tenantPrisma.subscription.findMany({ select: { id: true } })).map((s) => s.id);
    const [byChannel, unmatchedDepth, oldestUnmatched, contacts, payments, dueStates] = await Promise.all([
      app.prisma.mmgAgentPayment.groupBy({ by: ['channel'], where: { createdAt: { gte: since } }, _count: true, _sum: { amount: true } }),
      app.prisma.mmgAgentPayment.count({ where: { status: 'UNMATCHED' } }),
      app.prisma.mmgAgentPayment.findFirst({ where: { status: 'UNMATCHED' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      app.prisma.collectionContact.findMany({ where: { subscriptionId: { in: subscriptionIds }, createdAt: { gte: since } } }),
      tenantPrisma.subscriptionPayment.findMany({
        where: { subscriptionId: { in: subscriptionIds }, status: 'CAPTURED', paidAt: { gte: since } },
        select: { subscriptionId: true, paidAt: true, createdAt: true },
      }),
      tenantPrisma.subscription.groupBy({ by: ['status'], _count: true }),
    ]);
    const promised = contacts.filter((c) => c.outcome === 'PROMISED' && c.promisedDate);
    const promisesKept = promised.filter((c) =>
      payments.some((p) => p.subscriptionId === c.subscriptionId && p.paidAt && p.paidAt >= c.createdAt && p.paidAt.getTime() <= c.promisedDate!.getTime() + 86_400_000),
    ).length;
    const { firstPaymentFunnel } = await import('../billing/trial-fee-education');
    return {
      success: true,
      data: {
        windowDays: days,
        channelMix: byChannel.map((c) => ({ channel: c.channel, count: c._count, totalGyd: Number(c._sum.amount ?? 0) })),
        unmatched: { depth: unmatchedDepth, oldestHours: oldestUnmatched ? Math.round((Date.now() - oldestUnmatched.createdAt.getTime()) / 3_600_000) : 0 },
        collections: { contacts: contacts.length, promises: promised.length, promisesKept, promiseKeptRate: promised.length ? promisesKept / promised.length : null },
        subscriptionStates: dueStates.map((s) => ({ status: s.status, count: s._count })),
        // THE pilot metric [21.4]: did the education land — wallets loaded
        // before trial end mean conversion without interruption.
        firstPaymentFunnel: await firstPaymentFunnel(tenantPrisma, days),
      },
    };
  });

  /** Global SAN resolution (⌘K): who does this number belong to. Payment
   *  reference lookup only — the SAN is never an auth factor. */
  app.get('/billing/san/:san', { preHandler: [adminGuard] }, async (request) => {
    const { san } = z.object({ san: z.string().min(1).max(20) }).parse(request.params);
    const { resolveSan } = await import('../billing/san.service');
    // The scoped client makes a foreign tenant's otherwise-valid SAN look
    // exactly like an unknown SAN; this endpoint must not be an existence
    // oracle for another operator's payment references.
    const res = await resolveSan(tenantPrisma, san);
    if (!res.ok) return { success: true, data: { valid: false, code: res.code } };
    const sub = res.subscription;
    const [vendor, rider, driver] = await Promise.all([
      sub.vendorId ? app.prisma.vendor.findUnique({ where: { id: sub.vendorId }, select: { name: true, city: true } }) : null,
      sub.riderId ? tenantPrisma.rider.findUnique({ where: { id: sub.riderId }, select: { user: { select: { firstName: true, lastName: true, phone: true } } } }) : null,
      sub.driverId ? tenantPrisma.driver.findUnique({ where: { id: sub.driverId }, select: { user: { select: { firstName: true, lastName: true, phone: true } } } }) : null,
    ]);
    const holder = vendor
      ? { kind: 'VENDOR', name: vendor.name, city: vendor.city }
      : rider
        ? { kind: 'RIDER', name: `${rider.user.firstName} ${rider.user.lastName}`, phone: rider.user.phone }
        : driver
          ? { kind: 'DRIVER', name: `${driver.user.firstName} ${driver.user.lastName}`, phone: driver.user.phone }
          : { kind: 'UNKNOWN' };
    return {
      success: true,
      data: {
        valid: true,
        subscriptionId: sub.id,
        status: sub.status,
        type: sub.type,
        weeklyRate: Number(sub.weeklyRate),
        currentPeriodEnd: sub.currentPeriodEnd,
        holder,
      },
    };
  });

  /** Part 4 appeals queue — OPEN cases with the accused's identity attached,
   *  oldest first (the 24h clock). Part 10's overturn rate rides along: >5%
   *  is the false-positive alarm that pauses enforcement expansion. */
  app.get('/integrity/appeals', { preHandler: [platformControlGuard] }, async () => {
    const { appealOverturnRate } = await import('../integrity/enforcement');
    const open = await app.prisma.enforcementAction.findMany({
      where: { appeal: 'OPEN' },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const users = await app.prisma.user.findMany({
      where: { id: { in: open.map((a) => a.accountId) } },
      select: { id: true, phone: true, firstName: true, lastName: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    return {
      success: true,
      data: {
        appeals: open.map((a) => ({ ...a, user: userById.get(a.accountId) ?? null })),
        overturnRate: await appealOverturnRate(app.prisma),
      },
    };
  });

  /** Resolve an appeal. Overturn lifts the hold AND grants the cluster a
   *  FOUNDER_OVERRIDE exception, so the trial law honors the human next time. */
  app.post<{ Params: { id: string } }>('/integrity/appeals/:id/resolve', { preHandler: [platformControlGuard] }, async (request) => {
    const body = z.object({
      outcome: z.enum(['OVERTURNED', 'UPHELD']),
      note: z.string().trim().min(3).max(500),
    }).parse(request.body ?? {});
    const { resolveAppeal } = await import('../integrity/enforcement');
    const resolved = await resolveAppeal(app.prisma, request.params.id, request.user.userId, body.outcome, body.note);
    return { success: true, data: { id: resolved.id, appeal: resolved.appeal } };
  });

  /** §3.5 — the founder issues a deliberate, logged exception (multi-location
   *  vendor trial-per-location, household, override). The trial law honors
   *  live exceptions; appeals overturn through this same mechanism. */
  app.post('/integrity/exceptions', { preHandler: [platformControlGuard] }, async (request) => {
    const body = z.object({
      clusterId: z.string().min(1),
      scope: z.enum(['MULTI_LOCATION_VENDOR', 'HOUSEHOLD', 'FOUNDER_OVERRIDE']),
      note: z.string().trim().min(3).max(500),
      expiresAt: z.string().datetime().optional(),
    }).parse(request.body ?? {});
    const cluster = await app.prisma.identityCluster.findUnique({ where: { id: body.clusterId }, select: { id: true } });
    if (!cluster) throw new NotFoundError('IdentityCluster', body.clusterId);
    const grant = await app.prisma.exceptionGrant.create({
      data: {
        clusterId: body.clusterId, scope: body.scope, note: body.note,
        grantedBy: request.user.userId,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
    });
    return { success: true, data: grant };
  });

  /** Update text/destination/sort/active. Deactivation is the delete. */
  app.put('/ads/house/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      headline: z.string().trim().max(60).nullable().optional(),
      ctaLabel: z.string().trim().max(15).nullable().optional(),
      destinationType: z.enum(['NONE', 'URL', 'DEEPLINK']).optional(),
      destinationValue: z.string().trim().max(500).nullable().optional(),
      sort: z.number().int().min(0).max(999).optional(),
      active: z.boolean().optional(),
    }).parse(request.body ?? {});
    const existing = await app.prisma.houseAd.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('HouseAd', id);
    const row = await app.prisma.houseAd.update({ where: { id }, data: body });
    return { success: true, data: row };
  });

  app.get('/verification/queue', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status } = verificationQueueQuerySchema.parse(request.query);

    const where = { status };
    const [documents, total] = await Promise.all([
      tenantPrisma.verificationDocument.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, phone: true, countryCode: true } },
        },
        orderBy: { createdAt: 'asc' }, // oldest first — review in arrival order
        skip,
        take: limit,
      }),
      tenantPrisma.verificationDocument.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(documents, total, { page, limit, skip }) };
  });

  app.put('/verification/:id/approve', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = approveDocSchema.parse(request.body ?? {});

    const doc = await verification.approveDocument(id, request.user.userId, body.expiresAt, body.insurance);
    await audit(
      request.user.userId,
      'APPROVE_VERIFICATION_DOC',
      'VerificationDocument',
      id,
      { docType: doc.docType, ...(body.insurance ? { insurance: body.insurance } : {}) },
      request,
    );

    return { success: true, data: doc };
  });

  app.put('/verification/:id/reject', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = rejectDocSchema.parse(request.body);

    const doc = await verification.rejectDocument(id, request.user.userId, body.reason, body.reasonCode);
    await audit(request.user.userId, 'REJECT_VERIFICATION_DOC', 'VerificationDocument', id, { docType: doc.docType, reason: body.reason, reasonCode: body.reasonCode ?? null }, request);

    return { success: true, data: doc };
  });

  /**
   * Short-lived signed URL to view a verification document. Never a public link
   * (DPA §3.5); every issuance is audit-logged as the document access trail
   * (§3.6). Returns 410 once a document has been purged under retention.
   */
  app.get('/verification/:id/document-url', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const doc = await tenantPrisma.verificationDocument.findUnique({
      where: { id },
      select: { id: true, fileUrl: true, purgedAt: true, docType: true },
    });
    if (!doc) throw new NotFoundError('VerificationDocument', id);
    if (doc.purgedAt || !doc.fileUrl) {
      throw new AppError(410, 'DOCUMENT_PURGED', 'This document has been deleted under the retention policy');
    }

    const ttlSeconds = 300;

    // Envelope-encrypted documents (spec §5): the bucket object is ciphertext,
    // so a plain signed URL would render garbage. Mint the audited, expiring
    // decrypt-render path instead. Legacy plaintext objects keep signed URLs.
    const encrypted = await app.prisma.encryptedObject.findUnique({
      where: { fileKey: doc.fileUrl },
      select: { wrappedDek: true, shreddedAt: true },
    });
    if (encrypted) {
      if (!encrypted.wrappedDek || encrypted.shreddedAt) {
        throw new AppError(410, 'DOCUMENT_SHREDDED', 'This document was crypto-shredded and cannot be recovered');
      }
      const minted = mintRenderPath(id, ttlSeconds);
      await audit(request.user.userId, 'VIEW_VERIFICATION_DOC', 'VerificationDocument', id, { docType: doc.docType, ttlSeconds, encrypted: true }, request);
      return { success: true, data: { url: minted.path, expiresInSeconds: minted.expiresInSeconds } };
    }

    const url = await getStorageProvider().getSignedUrl(doc.fileUrl, ttlSeconds);
    await audit(request.user.userId, 'VIEW_VERIFICATION_DOC', 'VerificationDocument', id, { docType: doc.docType, ttlSeconds }, request);

    return { success: true, data: { url, expiresInSeconds: ttlSeconds } };
  });

  // ─── Retail returns ──────────────────────────────────────────

  app.get('/returns', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status } = returnsQuerySchema.parse(request.query);
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([
      tenantPrisma.returnRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      tenantPrisma.returnRequest.count({ where }),
    ]);
    return { success: true, ...paginatedResponse(items, total, { page, limit, skip }) };
  });

  app.put('/returns/:id/resolve', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = resolveReturnSchema.parse(request.body);
    const existing = await tenantPrisma.returnRequest.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('ReturnRequest', id);
    if (existing.status !== 'REQUESTED') {
      throw new AppError(400, 'ALREADY_RESOLVED', `This return is already ${existing.status.toLowerCase()}`);
    }
    const updated = await mutationOrNotFound('ReturnRequest', id, () => tenantPrisma.returnRequest.update({
      where: { id },
      data: { status: body.status, resolutionNote: body.note, reviewedBy: request.user.userId, reviewedAt: new Date() },
    }));
    await audit(request.user.userId, 'RESOLVE_RETURN', 'ReturnRequest', id, { status: body.status }, request);
    return { success: true, data: updated };
  });

  // ─── Cash Rules: guarantee claims + founder metrics ──────────

  app.get('/cash-rules/claims', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status } = claimsQueueQuerySchema.parse(request.query);

    const where = { status };
    const [claims, total] = await Promise.all([
      tenantPrisma.reimbursementClaim.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
      tenantPrisma.reimbursementClaim.count({ where }),
    ]);
    return { success: true, ...paginatedResponse(claims, total, { page, limit, skip }) };
  });

  app.put('/cash-rules/claims/:id/approve', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = reasonSchema.parse(request.body ?? {});
    const claim = await cashRules.approveClaim(id, request.user.userId, body.reason);
    await audit(request.user.userId, 'APPROVE_CLAIM', 'ReimbursementClaim', id, { amount: Number(claim.amount) }, request);
    return { success: true, data: claim };
  });

  app.put('/cash-rules/claims/:id/reject', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = rejectDocSchema.parse(request.body);
    const claim = await cashRules.rejectClaim(id, request.user.userId, body.reason);
    await audit(request.user.userId, 'REJECT_CLAIM', 'ReimbursementClaim', id, { reason: body.reason }, request);
    return { success: true, data: claim };
  });

  app.put('/cash-rules/claims/:id/paid', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    // [WR-004] Unlike the settlements digest, this records a REAL payout on a
    // manual rail — the reference is the evidence and is required.
    const body = z.object({ reference: z.string().trim().min(1) }).parse(request.body ?? {});
    const claim = await cashRules.markClaimPaid(id, request.user.userId, body.reference);
    await audit(request.user.userId, 'PAY_CLAIM', 'ReimbursementClaim', id, { reference: body.reference }, request);
    return { success: true, data: claim };
  });

  /** Founder cockpit numbers: failed-payment %, payouts/week, claims by rider. */
  app.get('/cash-rules/metrics', { preHandler: [adminGuard] }, async () => {
    const metrics = await cashRules.founderMetrics();
    return { success: true, data: metrics };
  });

  // ─── Audit Logs ────────────────────────────────────────────────────────

  app.get('/audit-logs', { preHandler: [adminGuard] }, async (request) => {
    requireTenantId();
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { action, entity, userId, dateFrom, dateTo } = auditLogsQuerySchema.parse(request.query);

    // AuditLog predates tenant ownership and has no relation. Its actor is the
    // only demonstrable boundary available in this schema: derive actor IDs
    // through the tenant-scoped User model and exclude null/system/foreign
    // rows. A foreign actor filter is an arbitrary foreign ID and therefore
    // resolves exactly like an unknown actor.
    let actorIds: string[];
    if (userId) {
      const actor = await app.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!actor) throw new NotFoundError('User', userId);
      actorIds = [actor.id];
    } else {
      actorIds = (await app.prisma.user.findMany({ select: { id: true } })).map((actor) => actor.id);
    }

    const where: any = {
      userId: { in: actorIds },
      ...(action && { action: { contains: action, mode: 'insensitive' } }),
      ...(entity && { entity: { contains: entity, mode: 'insensitive' } }),
      ...(dateFrom || dateTo
        ? {
            createdAt: {
              ...(dateFrom && { gte: dateFrom }),
              ...(dateTo && { lte: dateTo }),
            },
          }
        : {}),
    };

    const [logs, total] = await Promise.all([
      app.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.auditLog.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(logs, total, { page, limit, skip }) };
  });

  // ── Support tickets ──────────────────────────────────────────────────────
  const support = new SupportService(tenantPrisma, notifications);

  app.get('/support', { preHandler: [adminGuard] }, async (request) => {
    const { status, page } = z.object({
      status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional(),
      page: z.coerce.number().int().min(1).optional(),
    }).parse(request.query);
    const result = await support.listForAdmin({ status, page });
    return { success: true, data: result };
  });

  app.put('/support/:id/resolve', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).default('RESOLVED'),
      adminNote: z.string().trim().max(2000).optional(),
    }).parse(request.body ?? {});
    const updated = await mutationOrNotFound('SupportTicket', id, () => support.resolve(id, request.user.userId, body));
    return { success: true, data: updated };
  });

  // ── Ops agent (spec Part B) — approvals + audit ───────────────────────────
  // The agent proposes; humans decide here. Approval replays the SAME
  // deterministic executor — the model is nowhere in this path.
  const agentService = new AgentService(tenantPrisma, app.io, async (orderId) => {
    if (!app.queues?.dispatchQueue) throw new AppError(503, 'QUEUES_DOWN', 'Dispatch queue unavailable');
    await app.queues.dispatchQueue.add('dispatch-order', { orderId }, { removeOnComplete: 100, removeOnFail: 50 });
  });

  app.get('/agent/approvals', { preHandler: [adminGuard] }, async (request) => {
    const { status } = z.object({ status: z.nativeEnum(AgentActionStatus).default('PENDING') }).parse(request.query);
    const requests = await tenantPrisma.agentActionRequest.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return { success: true, data: requests };
  });

  app.post('/agent/approvals/:id/approve', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const decided = await agentService.decideRequest(id, request.user.userId, true);
    await audit(request.user.userId, 'APPROVE_AGENT_ACTION', 'AgentActionRequest', id, { action: decided.action, orderId: decided.orderId }, request);
    return { success: true, data: decided };
  });

  app.post('/agent/approvals/:id/reject', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const decided = await agentService.decideRequest(id, request.user.userId, false);
    await audit(request.user.userId, 'REJECT_AGENT_ACTION', 'AgentActionRequest', id, { action: decided.action, orderId: decided.orderId }, request);
    return { success: true, data: decided };
  });

  /** The agent's every move, append-only — what it saw, chose, and why. */
  app.get('/agent/audit', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const [events, total] = await Promise.all([
      tenantPrisma.agentAuditEvent.findMany({ orderBy: { at: 'desc' }, skip, take: limit }),
      tenantPrisma.agentAuditEvent.count(),
    ]);
    return { success: true, ...paginatedResponse(events, total, { page, limit, skip }) };
  });

  // =========================================================================
  // COMPLIANCE — the liability shield: audit runs, violations, re-reviews
  // =========================================================================
  const compliance = new ComplianceAuditService(tenantPrisma, notifications, verification);

  app.get('/compliance', { preHandler: [adminGuard] }, async () => {
    requireDefaultTenantCompliance();
    return { success: true, data: await compliance.overview() };
  });

  /** Run the invariant check right now (the daily job runs it anyway). */
  app.post('/compliance/run', { preHandler: [adminGuard] }, async (request) => {
    requireDefaultTenantCompliance();
    const run = await compliance.runAudit('MANUAL');
    await audit(request.user.userId, 'RUN_COMPLIANCE_AUDIT', 'ComplianceAuditRun', run.id, { moversChecked: run.moversChecked, violations: run.violations }, request);
    return { success: true, data: run };
  });

  app.post('/compliance/reviews/:id/decide', { preHandler: [adminGuard] }, async (request) => {
    requireDefaultTenantCompliance();
    const { id } = request.params as { id: string };
    const body = z.object({ pass: z.boolean(), note: z.string().max(500).optional() }).parse(request.body);
    const decided = await compliance.decideReview(id, request.user.userId, body.pass, body.note);
    await audit(request.user.userId, body.pass ? 'PASS_COMPLIANCE_REVIEW' : 'FAIL_COMPLIANCE_REVIEW', 'ComplianceReviewCase', id, { userId: decided.userId }, request);
    return { success: true, data: decided };
  });

  app.post('/compliance/violations/:id/resolve', { preHandler: [adminGuard] }, async (request) => {
    requireDefaultTenantCompliance();
    const { id } = request.params as { id: string };
    const resolved = await compliance.resolveViolation(id);
    await audit(request.user.userId, 'RESOLVE_COMPLIANCE_VIOLATION', 'ComplianceViolation', id, { userId: resolved.userId }, request);
    return { success: true, data: resolved };
  });

  // =========================================================================
  // DLQ — dead-lettered background jobs (mission-control spec §5.7). A failed
  // job that exhausted its retries is invisible until someone looks; this is
  // where someone looks. Requeue and discard are audited.
  // =========================================================================
  const requireQueues = () => {
    if (!app.queues) throw new AppError(503, 'QUEUES_OFFLINE', 'Background queues are not running on this server.');
    return app.queues as unknown as Record<string, import('bullmq').Queue>;
  };
  const dlqQueue = (name: string) => {
    const q = requireQueues()[`${name}Queue`];
    if (!q) throw new NotFoundError('Queue', name);
    return q;
  };
  // SWIFT-121: one entry per LIVE queue (createQueues). 'riderAssignment' was
  // removed (SWIFT-023) — dropped here; 'search' was missing, so search's failed
  // jobs were invisible in the DLQ — added.
  const DLQ_NAMES = ['order', 'subscription', 'settlement', 'notification', 'verification', 'dispatch', 'search'] as const;

  /** GET /alerts/health — ack rate + median time-to-ack per alert kind
   *  (alerts spec §A4): how silently-failing pushes get caught before churn.
   *  Thresholds surfaced: ack-rate <90% or median >20s deserve eyes. */
  app.get('/alerts/health', { preHandler: [adminGuard] }, async (request) => {
    const { hours } = z.object({ hours: z.coerce.number().min(1).max(168).default(24) }).parse(request.query);
    const since = new Date(Date.now() - hours * 3600_000);
    const rows = await tenantPrisma.alertDelivery.findMany({
      where: { sentAt: { gte: since } },
      select: { kind: true, sentAt: true, acknowledgedAt: true },
    });
    const kinds = new Map<string, { sent: number; acked: number; ackSeconds: number[] }>();
    for (const r of rows) {
      const k = kinds.get(r.kind) ?? { sent: 0, acked: 0, ackSeconds: [] };
      k.sent += 1;
      if (r.acknowledgedAt) {
        k.acked += 1;
        k.ackSeconds.push((r.acknowledgedAt.getTime() - r.sentAt.getTime()) / 1000);
      }
      kinds.set(r.kind, k);
    }
    const data = [...kinds.entries()].map(([kind, k]) => {
      const sorted = k.ackSeconds.sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
      const ackRate = k.sent ? k.acked / k.sent : null;
      return {
        kind,
        sent: k.sent,
        acked: k.acked,
        ackRate,
        medianTimeToAckSeconds: median === null ? null : Math.round(median),
        breaching: (ackRate !== null && ackRate < 0.9) || (median !== null && median > 20),
      };
    });
    return { success: true, data: { windowHours: hours, kinds: data } };
  });

  /** GET /dlq — failed jobs across every queue, newest first. */
  app.get('/dlq', { preHandler: [platformControlGuard] }, async () => {
    const queues = requireQueues();
    const out: Array<Record<string, unknown>> = [];
    for (const name of DLQ_NAMES) {
      const q = queues[`${name}Queue`];
      if (!q) continue;
      const failed = await q.getFailed(0, 49);
      for (const j of failed) {
        out.push({
          queue: name,
          id: j.id,
          name: j.name,
          failedReason: j.failedReason ?? null,
          attemptsMade: j.attemptsMade,
          // Payload preview only — enough to triage, never a full dump.
          data: JSON.stringify(j.data ?? {}).slice(0, 500),
          finishedOn: j.finishedOn ?? null,
        });
      }
    }
    out.sort((a, b) => Number(b['finishedOn'] ?? 0) - Number(a['finishedOn'] ?? 0));
    return { success: true, data: out.slice(0, 200) };
  });

  /**
   * Fetch a job and REFUSE unless it is still the dead letter the operator is
   * looking at [REPORT-037 R037-09].
   *
   * Neither route used to check the job's state. So Retry followed by Discard —
   * a stale page, a changed mind, or two operators on the same queue — deleted
   * a job that was, by then, WAITING TO RUN. On `process-settlements` or
   * `poll-mmg-billing` that is deleting money work, permanently, from a screen
   * whose whole purpose is to rescue it. The previous test asserted exactly
   * that sequence and passed.
   *
   * `expectedName` / `expectedFinishedOn` are the compare half of a
   * compare-and-act: BullMQ reuses numeric job ids after a queue is obliterated
   * and recreated, so an id alone does not identify a job across that boundary.
   * The admin page always sends both.
   */
  async function requireDeadLetter(
    queueName: string,
    id: string,
    expected: { name?: string; finishedOn?: string },
  ) {
    const job = await dlqQueue(queueName).getJob(id);
    if (!job) throw new NotFoundError('Job', id);
    const state = await job.getState();
    if (state !== 'failed') {
      throw new AppError(
        409,
        'JOB_NO_LONGER_FAILED',
        `That job is now "${state}", not failed — someone has already acted on it. Reload before deciding again.`,
      );
    }
    if (expected.name && expected.name !== job.name) {
      throw new AppError(409, 'JOB_IDENTITY_MISMATCH', `Job ${id} is now "${job.name}", not "${expected.name}". Reload.`);
    }
    if (expected.finishedOn && Number(expected.finishedOn) !== (job.finishedOn ?? 0)) {
      throw new AppError(409, 'JOB_IDENTITY_MISMATCH', `Job ${id} failed at a different time than the one you are looking at. Reload.`);
    }
    return job;
  }

  /**
   * Audit a privileged DLQ mutation BEFORE performing it [REPORT-037 R037-08].
   *
   * These routes used to mutate Redis and audit afterwards. If the audit insert
   * failed, the request returned 500 — and the automatic audit hook deliberately
   * skips responses >= 400 — so a completed privileged mutation could end up
   * with NO audit record at all, weakening WS-7.1 control 18.
   *
   * Writing the intent first fails closed: no audit, no mutation. If the
   * mutation then fails, a second row records that, so the log never claims
   * something happened that did not.
   */
  async function auditedDlqAction(
    request: any,
    action: string,
    queueName: string,
    id: string,
    changes: Record<string, unknown>,
    mutate: () => Promise<unknown>,
  ) {
    await audit(request.user.userId, action, 'Job', `${queueName}:${id}`, changes, request);
    try {
      await mutate();
    } catch (err) {
      await audit(
        request.user.userId,
        `${action}_FAILED`,
        'Job',
        `${queueName}:${id}`,
        { ...changes, error: err instanceof Error ? err.message : String(err) },
        request,
      ).catch(() => undefined);
      throw err;
    }
  }

  /** POST /dlq/:queue/:id/requeue — retry a dead job. */
  app.post('/dlq/:queue/:id/requeue', { preHandler: [platformControlGuard] }, async (request) => {
    const { queue, id } = request.params as { queue: string; id: string };
    const expected = (request.query ?? {}) as { expectedName?: string; expectedFinishedOn?: string };
    const job = await requireDeadLetter(queue, id, { name: expected.expectedName, finishedOn: expected.expectedFinishedOn });
    await auditedDlqAction(request, 'REQUEUE_DLQ_JOB', queue, id, { jobName: job.name }, () => job.retry());
    return { success: true, data: { queue, id, retried: true } };
  });

  /** DELETE /dlq/:queue/:id — discard a dead job for good. */
  app.delete('/dlq/:queue/:id', { preHandler: [platformControlGuard] }, async (request) => {
    const { queue, id } = request.params as { queue: string; id: string };
    const expected = (request.query ?? {}) as { expectedName?: string; expectedFinishedOn?: string };
    const job = await requireDeadLetter(queue, id, { name: expected.expectedName, finishedOn: expected.expectedFinishedOn });
    await auditedDlqAction(
      request,
      'DISCARD_DLQ_JOB',
      queue,
      id,
      { jobName: job.name, failedReason: job.failedReason ?? null },
      () => job.remove(),
    );
    return { success: true, data: { queue, id, discarded: true } };
  });

  // =========================================================================
  // CATEGORY DISCOVERY GOVERNANCE (#17 Part 7) — taxonomy CRUD, the request
  // queue (approve / map / reject; the reason reaches the vendor verbatim),
  // and the merge tool whose row counts must reconcile or nothing lands.
  // =========================================================================

  /** GET /discovery/categories — the whole taxonomy incl HIDDEN/MERGED. */
  app.get('/discovery/categories', { preHandler: [adminGuard] }, async () => {
    const categories = await app.prisma.discoveryCategory.findMany({
      orderBy: [{ vertical: 'asc' }, { sortWeight: 'asc' }],
    });
    return { success: true, data: categories };
  });

  /** PUT /discovery/categories/:id — rename/re-emoji/aliases/order/visibility. */
  app.put<{ Params: { id: string } }>('/discovery/categories/:id', { preHandler: [adminGuard] }, async (request) => {
    const body = z.object({
      name: z.string().trim().min(2).max(60).optional(),
      emoji: z.string().min(1).max(8).optional(),
      iconKey: z.string().max(60).nullable().optional(),
      aliases: z.array(z.string().trim().min(1).max(60)).max(60).optional(),
      sortWeight: z.number().int().min(0).max(10_000).optional(),
      status: z.enum(['ACTIVE', 'HIDDEN']).optional(),
    }).parse(request.body);
    const updated = await app.prisma.discoveryCategory.update({
      where: { id: request.params.id },
      data: {
        ...body,
        ...(body.aliases ? { aliases: body.aliases.map((a) => a.toLowerCase()) } : {}),
      },
    });
    await audit(request.user.userId, 'DISCOVERY_CATEGORY_UPDATE', 'DiscoveryCategory', updated.id, body, request);
    return { success: true, data: updated };
  });

  /** GET /discovery/requests?status= — the founder's queue. */
  app.get('/discovery/requests', { preHandler: [adminGuard] }, async (request) => {
    const { status } = z.object({ status: z.enum(['PENDING', 'APPROVED', 'MERGED', 'REJECTED']).default('PENDING') }).parse(request.query ?? {});
    const requests = await app.prisma.discoveryCategoryRequest.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
    });
    const vendors = await app.prisma.vendor.findMany({
      where: { id: { in: requests.map((r) => r.vendorId) } },
      select: { id: true, name: true },
    });
    const byId = new Map(vendors.map((v) => [v.id, v.name]));
    return { success: true, data: requests.map((r) => ({ ...r, vendorName: byId.get(r.vendorId) ?? null })) };
  });

  /** Notify the requesting vendor's owner about the disposal. */
  async function notifyRequestVendor(vendorId: string, title: string, body: string) {
    const vendor = await app.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { owner: { select: { userId: true } } },
    });
    if (!vendor) return;
    await notifications.send({
      userId: vendor.owner.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title,
      body,
      data: { kind: 'category_request_resolved' },
    }).catch(() => undefined);
  }

  /** POST /discovery/requests/:id/approve — a new ACTIVE category is born. */
  app.post<{ Params: { id: string } }>('/discovery/requests/:id/approve', { preHandler: [adminGuard] }, async (request) => {
    const body = z.object({
      name: z.string().trim().min(2).max(60).optional(),
      emoji: z.string().min(1).max(8),
      kind: z.enum(['CUISINE', 'DISH', 'DIETARY', 'AISLE', 'RETAIL']),
      vertical: z.enum(['FOOD', 'GROCERY', 'RETAIL']),
    }).parse(request.body);
    const result = await discoveryGovernance.approveRequest(request.params.id, { ...body, resolvedBy: request.user.userId });
    await audit(request.user.userId, 'DISCOVERY_REQUEST_APPROVE', 'DiscoveryCategoryRequest', request.params.id, { category: result.category.slug }, request);
    await notifyRequestVendor(result.request.vendorId, 'Category added', `"${result.category.name}" is now on Swift — tag your store and items with it.`);
    return { success: true, data: result.category };
  });

  /** POST /discovery/requests/:id/map — resolves to an existing category. */
  app.post<{ Params: { id: string } }>('/discovery/requests/:id/map', { preHandler: [adminGuard] }, async (request) => {
    const { targetSlug } = z.object({ targetSlug: z.string().min(1).max(80) }).parse(request.body);
    const result = await discoveryGovernance.mapRequest(request.params.id, targetSlug, request.user.userId);
    await audit(request.user.userId, 'DISCOVERY_REQUEST_MAP', 'DiscoveryCategoryRequest', request.params.id, { targetSlug }, request);
    await notifyRequestVendor(result.request.vendorId, 'Category mapped', `"${result.request.proposedName}" maps to ${result.target.name} — your store now shows there.`);
    return { success: true, data: { mappedTo: result.target.slug } };
  });

  /** POST /discovery/requests/:id/reject — reason required, read verbatim. */
  app.post<{ Params: { id: string } }>('/discovery/requests/:id/reject', { preHandler: [adminGuard] }, async (request) => {
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(request.body);
    const result = await discoveryGovernance.rejectRequest(request.params.id, reason, request.user.userId);
    await audit(request.user.userId, 'DISCOVERY_REQUEST_REJECT', 'DiscoveryCategoryRequest', request.params.id, { reason }, request);
    await notifyRequestVendor(result.request.vendorId, 'Category not added', reason);
    return { success: true, data: { rejected: true } };
  });

  /** POST /discovery/backfill — run the movement (queued; idempotent). */
  app.post('/discovery/backfill', { preHandler: [adminGuard] }, async (request) => {
    if (!app.dispatchQueue) throw new AppError(503, 'QUEUES_OFF', 'Background workers are not running');
    const tenantId = requireTenantId();
    await app.dispatchQueue.add('discovery-backfill', { tenantId }, { removeOnComplete: 5, removeOnFail: 5 });
    await audit(request.user.userId, 'DISCOVERY_BACKFILL_ENQUEUED', 'DiscoveryCategory', '-', { tenantId }, request);
    return { success: true, data: { queued: true } };
  });

  // =========================================================================
  // MOVEMENT R GOVERNANCE (#18 R7) — moderation queue, at-risk queue, the S5
  // exclusion tool. Machines never deactivate people: this surface informs
  // the FOUNDER's hand; the only writes are review-visibility and audited
  // exclusions, never operational status.
  // =========================================================================

  /** GET /ratings/moderation — held reviews + pending reports, one queue. */
  app.get('/ratings/moderation', { preHandler: [adminGuard] }, async () => {
    const held = await tenantPrisma.rating.findMany({
      where: { flagged: true, flagReason: 'PROFANITY_HOLD', state: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, orderId: true, vendorId: true, type: true, score: true, comment: true, tags: true, createdAt: true },
    });
    const reports = await app.prisma.ratingReport.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const reported = reports.length
      ? await tenantPrisma.rating.findMany({
          where: { id: { in: reports.map((r) => r.ratingId) } },
          select: { id: true, score: true, comment: true, tags: true, vendorId: true, state: true },
        })
      : [];
    const byId = new Map(reported.map((r) => [r.id, r]));
    return {
      success: true,
      data: {
        held,
        reports: reports.map((r) => ({ ...r, rating: byId.get(r.ratingId) ?? null })),
      },
    };
  });

  /** POST /ratings/:id/moderate — publish (clear hold) | remove | exclude. */
  app.post<{ Params: { id: string } }>('/ratings/:id/moderate', { preHandler: [adminGuard] }, async (request) => {
    const body = z.object({
      action: z.enum(['publish', 'remove', 'exclude']),
      reason: z.enum(['FRAUD', 'RETALIATION', 'OFF_PLATFORM_ISSUE', 'TEST_ACCOUNT', 'MODERATION', 'OTHER']).optional(),
      note: z.string().trim().max(300).optional(),
    }).refine((b) => b.action === 'publish' || b.reason != null, { message: 'reason required' }).parse(request.body);

    const rating = await tenantPrisma.rating.findUnique({ where: { id: request.params.id } });
    if (!rating) throw new NotFoundError('Rating', request.params.id);

    if (body.action === 'publish') {
      await mutationOrNotFound('Rating', rating.id, () => tenantPrisma.rating.update({
        where: { id: rating.id },
        data: { isPublic: true, flagged: false, flagReason: null },
      }));
    } else {
      const stateReason = body.action === 'remove' ? 'MODERATION' : `ADMIN_${body.reason}`;
      await mutationOrNotFound('Rating', rating.id, () => tenantPrisma.rating.update({
        where: { id: rating.id },
        data: {
          state: body.action === 'remove' ? 'REMOVED' : 'EXCLUDED',
          stateReason,
          isPublic: false,
        },
      }));
      await ratingStats.applyRating(rating); // re-level the touched subject
      if (body.action === 'remove') {
        await notifications.send({
          userId: rating.raterId,
          type: 'SYSTEM_ANNOUNCEMENT',
          title: 'A review of yours was removed',
          body: `A review you wrote was removed for: ${(body.reason ?? 'MODERATION').toLowerCase().replace(/_/g, ' ')}.`,
          data: { kind: 'rating_removed' },
        }).catch(() => undefined);
      }
    }
    await audit(request.user.userId, 'RATING_MODERATE', 'Rating', rating.id, body, request);
    return { success: true, data: { action: body.action } };
  });

  /** POST /rating-reports/:id/resolve — uphold (removes the review) | dismiss. */
  app.post<{ Params: { id: string } }>('/rating-reports/:id/resolve', { preHandler: [adminGuard] }, async (request) => {
    const { action } = z.object({ action: z.enum(['uphold', 'dismiss']) }).parse(request.body);
    const report = await app.prisma.ratingReport.findUnique({ where: { id: request.params.id } });
    if (!report) throw new NotFoundError('Report', request.params.id);
    if (report.status !== 'PENDING') throw new AppError(400, 'ALREADY_RESOLVED', `This report is ${report.status.toLowerCase()}`);

    await app.prisma.ratingReport.update({
      where: { id: report.id },
      data: { status: action === 'uphold' ? 'UPHELD' : 'DISMISSED', resolvedBy: request.user.userId, resolvedAt: new Date() },
    });
    if (action === 'uphold') {
      const rating = await tenantPrisma.rating.findUnique({ where: { id: report.ratingId } });
      if (rating && rating.state === 'ACTIVE') {
        await mutationOrNotFound('Rating', rating.id, () => tenantPrisma.rating.update({
          where: { id: rating.id },
          data: { state: 'REMOVED', stateReason: 'MODERATION', isPublic: false },
        }));
        await ratingStats.applyRating(rating);
        await notifications.send({
          userId: rating.raterId,
          type: 'SYSTEM_ANNOUNCEMENT',
          title: 'A review of yours was removed',
          body: `A review you wrote was removed for: ${report.reason.toLowerCase().replace(/_/g, ' ')}.`,
          data: { kind: 'rating_removed' },
        }).catch(() => undefined);
      }
    }
    await audit(request.user.userId, 'RATING_REPORT_RESOLVE', 'RatingReport', report.id, { action }, request);
    return { success: true, data: { action } };
  });

  /** GET /ratings/at-risk — the FOUNDER queue (R-Law 3): standing AT_RISK
   *  actors with their tag breakdown. One row per actor by construction
   *  (the stat row IS the queue item); no automated consequence exists. */
  app.get('/ratings/at-risk', { preHandler: [adminGuard] }, async () => {
    const atRisk = await app.prisma.actorRatingStat.findMany({
      where: { standing: 'AT_RISK' },
      orderBy: { recomputedAt: 'asc' },
    });
    return { success: true, data: atRisk };
  });

  /** POST /discovery/categories/:id/merge-into — CAT-J, counts reconcile. */
  app.post<{ Params: { id: string } }>('/discovery/categories/:id/merge-into', { preHandler: [adminGuard] }, async (request) => {
    const { targetId } = z.object({ targetId: z.string().min(1) }).parse(request.body);
    const result = await discoveryGovernance.mergeCategories(request.params.id, targetId);
    await audit(request.user.userId, 'DISCOVERY_CATEGORY_MERGE', 'DiscoveryCategory', request.params.id, { targetId, ...result.dedupes }, request);
    return { success: true, data: result };
  });
}
