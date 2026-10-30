import { Prisma, type PrismaClient, type UserRole, type VehicleType, type RideClass } from '@prisma/client';
import { nanoid } from 'nanoid';
import { AppError, ValidationError } from '../../utils/errors';
import { VEHICLE_CLASSES, VEHICLE_NOT_OFFERED, isVehicleOffered, moverRoleFor, type MoverRole } from '../../config/vehicle-classes';
import { riderLiveLegCount } from '../dispatch/concurrency-policy';
import { BUCKET_OF } from '../verification/doc-registry';
import { alignStoredVehicleKind, papersUnderSecondReview, requireFreshVehicleReview } from '../verification/vehicle-retirement';
import { vehicleIdentityChanged } from '../verification/vehicle-identity';
import { hopDocState } from '../verification/doc-state';
import { normalizeRegistrationMark, rootSubjectId } from '../verification/subjects';
import { assertHirePlate } from '../verification/hire-plate';
import { FloatService } from '../dispatch/float.service';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { publishLegalDocumentOnce, recordConsent, type ConsentSurface } from '../legal/consent.service';
import { LEGAL_VERSION, DRIVER_AGREEMENT, VENDOR_AGREEMENT } from '../legal/legal.routes';
import {
  assertSawQuote, signupQuote, WEEKLY_FEE_ACK_TEXT_V1, WEEKLY_FEE_ACK_TYPE, WEEKLY_FEE_ACK_VERSION, type WeeklyFeeAck,
} from './weekly-fee-ack';
import { assertStorePinInMarket } from '../vendor/store-pin';
import { ReviewDemoRoleRefusedError } from '../review/demo-policy';
import { lockVendorActivationBilling } from '../billing/billing-access';
import { hasActiveHold } from '../integrity/enforcement';
import { FOOD_HANDLERS_CONSENT_TYPE, FOOD_HANDLERS_TICK_V1, FOOD_HANDLERS_VERSION, foodHandlerTickApplies } from '../vendor/food-handlers';
import { publicPhoneForWrite } from '../../utils/vendor-public-phone';

// ---------------------------------------------------------------------------
// Partner provisioning (deterministic code — hard rule #1). `register` appends
// the role to User.roles[] but creates no operational entity; the rider/driver/
// vendor routes 404 until one exists. This module creates that entity self-serve
// at onboarding-submit, feeding the existing admin-approve → startTrial →
// go-online pipeline. Rider provisions minimally; Driver needs vehicle details;
// Vendor needs business details (all collected during onboarding).
// ---------------------------------------------------------------------------

export type Vehicle = { make: string; model: string; year: number; color: string; licensePlate: string };
export type VendorType = 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';
export type Business = {
  name: string;
  vendorType: VendorType;
  phone: string;
  addressLine1: string;
  city: string;
  region?: string;
  latitude: number;
  longitude: number;
};

export interface BecomePartnerInput {
  role: 'MOVER' | 'VENDOR';
  vehicleType?: VehicleType;
  vehicle?: Vehicle;
  business?: Business;
}

type Tx = Prisma.TransactionClient;

/** [VEHICLES] A mover's request to change the vehicle they work with. */
export interface VehicleChangeInput {
  vehicleType: VehicleType;
  /** Required for a passenger vehicle (a taxi Driver); optional for a delivery Rider. */
  vehicle?: Vehicle;
}

export interface VehicleChangeResult {
  kind: MoverRole;
  id: string;
  vehicleType: VehicleType;
  previousVehicleType: VehicleType;
  /** False for an idempotent retry that names the vehicle already saved: nothing moved. */
  changed: boolean;
  /** Approved vehicle documents retired because they are not about a vehicle the mover still has. */
  retiredDocuments: number;
  /** Vehicle documents withdrawn from review for the same reason. */
  withdrawnDocuments: number;
  /** The profile to reconcile after commit (offers, sessions), when supply was retired. */
  retiredRiderId: string | null;
  retiredDriverId: string | null;
}

/** Every VEHICLE-bucket document type: the papers that are about a vehicle, not a person. */
const VEHICLE_DOC_TYPES: readonly string[] = Object.entries(BUCKET_OF).filter(([, bucket]) => bucket === 'VEHICLE').map(([docType]) => docType);
/** Submissions still waiting on a human, which may lapse (X-EXPIRE-PENDING). */
const AWAITING_REVIEW = ['REVIEW_QUEUED', 'IN_REVIEW', 'INFO_REQUESTED'] as const;
/** A weekly plan that is still running (CANCELLED and CHURNED are terminal). */
const LIVE_PLAN = ['ACTIVE', 'TRIAL', 'PAST_DUE', 'PAUSED', 'SUSPENDED'] as const;
const sameText = (a?: string | null, b?: string | null) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
const samePlate = (a?: string | null, b?: string | null) => normalizeRegistrationMark(a ?? '') === normalizeRegistrationMark(b ?? '');
export type PartnerProvisionResult =
  | { kind: 'RIDER'; id: string; created: boolean; roles: UserRole[]; targetRole: 'RIDER' }
  | { kind: 'DRIVER'; id: string; created: boolean; roles: UserRole[]; targetRole: 'DRIVER' }
  | { kind: 'VENDOR'; id: string; created: boolean; roles: UserRole[]; targetRole: 'VENDOR_OWNER' };

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** [CHAINS] The most stores one owner account runs (VENDOR_BRANCH_LIMIT, default 50; nonsense falls back). */
export const DEFAULT_BRANCH_LIMIT = 50;
export function branchLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env['VENDOR_BRANCH_LIMIT']);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_BRANCH_LIMIT;
}

/**
 * [CHAINS · COORD ruling 29 Oct 2026] A branch rides the owner's standing, so an owner in trouble anywhere adds none.
 * Read under the add's locks (PartnerService.addBranch). In order, each with its own plain reason:
 *  - OWNER_ON_HOLD: an open enforcement hold on the owner's account (enforcement.ts hasActiveHold);
 *  - FEE_UNPAID: a store's weekly fee past due, or a store suspended or churned for it (pay first, the spirit of
 *    DEBT_REINSTATE_FIRST);
 *  - STORE_SUSPENDED / STORE_CLOSED: a store Swift suspended (any other reason) or closed;
 *  - STORE_ON_HOLD: a store whose MMG checkout Swift holds (a fraud-safety hold);
 *  - NO_ACTIVE_STORE / FIRST_STORE_NOT_APPROVED: no store is live now (documents approved once is not enough).
 */
type StandingStore = { name: string; status: string; isVerified: boolean; suspensionSource: string | null; mmgCheckoutHeldAt: Date | null; subscription: { status: string } | null };
export function assertOwnerInGoodStanding(stores: readonly StandingStore[], ownerOnHold: boolean): void {
  if (ownerOnHold) throw new AppError(403, 'OWNER_ON_HOLD', 'Your account is being checked by Swift. You can add branches once that check is finished.');
  const unpaid = stores.find((s) => ['PAST_DUE', 'SUSPENDED', 'CHURNED'].includes(s.subscription?.status ?? '') || (s.status === 'SUSPENDED' && s.suspensionSource === 'BILLING'));
  if (unpaid) throw new AppError(409, 'FEE_UNPAID', `Pay the weekly fee for ${unpaid.name} first. Then you can add a branch.`);
  const suspended = stores.find((s) => s.status === 'SUSPENDED');
  if (suspended) throw new AppError(403, 'STORE_SUSPENDED', `${suspended.name} is suspended. You can add branches once Swift reinstates it.`);
  const closed = stores.find((s) => s.status === 'CLOSED');
  if (closed) throw new AppError(403, 'STORE_CLOSED', `Swift closed ${closed.name}. Contact Swift before adding a branch.`);
  const held = stores.find((s) => s.mmgCheckoutHeldAt !== null);
  if (held) throw new AppError(403, 'STORE_ON_HOLD', `Swift is checking payments at ${held.name}. You can add branches once that check is finished.`);
  if (!stores.some((s) => s.status === 'ACTIVE')) {
    throw stores.some((s) => s.isVerified)
      ? new AppError(403, 'NO_ACTIVE_STORE', 'You can add branches while one of your stores is live on Swift.')
      : new AppError(403, 'FIRST_STORE_NOT_APPROVED', 'You can add branches once Swift has approved your first store.');
  }
}

/** [CHAINS] A branch is born a registered seller (the tier column's default, written out): the add-a-branch terms
 *  ask a restaurant branch for its food handlers tick by this tier (vendor/food-handlers.ts). */
export const BRANCH_TIER = 'REGISTERED' as const;

/** A new store of an owner, waiting for Swift's approval: sign-up's first store and every branch after it. */
async function createStore(tx: Tx, ownerId: string, business: Business, opts: { branch?: boolean; publicPhone?: string | null } = {}) {
  return tx.vendor.create({
    data: {
      ownerId,
      // [CHAINS · COORD ruling] A branch waits for a person at Swift to approve it before it can go live.
      ...(opts.branch ? { personApprovalRequired: true, tier: BRANCH_TIER } : {}),
      // [REVIEW-F #2220 S3-1] The number customers can call, published by the owner on the add-a-branch form.
      ...(opts.publicPhone ? { publicPhone: opts.publicPhone } : {}),
      name: business.name,
      slug: `${slugify(business.name) || 'store'}-${nanoid(6)}`,
      vendorType: business.vendorType,
      phone: business.phone,
      addressLine1: business.addressLine1,
      city: business.city,
      region: business.region ?? '',
      latitude: business.latitude,
      longitude: business.longitude,
      status: 'PENDING_APPROVAL',
    },
  });
}

export class PartnerService {
  constructor(
    private prisma: PrismaClient,
    private notifications?: NotificationService,
  ) {}

  async becomePartner(userId: string, input: BecomePartnerInput): Promise<PartnerProvisionResult> {
    this.validateInput(input);
    const result = await this.prisma.$transaction((tx) => this.provisionLocked(tx, userId, input));
    await this.afterCommit(result, input);
    return result;
  }

  /** Compose provisioning with the route's authority transition in the same
   * transaction. A rejected role switch therefore cannot leave a ghost profile
   * or role behind, and concurrent joins cannot lose roles or race idempotency. */
  async becomePartnerWithAuthority<TCleanup>(
    userId: string,
    input: BecomePartnerInput,
    transitionAuthority: (tx: Tx, targetRole: UserRole) => Promise<TCleanup>,
    consent?: { accepted: boolean; ip?: string | null; surface: ConsentSurface; weeklyFeeAck?: WeeklyFeeAck },
  ): Promise<{ result: PartnerProvisionResult; authorityCleanup: TCleanup }> {
    this.validateInput(input);
    // [DCR-1] Publish (hash-anchor) the role agreement BEFORE the transaction,
    // so the consent row always anchors to the exact served words — the same
    // law signup follows for the Terms and Privacy pack.
    const agreement = input.role === 'VENDOR'
      ? { documentType: 'vendor_agreement' as const, subjectType: 'vendor_user' as const, renderedText: VENDOR_AGREEMENT }
      : { documentType: 'driver_agreement' as const, subjectType: 'driver' as const, renderedText: DRIVER_AGREEMENT };
    if (consent?.accepted) {
      await publishLegalDocumentOnce(this.prisma, {
        documentType: agreement.documentType,
        version: LEGAL_VERSION,
        renderedText: agreement.renderedText,
      });
    }
    // [Row 628] The weekly-fee tick anchors to its own published words, the same way.
    const feeAck = consent?.weeklyFeeAck;
    if (feeAck) {
      await publishLegalDocumentOnce(this.prisma, { documentType: WEEKLY_FEE_ACK_TYPE, version: WEEKLY_FEE_ACK_VERSION, renderedText: WEEKLY_FEE_ACK_TEXT_V1 });
    }
    const feeSubject = input.role === 'VENDOR'
      ? { role: 'VENDOR' as const, vendorType: input.business!.vendorType }
      : { role: 'MOVER' as const, vehicleType: input.vehicleType! };
    const combined = await this.prisma.$transaction(async (tx) => {
      // [Row 628] The fee the partner saw is the quote now, or nothing is written (WEEKLY_FEE_CHANGED).
      const quote = feeAck ? await signupQuote(tx, userId, feeSubject) : null;
      if (feeAck && quote) assertSawQuote(feeAck, quote);
      const result = await this.provisionLocked(tx, userId, input);
      const authorityCleanup = await transitionAuthority(tx, result.targetRole);
      // [DCR-1 INV-NR1a] The agreement consent rides the SAME transaction that
      // creates the operating entity — a profile without its ledger row is the
      // un-fixable gap the consent gate exists to prevent. Old app builds that
      // don't send the checkbox simply record nothing; consent is never
      // fabricated on a client's behalf.
      if (consent?.accepted) {
        await recordConsent(tx, {
          subjectType: agreement.subjectType,
          subjectId: userId,
          documentType: agreement.documentType,
          version: LEGAL_VERSION,
          action: 'granted',
          surface: consent.surface,
          ip: consent.ip ?? null,
          evidence: { control: 'agreement_checkbox', path: 'partner/become', kind: result.kind },
        });
      }
      // [Row 628] "I understand the weekly fee", in the same transaction, with the amount the partner saw (= the
      // quote). Only when the client sent it: a phone build that never showed it records nothing.
      if (feeAck && quote) {
        await recordConsent(tx, {
          subjectType: agreement.subjectType,
          subjectId: userId,
          documentType: WEEKLY_FEE_ACK_TYPE,
          version: WEEKLY_FEE_ACK_VERSION,
          action: 'granted',
          surface: consent!.surface,
          ip: consent!.ip ?? null,
          evidence: {
            control: 'weekly_fee_checkbox', path: 'partner/become', kind: result.kind,
            ...(feeSubject.role === 'VENDOR' ? { vendorType: feeSubject.vendorType } : { vehicleType: feeSubject.vehicleType }),
            weeklyFee: { amount: quote.amount, currencyCode: quote.currencyCode, tier: quote.tier },
          },
        });
      }
      return { result, authorityCleanup };
    });
    await this.afterCommit(combined.result, input);
    return combined;
  }

  private validateInput(input: BecomePartnerInput): void {
    if (input.role === 'VENDOR') {
      if (!input.business) throw new ValidationError('Business details are required to sell on Swift');
      // [Q8] The pin is where riders and customers are sent: inside a launch market, or refused before anything is written.
      assertStorePinInMarket(input.business.latitude, input.business.longitude);
      return;
    }
    if (!input.vehicleType) throw new ValidationError('Vehicle type is required to move with Swift');
    // [Launch vehicle list] Buses, canters and box trucks are not taken on yet (config/vehicle-classes).
    if (!isVehicleOffered(input.vehicleType)) {
      throw new AppError(422, VEHICLE_NOT_OFFERED, 'Swift is not taking buses, canters or box trucks yet. Choose another vehicle.');
    }
    // Passenger-capable vehicles (car → Economy, wagon → Comfort, bus → Group)
    // provision a Driver at their tier so the vehicle earns on the higher-value
    // ride classes; cargo-only vehicles (bike, canter, box truck) are delivery
    // Riders. Maximises each vehicle's earning reach.
    const rideClass = VEHICLE_CLASSES[input.vehicleType]?.rideClass;
    if (rideClass && !input.vehicle) {
      throw new ValidationError('Vehicle details (make, model, year, colour, licence plate) are required to drive');
    }
    // [Owner ruling 11 Oct 2026] A taxi's plate is H-series, said where it is typed.
    if (input.vehicle) assertHirePlate(input.vehicleType, input.vehicle.licensePlate);
  }

  private async provisionLocked(tx: Tx, userId: string, input: BecomePartnerInput): Promise<PartnerProvisionResult> {
    const rows = await tx.$queryRaw<Array<{ id: string; roles: UserRole[]; tenantKind: string }>>`
      SELECT u."id", u."roles", t."kind"::text AS "tenantKind"
      FROM "users" u JOIN "tenants" t ON t."id" = u."tenantId"
      WHERE u."id" = ${userId}
      FOR UPDATE OF u
    `;
    const user = rows[0];
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    // [REVIEW-PARTNER] Every provisioning entry point passes this lock: a demo (REVIEW) account
    // never gains a rider, driver or store role — before any profile, store or consent row.
    if (user.tenantKind === 'REVIEW') throw new ReviewDemoRoleRefusedError();

    if (input.role === 'VENDOR') {
      return this.provisionVendor(tx, user.id, user.roles, input.business!);
    }
    const vehicleType = input.vehicleType!;
    const rideClass = VEHICLE_CLASSES[vehicleType]?.rideClass;
    return rideClass
      ? this.provisionDriver(tx, user.id, user.roles, input.vehicle, rideClass, vehicleType)
      : this.provisionRider(tx, user.id, user.roles, vehicleType);
  }

  /** Add the given roles if missing (idempotent). Active-role authority is
   * transitioned by the route through the shared locked protocol. */
  private async ensureRoles(tx: Tx, userId: string, current: UserRole[], add: UserRole[]): Promise<UserRole[]> {
    const missing = add.filter((r) => !current.includes(r));
    if (missing.length === 0) return current;
    const roles = [...current, ...missing];
    await tx.user.update({ where: { id: userId }, data: { roles } });
    return roles;
  }

  // Cargo-only vehicles (bike, motorbike, canters, box trucks) provision a
  // delivery/courier Rider. Passenger-capable vehicles (car, wagon, bus) take
  // the Driver path above, at their ride tier.
  private async provisionRider(tx: Tx, userId: string, roles: UserRole[], vehicleType: VehicleType): Promise<PartnerProvisionResult> {
    const existing = await tx.rider.findUnique({ where: { userId } });
    const rider = existing ?? (await tx.rider.create({ data: { userId, riderType: 'BOTH', vehicleType } }));
    // D.3 — seed the new rider's float limit from their trust level + country.
    if (!existing) await new FloatService(tx).recomputeForUser(userId);
    const updatedRoles = await this.ensureRoles(tx, userId, roles, ['MOVER', 'RIDER']);
    return { kind: 'RIDER' as const, id: rider.id, created: !existing, roles: updatedRoles, targetRole: 'RIDER' as const };
  }

  private async provisionDriver(tx: Tx, userId: string, roles: UserRole[], vehicle?: Vehicle, rideClass: RideClass = 'ECONOMY', vehicleType: VehicleType = 'CAR'): Promise<PartnerProvisionResult> {
    if (!vehicle) {
      throw new ValidationError('Vehicle details (make, model, year, colour, licence plate) are required to drive');
    }
    const existing = await tx.driver.findUnique({ where: { userId } });
    // [REPORT-014 F-014-01] The vehicle TAXONOMY is the authority for what a
    // vehicle physically is: seats come from it (never the schema default 4),
    // and the ride class is its class — a self-declared class can never
    // outrank the declared vehicle type.
    const taxonomy = VEHICLE_CLASSES[vehicleType];
    const driver =
      existing ??
      (await tx.driver.create({
        data: {
          userId,
          rideClass: taxonomy?.rideClass ?? rideClass,
          vehicleCapacity: taxonomy?.seats ?? 4,
          vehicleType,
          vehicleMake: vehicle.make,
          vehicleModel: vehicle.model,
          vehicleYear: vehicle.year,
          vehicleColor: vehicle.color,
          licensePlate: vehicle.licensePlate,
          // Filled during onboarding; documentsVerified (not URL presence) gates go-online.
          driverLicenseUrl: '',
          vehicleInsuranceUrl: '',
        },
      }));
    const updatedRoles = await this.ensureRoles(tx, userId, roles, ['MOVER', 'DRIVER']);
    return { kind: 'DRIVER' as const, id: driver.id, created: !existing, roles: updatedRoles, targetRole: 'DRIVER' as const };
  }

  private async provisionVendor(tx: Tx, userId: string, roles: UserRole[], business: Business): Promise<PartnerProvisionResult> {
    const owner = await tx.vendorOwner.upsert({ where: { userId }, create: { userId }, update: {} });

    // One store per owner at onboarding (idempotent).
    const existing = await tx.vendor.findFirst({ where: { ownerId: owner.id } });
    if (existing) {
      const updatedRoles = await this.ensureRoles(tx, userId, roles, ['VENDOR_OWNER']);
      return { kind: 'VENDOR' as const, id: existing.id, created: false, roles: updatedRoles, targetRole: 'VENDOR_OWNER' as const };
    }

    const vendor = await createStore(tx, owner.id, business);
    const updatedRoles = await this.ensureRoles(tx, userId, roles, ['VENDOR_OWNER']);

    return { kind: 'VENDOR' as const, id: vendor.id, created: true, roles: updatedRoles, targetRole: 'VENDOR_OWNER' as const };
  }

  /**
   * [CHAINS · owner 29 Oct 2026] Add a branch: one more store under the SAME owner, so one login runs the chain.
   * The route (POST /vendor/stores) has already checked that the caller owns a store, confirmed it is them (step-up),
   * the pin and the name. Here, in ONE transaction under the owner's account lock (so two adds at once can never pass
   * the limit together):
   *  - never for a demo (REVIEW) account, an account that is not ACTIVE, or an owner Swift has not approved a store
   *    for yet: a branch rides the owner's checked identity and papers, so there must be a check to ride on;
   *  - at most branchLimit() stores per owner;
   *  - the weekly fee shown for THIS branch is the fee quoted now (each branch pays its own fee: owner, 29 Oct), and
   *    the tick is recorded with the branch it is for;
   *  - the branch is born PENDING_APPROVAL, like any store: the one activation projection makes it live when its own
   *    checklist (published phone, food handlers tick, name basis) is met, and prices its fee then (a shared trial
   *    while the owner's trial runs, else billed from day one: SubscriptionService.createRow);
   *  - [REVIEW-F #2220 S3-1] what go-live needs from the owner comes with the add, in the same transaction: the
   *    number customers can call (`setup.publicPhone`, judged by the storefront's validator) and, for a restaurant,
   *    the food handlers tick (`consent.foodHandlers`), recorded exactly as the branch's own screen records it
   *    (POST /vendor/onboarding/food-handlers) — so the branch then waits for Swift, not for its owner.
   */
  async addBranch(
    userId: string,
    business: Business,
    consent: { weeklyFeeAck: WeeklyFeeAck; ip?: string | null; surface: ConsentSurface; foodHandlers?: boolean },
    env: Record<string, string | undefined> = process.env,
    setup: { publicPhone?: string | null } = {},
  ): Promise<{ id: string; name: string; status: string; ownerId: string }> {
    assertStorePinInMarket(business.latitude, business.longitude);
    const publicPhone = publicPhoneForWrite(setup.publicPhone);
    if (consent.foodHandlers && !foodHandlerTickApplies({ vendorType: business.vendorType, tier: BRANCH_TIER })) {
      throw new AppError(409, 'FOOD_HANDLERS_NOT_APPLICABLE', 'Only a restaurant confirms its food handlers.');
    }
    await publishLegalDocumentOnce(this.prisma, { documentType: WEEKLY_FEE_ACK_TYPE, version: WEEKLY_FEE_ACK_VERSION, renderedText: WEEKLY_FEE_ACK_TEXT_V1 });
    if (consent.foodHandlers) {
      await publishLegalDocumentOnce(this.prisma, { documentType: FOOD_HANDLERS_CONSENT_TYPE, version: FOOD_HANDLERS_VERSION, renderedText: FOOD_HANDLERS_TICK_V1 });
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: string; tenantKind: string }>>`
        SELECT u."id", u."status"::text AS "status", t."kind"::text AS "tenantKind"
        FROM "users" u JOIN "tenants" t ON t."id" = u."tenantId"
        WHERE u."id" = ${userId}
        FOR UPDATE OF u
      `;
      const user = rows[0];
      if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
      if (user.tenantKind === 'REVIEW') throw new ReviewDemoRoleRefusedError();
      if (user.status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'This account cannot add a branch right now.');
      // The owner's stores and their fees, locked in the settlement order (account row above, then every
      // subscription by id), then the stores themselves: a suspension, a hold or a missed fee committed first is
      // seen here, and one that comes second waits for this add to finish.
      await lockVendorActivationBilling(tx, userId);
      await tx.$queryRaw`SELECT v."id" FROM "vendors" v JOIN "vendor_owners" o ON o."id" = v."ownerId" WHERE o."userId" = ${userId} ORDER BY v."id" FOR SHARE OF v /* add-branch-owner-stores */`;
      const owner = await tx.vendorOwner.findUnique({
        where: { userId },
        select: {
          id: true,
          vendors: { select: { id: true, name: true, status: true, isVerified: true, suspensionSource: true, mmgCheckoutHeldAt: true, subscription: { select: { status: true } } } },
        },
      });
      if (!owner || owner.vendors.length === 0) throw new AppError(404, 'VENDOR_NOT_FOUND', 'Set up your first store before adding a branch.');
      assertOwnerInGoodStanding(owner.vendors, (await hasActiveHold(tx as unknown as PrismaClient, userId)).held);
      const limit = branchLimit(env);
      if (owner.vendors.length >= limit) {
        throw new AppError(409, 'BRANCH_LIMIT', `An account can run up to ${limit} stores. Contact Swift to add more.`, { limit });
      }
      // [Row 628] The fee the owner saw is the fee for this branch now, or nothing is written (WEEKLY_FEE_CHANGED).
      const quote = await signupQuote(tx, userId, { role: 'VENDOR', vendorType: business.vendorType });
      assertSawQuote(consent.weeklyFeeAck, quote);
      const vendor = await createStore(tx, owner.id, business, { branch: true, publicPhone });
      if (consent.foodHandlers) {
        // The branch's own tick, as POST /vendor/onboarding/food-handlers records it (the same ledger row shape).
        await recordConsent(tx, {
          subjectType: 'vendor_user', subjectId: userId, documentType: FOOD_HANDLERS_CONSENT_TYPE, version: FOOD_HANDLERS_VERSION,
          action: 'granted', surface: consent.surface, ip: consent.ip ?? null,
          evidence: { vendorId: vendor.id, storeName: vendor.name, control: 'checkbox', path: 'vendor/stores', attestedAt: new Date().toISOString() },
        });
      }
      await recordConsent(tx, {
        subjectType: 'vendor_user',
        subjectId: userId,
        documentType: WEEKLY_FEE_ACK_TYPE,
        version: WEEKLY_FEE_ACK_VERSION,
        action: 'granted',
        surface: consent.surface,
        ip: consent.ip ?? null,
        evidence: {
          control: 'weekly_fee_checkbox', path: 'vendor/stores', kind: 'VENDOR_BRANCH', vendorId: vendor.id, vendorType: business.vendorType,
          weeklyFee: { amount: quote.amount, currencyCode: quote.currencyCode, tier: quote.tier },
        },
      });
      await tx.auditLog.create({
        data: {
          userId, action: 'VENDOR_BRANCH_ADDED', entity: 'Vendor', entityId: vendor.id,
          changes: { ownerId: owner.id, storesBefore: owner.vendors.length, vendorType: business.vendorType },
        },
      });
      return { id: vendor.id, name: vendor.name, status: vendor.status as string, ownerId: owner.id, tenantId: vendor.tenantId };
    });
    if (this.notifications) {
      await notifyAdmins(this.prisma, this.notifications, {
        tenantId: created.tenantId,
        title: 'New branch awaiting approval',
        body: `${business.name} (${business.vendorType.toLowerCase()}) was added as a branch of an approved business and is waiting for its checklist.`,
        data: { kind: 'vendor_pending', vendorId: created.id },
      }).catch(() => {});
    }
    return { id: created.id, name: created.name, status: created.status, ownerId: created.ownerId };
  }

  /**
   * [VEHICLES · owner 2026-09-24: "after you save vehicle you cant switch it at all"]
   * Change the vehicle a mover works with. `/become` provisions once and then answers
   * the existing profile unchanged, so this is the one writer of a vehicle CHANGE.
   * Everything commits in ONE transaction, with the route's role-authority transition:
   *
   *  - Only an offered vehicle (the launch list), and only while no job is live.
   *  - A passenger vehicle (car, wagon, bus) is a taxi Driver, and any other vehicle is a
   *    delivery Rider: the same rule `/become` provisions by. Moving between the two
   *    provisions the other profile and moves the mover pointer to it. That is
   *    self-serve only before a weekly plan runs on the current profile.
   *  - The mover is taken offline on every profile, and the legacy `documentsVerified`
   *    grant is cleared, so GO re-checks evidence about the vehicle they now have.
   *  - VEHICLE DOCUMENTS FOLLOW VEHICLES. A vehicle document stays only while it is bound
   *    to the plate of a vehicle this account still carries (the new one, or the
   *    other profile's). Every other one, including every unbound (plate-less)
   *    document, is retired: approved ones become SUPERSEDED (§22), and ones still
   *    in review lapse (X-EXPIRE-PENDING) with their open cases closed. So a canter's
   *    insurance can never count for the motorbike that replaced it.
   *  - A plate change closes the account's open vehicle assignments (SAFE-A): a new
   *    plate starts from its own documents.
   */
  async changeVehicleWithAuthority<TCleanup>(
    userId: string,
    input: VehicleChangeInput,
    transitionAuthority: (tx: Tx, targetRole: UserRole) => Promise<TCleanup>,
  ): Promise<{ result: VehicleChangeResult; authorityCleanup: TCleanup | null }> {
    if (!isVehicleOffered(input.vehicleType)) {
      throw new AppError(422, VEHICLE_NOT_OFFERED, 'Swift is not taking buses, canters or box trucks yet. Choose another vehicle.');
    }
    const target = moverRoleFor(input.vehicleType);
    if (target === 'DRIVER' && !input.vehicle) {
      throw new ValidationError('Vehicle details (make, model, year, colour, licence plate) are required to drive');
    }
    // [Owner ruling 11 Oct 2026] A taxi's plate is H-series, said where it is typed.
    if (input.vehicle) assertHirePlate(input.vehicleType, input.vehicle.licensePlate);
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // The global lock order (mover-authority): User, then Rider, then Driver.
      const users = await tx.$queryRaw<Array<{ id: string; roles: UserRole[]; lastMoverRole: string | null; countryCode: string; tenantKind: string }>>`
        SELECT u."id", u."roles", u."lastMoverRole", u."countryCode", t."kind"::text AS "tenantKind"
        FROM "users" u JOIN "tenants" t ON t."id" = u."tenantId" WHERE u."id" = ${userId} FOR UPDATE OF u
      `;
      const user = users[0];
      if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
      // [REVIEW-PARTNER] A demo account's vehicle (and so its mover role) is the pack's, never swapped.
      if (user.tenantKind === 'REVIEW') throw new ReviewDemoRoleRefusedError();
      await tx.$queryRaw`SELECT "id" FROM "riders" WHERE "userId" = ${userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "drivers" WHERE "userId" = ${userId} FOR UPDATE`;
      const rider = await tx.rider.findUnique({ where: { userId } });
      const driver = await tx.driver.findUnique({ where: { userId } });
      if (!rider && !driver) {
        throw new AppError(404, 'MOVER_PROFILE_NOT_FOUND', 'There is no saved vehicle on this account to change. Save one first.');
      }
      if (rider && (rider.currentOrderId || (await riderLiveLegCount(tx, rider.id)) > 0)) {
        throw new AppError(409, 'ACTIVE_WORK', 'Finish your active delivery before changing your vehicle.');
      }
      if (driver?.currentRideId) {
        throw new AppError(409, 'ACTIVE_WORK', 'Finish your active ride before changing your vehicle.');
      }

      // The vehicle in use now: the profile the mover pointer names, else the one that exists.
      const current: MoverRole = user.lastMoverRole === 'DRIVER' && driver
        ? 'DRIVER'
        : user.lastMoverRole === 'RIDER' && rider ? 'RIDER' : rider ? 'RIDER' : 'DRIVER';
      const currentProfile = (current === 'DRIVER' ? driver : rider)!;
      const previousVehicleType = currentProfile.vehicleType;
      const next = input.vehicle;
      // The vehicle's details after the change. A rider naming the SAME vehicle without
      // details keeps the ones it has (the payload omitted them, it did not ask to clear
      // them — clearing would drop a plate and retire its papers). A different vehicle
      // starts from what was sent, or from nothing: a bicycle keeps no canter's plate.
      const keepDetails = target === 'RIDER' && current === 'RIDER' && input.vehicleType === previousVehicleType && !next;
      const details = keepDetails
        ? { make: currentProfile.vehicleMake, model: currentProfile.vehicleModel, year: currentProfile.vehicleYear, color: currentProfile.vehicleColor, licensePlate: currentProfile.licensePlate }
        : { make: next?.make ?? null, model: next?.model ?? null, year: next?.year ?? null, color: next?.color ?? null, licensePlate: next?.licensePlate ?? null };
      const unchanged = target === current
        && input.vehicleType === previousVehicleType
        && samePlate(details.licensePlate, currentProfile.licensePlate)
        && sameText(details.make, currentProfile.vehicleMake)
        && sameText(details.model, currentProfile.vehicleModel)
        && (details.year ?? null) === (currentProfile.vehicleYear ?? null)
        && sameText(details.color, currentProfile.vehicleColor);
      if (unchanged) {
        return {
          result: { kind: current, id: currentProfile.id, vehicleType: previousVehicleType, previousVehicleType, changed: false, retiredDocuments: 0, withdrawnDocuments: 0, retiredRiderId: null, retiredDriverId: null },
          authorityCleanup: null,
        };
      }
      if (target !== current) {
        const plan = await tx.subscription.findFirst({
          where: { ...(current === 'RIDER' ? { riderId: currentProfile.id } : { driverId: currentProfile.id }), status: { in: [...LIVE_PLAN] } },
          select: { id: true },
        });
        if (plan) {
          throw new AppError(409, 'PLAN_ON_CURRENT_ROLE', current === 'RIDER'
            ? 'Your weekly plan is for delivery work. Contact support to move it to taxi work.'
            : 'Your weekly plan is for taxi work. Contact support to move it to delivery work.');
        }
      }

      // The target profile carries the new vehicle; it is created when this is the first
      // vehicle of its kind (the one provisioning implementation), then written.
      const retire = { isOnline: false, isAvailable: false, locationSessionId: null };
      let targetId: string;
      if (target === 'DRIVER') {
        const taxonomy = VEHICLE_CLASSES[input.vehicleType];
        const created = await this.provisionDriver(tx, userId, user.roles, next, taxonomy.rideClass ?? 'ECONOMY', input.vehicleType);
        targetId = created.id;
        await tx.driver.update({
          where: { id: created.id },
          data: {
            vehicleType: input.vehicleType,
            // The taxonomy is the authority for what a vehicle is: its ride class and seats
            // follow the vehicle, never a tier set for the previous one.
            rideClass: taxonomy.rideClass ?? 'ECONOMY',
            vehicleCapacity: taxonomy.seats,
            vehicleMake: next!.make, vehicleModel: next!.model, vehicleYear: next!.year, vehicleColor: next!.color,
            licensePlate: next!.licensePlate,
            ...retire, documentsVerified: false, documentsVerifiedAt: null, documentsVerifiedBy: null,
          },
        });
      } else {
        const created = await this.provisionRider(tx, userId, user.roles, input.vehicleType);
        targetId = created.id;
        await tx.rider.update({
          where: { id: created.id },
          data: {
            vehicleType: input.vehicleType,
            // The details describe THIS vehicle or nothing: a bicycle keeps no plate of the canter it replaced.
            vehicleMake: details.make, vehicleModel: details.model, vehicleYear: details.year,
            vehicleColor: details.color, licensePlate: details.licensePlate,
            ...retire, documentsVerified: false, documentsVerifiedAt: null, documentsVerifiedBy: null,
          },
        });
      }
      // The other profile, if any, goes offline too and loses the legacy grant: its GO now
      // re-checks the evidence it still has (which follows its own plate).
      // [Opus 12 Oct · H-plate follow-up] The same plate moved to the other kind of work (a motorbike
      // re-declared as a car, or back): the retired profile no longer carries it, so the vehicle the mover
      // really uses — not one they no longer drive — decides how that plate's papers are judged.
      const movedPlate = (retiredPlate: string | null) => normalizeRegistrationMark(retiredPlate ?? '') !== ''
        && samePlate(retiredPlate, details.licensePlate);
      if (target === 'DRIVER' && rider) {
        await tx.rider.update({ where: { id: rider.id }, data: {
          ...retire, documentsVerified: false, documentsVerifiedAt: null, documentsVerifiedBy: null,
          ...(movedPlate(rider.licensePlate) ? { licensePlate: null } : {}),
        } });
      }
      if (target === 'RIDER' && driver) {
        await tx.driver.update({ where: { id: driver.id }, data: {
          ...retire, documentsVerified: false, documentsVerifiedAt: null, documentsVerifiedBy: null,
          // A Driver row always has a plate column; empty means "no vehicle on file" (it cannot go online as a taxi).
          ...(movedPlate(driver.licensePlate) ? { licensePlate: '' } : {}),
        } });
      }

      // The vehicle on this plate is now this class (motorbike re-declared as a car, or back).
      if (input.vehicleType !== previousVehicleType || target !== current) {
        await alignStoredVehicleKind(tx, userId, user.countryCode, details.licensePlate, input.vehicleType);
      }

      // A plate change (or a move to the other kind of work) closes the open vehicle
      // assignments: the new plate starts from its own documents (SAFE-A).
      const newPlate = details.licensePlate;
      if (target !== current || !samePlate(newPlate, currentProfile.licensePlate)) {
        await tx.subjectLink.updateMany({
          where: { accountId: userId, relation: 'ASSIGNED_DRIVER', validTo: null, subject: { kind: 'VEHICLE' } },
          data: { validTo: now },
        });
      }

      // VEHICLE DOCUMENTS FOLLOW VEHICLES: keep only documents bound to a plate this
      // account still carries after the change.
      const keptPlates = [newPlate, target === 'DRIVER' ? rider?.licensePlate : driver?.licensePlate]
        .map((plate) => normalizeRegistrationMark(plate ?? ''))
        .filter((plate) => plate.length > 0);
      const keptSubjects = new Set<string>();
      for (const registrationMark of keptPlates) {
        const vehicle = await tx.vehicleProfile.findUnique({
          where: { registrationMark_countryCode: { registrationMark, countryCode: user.countryCode } },
          select: { subjectId: true },
        });
        if (vehicle) keptSubjects.add(await rootSubjectId(tx, vehicle.subjectId));
      }
      const papers = await tx.verificationDocument.findMany({
        // Every row has a state: the state-machine migration (20260906090000) backfilled
        // all rows BEFORE its trigger existed, the INSERT trigger derives a state for any
        // new row, and an UPDATE can never null it. (A NULL-state row would also be frozen:
        // the trigger refuses every NULL→X transition.)
        where: { userId, role: 'MOVER', docType: { in: [...VEHICLE_DOC_TYPES] }, state: { in: ['COMMITTED', ...AWAITING_REVIEW] } },
        select: { id: true, state: true, subjectId: true, legalHoldId: true },
      });
      const toRetire: Array<{ id: string; committed: boolean }> = [];
      for (const paper of papers) {
        // A paper under a legal hold is frozen: its state and its case belong to the hold.
        if (paper.legalHoldId) continue;
        if (paper.subjectId && keptSubjects.has(await rootSubjectId(tx, paper.subjectId))) continue;
        toRetire.push({ id: paper.id, committed: paper.state === 'COMMITTED' });
      }
      // Lock order: a review case BEFORE its document — the order the reviewer paths take
      // (claim / release / escalate lock the case, then hop the document) — so a change
      // racing a reviewer's claim waits for it instead of deadlocking.
      const awaitingIds = toRetire.filter((p) => !p.committed).map((p) => p.id);
      if (awaitingIds.length > 0) {
        await tx.$queryRaw`SELECT "id" FROM "review_case" WHERE "submissionId" = ANY(${awaitingIds}) ORDER BY "id" FOR UPDATE`;
        // Then the papers themselves (the escalation's order): a paper with no open case still serializes with an
        // escalation, so the second-review read below sees one that committed first [DS1064 S3].
        await tx.$queryRaw`SELECT "id" FROM "verification_documents" WHERE "id" = ANY(${awaitingIds}) ORDER BY "id" FOR UPDATE`;
      }
      // [DOC-1 §24.2] A paper under a second review is frozen too: its confirmation opens the fraud case.
      const underSecondReview = await papersUnderSecondReview(tx, awaitingIds);
      const superseded: string[] = [];
      const withdrawn: string[] = [];
      for (const paper of toRetire) {
        if (underSecondReview.has(paper.id)) continue;
        if (paper.committed) {
          if (await hopDocState(tx, { id: paper.id, userId }, 'COMMITTED', 'SUPERSEDED', { reviewNote: 'SUPERSEDED: the mover changed vehicle' })) superseded.push(paper.id);
        } else if (await hopDocState(tx, { id: paper.id, userId }, [...AWAITING_REVIEW], 'EXPIRED', { status: 'EXPIRED', reviewNote: 'WITHDRAWN: the mover changed vehicle' })) {
          withdrawn.push(paper.id);
        }
      }
      if (superseded.length > 0) {
        // No renewal reminders for a document about a vehicle the mover no longer has.
        await tx.renewalSchedule.updateMany({ where: { documentId: { in: superseded }, suspendedAt: null }, data: { suspendedAt: now } });
      }
      if (withdrawn.length > 0) {
        await tx.reviewCase.updateMany({ where: { submissionId: { in: withdrawn }, closedAt: null }, data: { closedAt: now } });
      }

      // [L06 · #1551] A changed make, model, year, colour or plate is a vehicle the reviewers have not
      // seen: its papers need a fresh review, the same rule as the profile writers. Re-declaring the SAME
      // car as another type (a car as a wagon car, same details and plate) keeps its papers, as before.
      const identityChanged = vehicleIdentityChanged(
        { vehicleMake: currentProfile.vehicleMake, vehicleModel: currentProfile.vehicleModel, vehicleYear: currentProfile.vehicleYear, vehicleColor: currentProfile.vehicleColor, licensePlate: currentProfile.licensePlate },
        { vehicleMake: details.make, vehicleModel: details.model, vehicleYear: details.year, vehicleColor: details.color, licensePlate: details.licensePlate },
      );
      if (identityChanged) {
        const nextProfile = target === 'DRIVER' ? await tx.driver.findUniqueOrThrow({ where: { id: targetId } }) : await tx.rider.findUniqueOrThrow({ where: { id: targetId } });
        const freshReview = await requireFreshVehicleReview(tx, userId, currentProfile.licensePlate, { ...nextProfile, kind: target });
        superseded.push(...freshReview.superseded);
        withdrawn.push(...freshReview.withdrawn);
      }

      // The change is on the record: what the mover drove before and after, and which
      // papers it retired, so a reviewer can read a vehicle's history.
      await tx.auditLog.create({
        data: {
          userId,
          action: 'MOVER_VEHICLE_CHANGED',
          entity: target === 'DRIVER' ? 'Driver' : 'Rider',
          entityId: targetId,
          changes: {
            from: { kind: current, vehicleType: previousVehicleType },
            to: { kind: target, vehicleType: input.vehicleType },
            plateChanged: !samePlate(newPlate, currentProfile.licensePlate),
            retiredDocuments: superseded,
            withdrawnDocuments: withdrawn,
          },
        },
      });

      const authorityCleanup = await transitionAuthority(tx, target);
      return {
        result: {
          kind: target,
          id: targetId,
          vehicleType: input.vehicleType,
          previousVehicleType,
          changed: true,
          retiredDocuments: superseded.length,
          withdrawnDocuments: withdrawn.length,
          retiredRiderId: rider?.id ?? (target === 'RIDER' ? targetId : null),
          retiredDriverId: driver?.id ?? (target === 'DRIVER' ? targetId : null),
        },
        authorityCleanup,
      };
    });
  }

  private async afterCommit(result: PartnerProvisionResult, input: BecomePartnerInput): Promise<void> {
    if (result.kind !== 'VENDOR' || !result.created || !this.notifications || !input.business) return;
    // External notification work happens only after the DB transaction commits;
    // a rolled-back or losing concurrent provisioning attempt emits nothing.
    await notifyAdmins(this.prisma, this.notifications, {
      // Follows the vendor just provisioned [NOC-A F45]: afterCommit sees the
      // provisioning RESULT, and result.id is the vendor that carries the tenant.
      tenantId: (await this.prisma.vendor.findUnique({ where: { id: result.id }, select: { tenantId: true } }).catch(() => null))?.tenantId ?? null,
      title: 'New business awaiting approval',
      body: `${input.business.name} (${input.business.vendorType.toLowerCase()}) just signed up and is waiting for review.`,
      data: { kind: 'vendor_pending', vendorId: result.id },
    });
  }
}
