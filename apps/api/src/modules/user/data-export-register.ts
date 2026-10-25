/**
 * [Row 331 · DSAR-ERASURE (b) · GUARDRAILS §2] What GET /customer/account/export
 * gives a person, and what it leaves out and why.
 *
 * Every table that points at a person (their user id, or their rider, driver or
 * service-provider profile) is named here: exported, or withheld with a reason.
 * Every column of an exported table is either in its `fields` allow-list or left
 * out by a named rule. A new table or column that is not classified turns
 * account-export-register.test.ts red, so the export can never quietly fall
 * behind the data, and nothing new leaks into it unreviewed.
 */
import { TYPES_FOR_ROLE } from '../rating/rating-stats.service';

/** Why a column of an exported table is left out. */
export type OmitReason =
  | 'SECRET' // codes, tokens, keys, hashes: they protect the account, they are not information about the person
  | 'STORED_FILE' // a pointer to a stored photo or document image (kept encrypted; a copy is asked for through Support)
  | 'FRAUD_SAFETY' // fraud-prevention and safety signals
  | 'OTHER_PERSON' // another person's details, or the staff member who acted
  | 'INTERNAL_NOTE' // a private note staff wrote while handling a case
  | 'RATING_TOTAL' // a running rating total that moves with each single rating (ratings are given in groups of 5 instead)
  | 'SYSTEM'; // bookkeeping with no information about the person (versions, leases, tenant ids)

/** Name rules, in order; the first match decides. A `by` column is always exported (it is the person). */
export const OMIT_RULES: ReadonlyArray<readonly [OmitReason, RegExp]> = [
  // Any token column (session, refresh, push, payment, tracking) is a secret, by its name.
  ['SECRET', /^token$|Token$/],
  ['SECRET', /^(passwordHash|tokenDigest|tokenPrefix|ridePin|pickupCode|transferCode|clientKey|idempotencyKey|clientIdempotencyKey|requestKey|requestHash|stateHash|dedupeKey|noticeDedupeKey|payloadHash|documentContentHash|contentHash|contentSha256|sha256|ipHmac|valueHash|payerHash|bindingDigest|digest|oldDigest|newDigest|sealHash|stepUpSessionId|stepUpBinding|lockedUntil|failedLoginAttempts|deviceId|ridePinAttempts|pickupCodeAttempts|completionEvidence)$/],
  ['STORED_FILE', /^(avatar|fileUrl|fileKey|objectKey|selfieUrl|idDocumentUrl|mediaUrl|photoUrl|photos|portfolioPhotos|posterUrl|nationalIdUrl|driverLicenseUrl|vehicleInsuranceUrl|vehicleInspectionUrl|profilePhotoUrl|vehiclePhotoUrl|courierPackagePhotoUrl|courierProofPhotoUrl|courierProofIssuedUrl|courierReturnProofPhotoUrl|courierPickupProofIssuedUrl|courierPickupProofPhotoUrl)$/],
  ['FRAUD_SAFETY', /^(riskFlagged|riskReason|riskScore|riskFactors|flags|flagged|flagReason|offPlatformFlag|safetyShadowRestrictedAt|signals|signalsFired|patternFlaggedAt|enhancedSafetyMonitoring|deviationState|mmgClaimMismatchAt|doorCashMismatchAt|lossProtectionSuspendedReason|stateReason)$/],
  ['OTHER_PERSON', /^(riderId|driverId|providerId|rateeId|raterId|recipientIds|counterpartyUserId|courierProofIssuedRiderId|courierPickupProofIssuedRiderId|holderRiderId|relayRiderId|assignedTo|candidatesTried|invitedBy|mergedIntoId|ownerId|vendorId|customerId)$|By$|ById$|ByUserId$/],
  ['SYSTEM', /^(tenantId|syntheticRunId|isSynthetic|riderAssignmentVersion|driverAssignmentVersion|fulfillmentModeVersion|mmgClaimRevision|mmgClaimResolvedRevision|revision|version|epoch|generation|attempts|maxAttempts|checkAttempts|noticeAttempts|leaseExpiresAt|leasedUntil|availableAt|claimedAt|lastError|noticeLastError|nextCheckAt|nextRetryAt|locationSessionId|actorSessionId|offerAttemptId|correlationId|hostedUrl|providerSessionRef|schemaVersion|purgeGeneration|configVersion|legalHoldId|kycRef|chatRoomId|subjectType|submissionId|deliveryReceipts)$/],
  // The mover's live job pointers are a dispatch routing key, and the account's dormant wallet column must
  // never be read (no-customer-funds-ingress.test.ts). Written as patterns so the source censuses that
  // guard those names (mover-pointer-census, no-customer-funds-ingress) correctly see no reader here.
  ['SYSTEM', /^current(Order|Ride)Id$|^wallet[A-Z]/],
  // Live rating totals move with each single rating, so two files a day apart would give one rating back.
  ['RATING_TOTAL', /^(averageRating|totalRatings)$/],
];

/**
 * The file's own words for each column rule; the notice is built from the rules the register uses,
 * so it says exactly what the code leaves out (account-export-register.test.ts checks both ways).
 */
export const OMIT_REASON_TEXT: Readonly<Record<OmitReason, string>> = {
  SECRET: 'codes, keys and device identifiers that protect your account',
  STORED_FILE: 'stored photos and document images, which are kept encrypted (contact Support to ask for a copy)',
  FRAUD_SAFETY: 'some records kept to prevent fraud and to keep people safe',
  OTHER_PERSON: 'details of other people (contacts you entered yourself, such as emergency contacts, are included)',
  INTERNAL_NOTE: 'private notes staff wrote while handling a case',
  RATING_TOTAL: 'running rating totals, which change with each single rating (your ratings are given in groups of 5 instead)',
  SYSTEM: 'system bookkeeping that says nothing more about you',
};

/** Kinds of whole records that are not in the file. */
export type WithheldReason = 'FRAUD_SAFETY' | 'OTHER_PEOPLE' | 'STAFF_WORK' | 'LEGAL_HOLD' | 'SYSTEM';

/** The person's own words for each; the `withheld` list of the file is built from these. */
export const WITHHELD_REASON_TEXT: Readonly<Record<WithheldReason, string>> = {
  FRAUD_SAFETY: 'Some records kept to prevent fraud and to keep people safe are not included.',
  OTHER_PEOPLE: 'Records other people made about an order of yours, such as the delivery proof a mover filed, are not included.',
  STAFF_WORK: 'Records of work you did as Swift staff or for a business, and logs of staff access to accounts, are not included.',
  LEGAL_HOLD: 'Records of a legal hold on your documents are not included.',
  SYSTEM: 'System bookkeeping that says nothing more about you is not included.',
};

/** Reasons whose record list is never shown: naming the checks would teach an abuser which ones exist. */
export const UNLISTED_REASONS: ReadonlySet<WithheldReason> = new Set(['FRAUD_SAFETY']);

/** Which profile ids a `via` entry reads by (a person with no such profile has none). */
export type ExportVia = 'rider' | 'driver' | 'provider' | 'mover';

export interface ExportEntry {
  /** The key of this category in the file. */
  readonly category: string;
  /** Prisma model name. */
  readonly model: string;
  /** Columns that equal the person's id (or their profile id, with `via`); a row matches on any. */
  readonly by: readonly string[];
  /**
   * For a child table with no person column of its own: the relation to its parent, whose `by` columns are the
   * person's (a taxi ride's stops are the passenger's through the ride). The parent is itself exported to the
   * person by those columns (account-export-register.test.ts holds both).
   */
  readonly through?: string;
  readonly via?: ExportVia;
  /** A unique, sortable column for paging. */
  readonly key: string;
  /** The exported columns (always including `by`). */
  readonly fields: readonly string[];
  /** Columns left out for a reason the name rules do not give. */
  readonly omit?: Readonly<Record<string, OmitReason>>;
  /** The reason for every other column (work records: the rest of the record is the customer's). */
  readonly rest?: OmitReason;
  /** A fixed extra filter, ANDed with the person match (never from the caller). */
  readonly where?: Readonly<Record<string, unknown>>;
  /** Timestamps given as the month only (YYYY-MM), so a single event cannot be matched to a person. */
  readonly month?: readonly string[];
  /** Only rows whose column is before the person's last daily rating fold (the boundary the app honours). */
  readonly foldedBefore?: string;
  /** The file's row order (after `month`): never creation order, which would pair the k-th row with the k-th trip. */
  readonly sortBy?: readonly string[];
  /**
   * The rows are never given one by one: the category is the person's ratings received, cut into whole
   * groups of 5 by the ONE partition the app shows too (modules/rating/rating-groups.ts), per role.
   */
  readonly groups?: true;
}

/**
 * Only a STORE's reviews are listed one by one with their words and tags: the store's reviews page already
 * shows each one. Every other rating a person received (as a customer, rider, driver or provider), whose app
 * shows no single rating, is given only in whole groups of 5 (COORD rulings 17 Oct 23:38Z and 18 Oct, option S).
 */
export const STORE_RATING_TYPES: readonly string[] = [...TYPES_FOR_ROLE.VENDOR];

/** The person's own account row. */
export const ACCOUNT_FIELDS = [
  'id', 'phone', 'email', 'emailChangedAt', 'firstName', 'lastName', 'selfieCapturedAt', 'roles', 'activeRole', 'lastMoverRole',
  'status', 'isPhoneVerified', 'isEmailVerified', 'acceptedTermsAt', 'tosVersion', 'trustLevel', 'lossProtectionSuspendedAt',
  'countryCode', 'notificationPrefs', 'lastKnownLat', 'lastKnownLng',
  'createdAt', 'updatedAt', 'lastActiveAt', 'inactivityNoticeAt',
] as const;

export const EXPORT_REGISTER: readonly ExportEntry[] = [
  {
    category: 'activityLog', model: 'AuditLog', by: ['userId'], key: 'id', omit: { entityId: 'OTHER_PERSON', changes: 'OTHER_PERSON' },
    fields: ['id', 'userId', 'action', 'entity', 'ipAddress', 'userAgent', 'createdAt'],
  },
  {
    category: 'addresses', model: 'Address', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'label', 'addressLine1', 'addressLine2', 'city', 'region', 'country', 'latitude', 'longitude', 'instructions', 'isDefault', 'createdAt', 'updatedAt'],
  },
  {
    category: 'orders', model: 'Order', by: ['customerId'], key: 'id', omit: { mmgPayUrlSnapshot: 'OTHER_PERSON', mmgRecipientNameSnapshot: 'OTHER_PERSON', mmgNumberSnapshot: 'OTHER_PERSON' },
    fields: ['id', 'orderNumber', 'orderType', 'customerId', 'status', 'pickupAddress', 'pickupLat', 'pickupLng', 'deliveryAddress', 'deliveryLat', 'deliveryLng', 'deliveryInstructions', 'courierPackageDescription', 'courierPackageSize', 'courierPackageWeight', 'courierRecipientName', 'courierRecipientPhone', 'courierSpeed', 'courierPayer', 'courierReturnReason', 'courierReturnRequestedAt', 'courierReturnedAt', 'courierPickupProofLat', 'courierPickupProofLng', 'taxiPickupAddress', 'taxiDropoffAddress', 'taxiPassengerCount', 'taxiDistance', 'taxiDuration', 'taxiStopCount', 'billableKm', 'billableKmSource', 'routeMatchedKm', 'routePolyline', 'routeMatchSource', 'routeMatchedAt', 'subtotalBase', 'subtotalMarkup', 'subtotalCustomer', 'deliveryFee', 'serviceFee', 'taxAmount', 'tipAmount', 'discount', 'totalAmount', 'currencyCode', 'taxiFareBase', 'taxiFarePerKm', 'taxiFarePerMin', 'taxiFareTotal', 'taxiFareSurge', 'rideClass', 'paymentMethod', 'paymentStatus', 'paymentId', 'mmgAttestedRef', 'mmgAttestedAt', 'mmgAttestedAmount', 'customerClaimedPaidAt', 'customerPaymentRef', 'customerMmgClaim', 'customerMmgClaimAt', 'mmgClaimResolution', 'mmgClaimResolvedAt', 'estimatedPrepTime', 'estimatedDeliveryTime', 'promisedAt', 'promiseBaseSeconds', 'promisePadSeconds', 'promiseRevisedAt', 'promiseRevisionReason', 'promiseRevisions', 'actualDeliveryTime', 'isExpress', 'scheduledFor', 'holdExpiresAt', 'releasedToVendorAt', 'foodAgeHeldAt', 'foodAgeWaivedAt', 'placedAt', 'acceptedAt', 'driverArrivedAt', 'preparingAt', 'readyAt', 'pickedUpAt', 'deliveredAt', 'cancelledAt', 'cancellationReason', 'lateCancelFeeDue', 'refundOwedAmount', 'refundOwedAt', 'refundRef', 'refundPaidAmount', 'refundSettledAt', 'doorCashCollectedAmount', 'doorCashShortfallAmount', 'doorCashReturnAmount', 'doorCashReturnStatus', 'doorCashReturnRecordedAt', 'doorCashReturnResolvedAt', 'promoCodeId', 'channel', 'attributionQrCodeId', 'ridePinVerified', 'ridePinVerifiedAt', 'fulfillment', 'fulfillmentMode', 'appointmentSlot', 'createdAt', 'updatedAt'],
  },
  {
    // [REVIEW-M S3-1 · multi-stop] The places a passenger's taxi ride stopped at, each with its ride (orderId = the
    // ride's id in "orders"), in the passenger's order: what the passenger's own ride screen shows
    // (taxi-stops-read.ts). Never the row id, who moved the stop, or the driver's arrival evidence (the driver's
    // own position). A driver's trip record carries no customer place, so it carries no stops either.
    // arrivalVerified (yes/no: the server's fix supported the arrival) IS exported: it decides whether a billable
    // wait started at the passenger's stop, i.e. their own charge; the raw evidence behind it stays out.
    category: 'taxiStops', model: 'TaxiTripStop', through: 'order', by: ['customerId'], key: 'id', sortBy: ['orderId', 'sequence'],
    omit: { id: 'SYSTEM', evidenceNote: 'OTHER_PERSON' },
    fields: ['orderId', 'sequence', 'address', 'lat', 'lng', 'status', 'legMeters', 'legSeconds', 'arrivedAt', 'arrivalVerified', 'departedAt', 'skippedAt', 'skipReason', 'createdAt', 'updatedAt'],
  },
  {
    // A store review that names you: score, tags, words and the month, as the store's reviews page lists it.
    // (Store reviews carry the store, not a person, so this is usually empty.) Never who gave it or for which
    // order; only once the double-blind window has shown it and the daily fold has counted it.
    category: 'ratingsReceived', model: 'Rating', by: ['rateeId'], key: 'id', rest: 'OTHER_PERSON',
    where: { visibleAt: { not: null }, state: 'ACTIVE', type: { in: STORE_RATING_TYPES } }, foldedBefore: 'createdAt', month: ['createdAt'],
    sortBy: ['createdAt', 'score', 'comment', 'tags'],
    fields: ['rateeId', 'score', 'comment', 'tags', 'createdAt'],
  },
  {
    // Every other rating about you (as a customer, rider, driver or provider): only in whole groups of 5, in the
    // order given, each with its months and average: the ONE cut your app shows (rating-groups.ts). No words,
    // tags, rater role, order or single score; the newest appear once a group of 5 is complete and final.
    category: 'ratingsReceivedInGroups', model: 'Rating', by: ['rateeId'], key: 'id', rest: 'OTHER_PERSON',
    where: { state: 'ACTIVE', type: { notIn: STORE_RATING_TYPES } }, groups: true,
    fields: ['rateeId', 'score', 'createdAt'],
  },
  {
    category: 'ratingsGiven', model: 'Rating', by: ['raterId'], key: 'id', omit: { state: 'FRAUD_SAFETY' },
    fields: ['id', 'orderId', 'raterId', 'type', 'score', 'comment', 'tags', 'isPublic', 'response', 'respondedAt', 'visibleAt', 'createdAt', 'editableUntil', 'contextType', 'contextId'],
  },
  {
    category: 'serviceJobs', model: 'ServiceJob', by: ['customerId'], key: 'id',
    fields: ['id', 'customerId', 'description', 'status', 'quoteAmount', 'scheduledFor', 'providerConfirmedAt', 'completedAt', 'cancelledAt', 'createdAt', 'updatedAt'],
  },
  {
    category: 'bookings', model: 'Booking', by: ['customerId'], key: 'id',
    fields: ['id', 'itemId', 'customerId', 'orderId', 'slotStart', 'slotEnd', 'status', 'createdAt'],
  },
  {
    category: 'cart', model: 'Cart', by: ['customerId'], key: 'id',
    fields: ['id', 'customerId', 'deliveryAddressId', 'scheduledFor', 'promoCodeId', 'tipAmount', 'specialInstructions', 'lastActivityAt', 'createdAt', 'updatedAt'],
  },
  {
    category: 'returns', model: 'ReturnRequest', by: ['customerId'], key: 'id',
    fields: ['id', 'orderId', 'customerId', 'reason', 'status', 'resolutionNote', 'reviewedAt', 'refundRef', 'refundPaidAmount', 'refundPaidAt', 'refundKind', 'refundAmount', 'refundSentence', 'refundBasis', 'refundInferredAmount', 'refundFunder', 'createdAt'],
  },
  {
    category: 'itemFeedback', model: 'ItemFeedback', by: ['raterUserId'], key: 'id',
    fields: ['id', 'orderId', 'itemId', 'raterUserId', 'verdict', 'createdAt'],
  },
  {
    category: 'ratingReports', model: 'RatingReport', by: ['reporterId'], key: 'id',
    fields: ['id', 'ratingId', 'reporterId', 'reason', 'note', 'status', 'resolvedAt', 'createdAt'],
  },
  {
    category: 'contentReports', model: 'ContentReport', by: ['reporterId'], key: 'id', omit: { targetId: 'OTHER_PERSON', enforcementRef: 'OTHER_PERSON', authorityRef: 'OTHER_PERSON' },
    fields: ['id', 'reporterId', 'targetType', 'reason', 'detail', 'status', 'resolvedAt', 'resolutionNote', 'disposition', 'evidencePreserved', 'dismissProposedAt', 'createdAt', 'updatedAt'],
  },
  {
    category: 'rideRequests', model: 'RideQueueEntry', by: ['customerId'], key: 'id',
    fields: ['id', 'customerId', 'pickupLat', 'pickupLng', 'pickupAddress', 'dropoffLat', 'dropoffLng', 'dropoffAddress', 'rideClass', 'passengerCount', 'status', 'createdAt', 'expiresAt', 'matchedOrderId', 'expiredNotifiedAt', 'quotedFare'],
  },
  {
    category: 'supplyWatches', model: 'SupplyWatch', by: ['customerId'], key: 'id',
    fields: ['id', 'customerId', 'pool', 'lat', 'lng', 'createdAt', 'expiresAt', 'notifiedAt'],
  },
  {
    category: 'refundsOwed', model: 'MmgRefundObligation', by: ['customerId'], key: 'id',
    fields: ['id', 'orderId', 'customerId', 'orderItemId', 'kind', 'causeKey', 'status', 'amount', 'currencyCode', 'basis', 'reason', 'deadlineHours', 'dueAt', 'missedAt', 'sendId', 'resolvedAt', 'resolutionNote', 'createdAt', 'updatedAt'],
  },
  {
    category: 'refundsSent', model: 'MmgRefundSend', by: ['customerId'], key: 'id',
    fields: ['id', 'orderId', 'customerId', 'mmgRefundRef', 'amount', 'feeBorneBySwift', 'currencyCode', 'sentAt', 'answer', 'answeredAt', 'supportTicketId', 'resolution', 'resolvedAt', 'note', 'coveredObligationIds', 'createdAt', 'updatedAt'],
  },
  {
    category: 'sessions', model: 'Session', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'authMethod', 'rotatedAt', 'deviceType', 'ipAddress', 'userAgent', 'expiresAt', 'createdAt'],
  },
  {
    category: 'devices', model: 'DeviceToken', by: ['userId'], key: 'id',
    // alertsVersion (RINGER #1779): which job-alert sound the app on this device reported it can play (0 = the plain
    // push, 1 = the job ring). The person's own device, as their app reported it: exported like platform.
    fields: ['id', 'userId', 'platform', 'isActive', 'createdAt', 'alertsVersion'],
  },
  {
    category: 'verificationDocuments', model: 'VerificationDocument', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'role', 'docType', 'status', 'state', 'expiresAt', 'reviewNote', 'reviewedAt', 'insurerName', 'policyNumber', 'coverageClass', 'hireClassConfirmed', 'plateCrossChecked', 'consentAt', 'privacyNoticeVersion', 'retentionExpiresAt', 'purgedAt', 'createdAt', 'updatedAt', 'subjectId', 'imagePurgedAt'],
  },
  {
    category: 'uploadedFiles', model: 'EncryptedObject', by: ['createdBy'], key: 'fileKey',
    fields: ['mimeType', 'sizeBytes', 'createdBy', 'createdAt', 'shreddedAt'],
  },
  {
    category: 'livenessChecks', model: 'LivenessCheck', by: ['userId'], key: 'id', omit: { reviewNote: 'INTERNAL_NOTE', score: 'FRAUD_SAFETY', reviewRequired: 'FRAUD_SAFETY' },
    fields: ['id', 'userId', 'profile', 'purpose', 'outcome', 'reviewedAt', 'createdAt'],
  },
  {
    category: 'accountRecoveries', model: 'AccountRecovery', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'method', 'status', 'newPhone', 'reviewedAt', 'rejectionReason', 'securityHoldUntil', 'expiresAt', 'createdAt'],
  },
  {
    category: 'consents', model: 'ConsentRecord', by: ['subjectId'], key: 'id',
    fields: ['id', 'subjectId', 'documentType', 'documentVersion', 'action', 'surface', 'locale', 'capturedAt', 'appVersion', 'evidence'],
  },
  {
    category: 'rectificationRequests', model: 'RectificationRequest', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'caseId', 'fieldCode', 'note', 'resolvedAt', 'createdAt'],
  },
  {
    category: 'deletionReceipts', model: 'DeletionReceipt', by: ['subjectId'], key: 'id', omit: { storeLocations: 'STORED_FILE' },
    fields: ['id', 'subjectId', 'docTypeCode', 'bytesDeleted', 'deletedAt', 'verificationProbeResult'],
  },
  {
    category: 'notifications', model: 'Notification', by: ['userId'], key: 'id', omit: { data: 'SYSTEM' },
    fields: ['id', 'userId', 'type', 'title', 'body', 'isRead', 'readAt', 'createdAt'],
  },
  {
    category: 'supportTickets', model: 'SupportTicket', by: ['userId'], key: 'id', omit: { adminNote: 'INTERNAL_NOTE' },
    fields: ['id', 'userId', 'orderId', 'category', 'subject', 'message', 'status', 'resolution', 'resolvedAt', 'createdAt', 'updatedAt'],
  },
  {
    category: 'chatRooms', model: 'ChatRoomParticipant', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'role', 'joinedAt', 'lastReadAt'],
  },
  {
    category: 'chatMessagesSent', model: 'ChatMessage', by: ['senderId'], key: 'id',
    fields: ['id', 'senderId', 'message', 'messageType', 'isRead', 'createdAt'],
  },
  {
    category: 'transactions', model: 'Transaction', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'type', 'amount', 'direction', 'description', 'reference', 'externalRef', 'balanceAfter', 'createdAt'],
  },
  {
    category: 'payoutRequests', model: 'PayoutRequest', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'amount', 'method', 'status', 'destination', 'fee', 'netAmount', 'externalRef', 'processedAt', 'failedReason', 'createdAt'],
  },
  {
    category: 'payoutSchedules', model: 'PayoutSchedule', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'frequency', 'dayOfWeek', 'method', 'destination', 'isActive', 'lastPayoutAt', 'nextPayoutAt', 'createdAt', 'updatedAt'],
  },
  {
    category: 'paymentCards', model: 'PaymentInstrument', by: ['userId'], key: 'id',
    fields: ['id', 'subscriptionId', 'userId', 'provider', 'environment', 'providerAccount', 'brand', 'last4', 'expMonth', 'expYear', 'status', 'consentVersion', 'consentAt', 'replacedAt', 'revokedAt', 'expiredAt', 'createdAt', 'updatedAt'],
  },
  {
    category: 'cardPayments', model: 'CardSession', by: ['userId'], key: 'id',
    fields: ['id', 'subscriptionId', 'userId', 'purpose', 'status', 'provider', 'environment', 'providerAccount', 'amount', 'currencyCode', 'periodStart', 'expiresAt', 'returnedAt', 'confirmedAt', 'lastCheckedAt', 'consentVersion', 'consentAt', 'failureCode', 'instrumentId', 'paymentId', 'providerTransactionRef', 'completionClaimedAt', 'providerVoidState', 'providerVoidAt', 'providerRefundState', 'providerRefundAt', 'bookClaimedAt', 'resolution', 'resolvedAt', 'createdAt', 'updatedAt'],
  },
  {
    category: 'mmgCheckouts', model: 'MmgCheckoutIntent', by: ['createdByUserId'], key: 'id', omit: { candidates: 'SYSTEM' },
    fields: ['id', 'subscriptionId', 'merchantTransactionId', 'amount', 'currencyCode', 'status', 'createdByUserId', 'platform', 'expiresAt', 'replyAt', 'outcomeHint', 'mmgTransactionId', 'providerPaymentId', 'confirmedAt', 'reason', 'createdAt', 'updatedAt'],
  },
  {
    category: 'feeNotices', model: 'BillingFeeNotice', by: ['userId'], key: 'id', omit: { payload: 'SYSTEM' },
    fields: ['id', 'subscriptionId', 'clockId', 'stageKey', 'userId', 'status', 'createdAt', 'updatedAt'],
  },
  {
    category: 'emergencyContacts', model: 'EmergencyContact', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'name', 'phoneE164', 'relationship', 'priority', 'verifiedAt', 'createdAt', 'updatedAt'],
  },
  {
    // [O-1] The Swift-bridged calls the person asked for on their orders: which party (a role, never a
    // person), when, and how far it got. Swift stores no phone number for a call; the provider's own id is bookkeeping.
    category: 'swiftCalls', model: 'CallSession', by: ['callerUserId'], key: 'id', omit: { provider: 'SYSTEM', providerCallId: 'SYSTEM' },
    fields: ['id', 'orderId', 'callerUserId', 'callerRole', 'calleeRole', 'status', 'callerConfirmedAt', 'connectedAt', 'endedAt', 'durationSeconds', 'createdAt', 'updatedAt'],
  },
  {
    category: 'tripShares', model: 'TripShareToken', by: ['createdByUserId'], key: 'id',
    fields: ['id', 'orderId', 'createdByUserId', 'rotatedAt', 'sharedToPhone', 'expiresAt', 'revokedAt', 'viewCount', 'lastViewedAt', 'createdAt'],
  },
  {
    category: 'sosAlertsRaised', model: 'SosAlert', by: ['actorUserId'], key: 'id', omit: { resolutionNotes: 'INTERNAL_NOTE' },
    fields: ['id', 'actorUserId', 'actorRole', 'orderId', 'orderType', 'serviceJobId', 'status', 'triggerSource', 'triggeredAt', 'graceEndsAt', 'cancelledAt', 'cancelReason', 'userSafeFlaggedAt', 'acknowledgedAt', 'resolvedAt', 'resolutionCode', 'triggerLat', 'triggerLng', 'triggerAccuracyM', 'triggerAddressText', 'triggerNote', 'clientCreatedAt', 'retriggerCount', 'lastRetriggerAt', 'retriggers', 'createdAt', 'updatedAt'],
  },
  {
    category: 'documentRenewals', model: 'RenewalSchedule', by: ['subjectId'], key: 'id',
    fields: ['id', 'documentId', 'subjectId', 'expiresOn', 'notifyAt', 'suspendAt', 'lastNotified', 'suspendedAt', 'createdAt', 'updatedAt'],
  },
  {
    category: 'customerProfile', model: 'Customer', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'totalOrders', 'totalSpent', 'referralCode', 'createdAt'],
  },
  {
    category: 'riderProfile', model: 'Rider', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'riderType', 'vehicleType', 'vehicleMake', 'vehicleModel', 'vehicleYear', 'vehicleColor', 'licensePlate', 'documentsVerified', 'documentsVerifiedAt', 'isOnline', 'isAvailable', 'currentLat', 'currentLng', 'lastLocationUpdate', 'lastLivenessPassAt', 'livenessLockedAt', 'livenessPromptDeadlineAt', 'safetySuspendedAt', 'totalDeliveries', 'totalCourierJobs', 'completionRate', 'acceptanceRate', 'floatLimit', 'committedFloat', 'createdAt', 'updatedAt'],
  },
  {
    category: 'driverProfile', model: 'Driver', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'vehicleMake', 'vehicleModel', 'vehicleYear', 'vehicleColor', 'licensePlate', 'vehicleCapacity', 'vehicleType', 'rideClass', 'taxiStopsCapable', 'bodyType', 'colorHex', 'documentsVerified', 'documentsVerifiedAt', 'isOnline', 'isAvailable', 'currentLat', 'currentLng', 'lastLocationUpdate', 'lastLivenessPassAt', 'livenessLockedAt', 'livenessPromptDeadlineAt', 'safetySuspendedAt', 'totalRides', 'acceptanceRate', 'cancellationRate', 'mmgPayUrl', 'mmgPayUrlPending', 'mmgPayUrlPendingAt', 'mmgPayUrlApplyAt', 'createdAt', 'updatedAt'],
  },
  {
    category: 'serviceProviderProfile', model: 'ServiceProvider', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'trade', 'bio', 'selfSkilled', 'isVerified', 'createdAt', 'updatedAt'],
  },
  {
    category: 'storeOwnership', model: 'VendorOwner', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'createdAt'],
  },
  {
    // [REVIEW-M S3 on #2027 · follow-up] The record of each store the person OWNS, read through the ownership
    // (VendorOwner.userId = the person; never a store they only work at): for a sole trader its phone, email,
    // address and map pin can be the owner's own contact and home place, and its MMG details their own wallet.
    // What the owner sets for the store is in. Images are stored files; staff notes, a checkout hold and who
    // placed it, the ratings totals, being featured and system bookkeeping are not.
    category: 'storesOwned', model: 'Vendor', through: 'owner', by: ['userId'], key: 'id',
    omit: {
      logoUrl: 'STORED_FILE', coverImageUrl: 'STORED_FILE', tierNote: 'INTERNAL_NOTE', mmgCheckoutHeldReason: 'INTERNAL_NOTE',
      mmgCheckoutHeldAt: 'FRAUD_SAFETY', suspensionSource: 'SYSTEM', isFeatured: 'SYSTEM', mmgMissesClearedAt: 'SYSTEM', nameReviewApprovedHash: 'SYSTEM',
    },
    fields: [
      'id', 'name', 'slug', 'description', 'vendorType', 'tradesUnderOwnName', 'phone', 'publicPhone', 'email', 'addressLine1', 'addressLine2', 'city', 'region',
      'latitude', 'longitude', 'isCurrentlyOpen', 'acceptingOrders', 'selfDeliveryEnabled', 'requirePickupCode', 'maxConcurrentOrders',
      'deliveryRadius', 'minOrderAmount', 'estimatedPrepTime', 'cuisineTypes', 'tags', 'refundRule', 'vatRegistrationNumber', 'qrSlug',
      'mmgNumber', 'mmgNumberPending', 'mmgNumberPendingAt', 'mmgNumberApplyAt', 'mmgPayUrl', 'mmgPayUrlPending', 'mmgPayUrlPendingAt', 'mmgPayUrlApplyAt',
      'isVerified', 'activationValidUntil', 'tier', 'tierChangedAt', 'status', 'totalOrders', 'nameReviewApprovedAt', 'createdAt', 'updatedAt',
    ],
  },
  {
    category: 'storeStaffRoles', model: 'VendorStaff', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'role', 'createdAt'],
  },
  {
    category: 'advertiserMemberships', model: 'AdvertiserMember', by: ['userId'], key: 'advertiserId',
    fields: ['advertiserId', 'userId', 'role', 'createdAt', 'acceptedAt'],
  },
  {
    category: 'advertisersCreated', model: 'Advertiser', by: ['createdByUserId'], key: 'id',
    fields: ['id', 'companyName', 'legalName', 'registrationNo', 'industry', 'website', 'contactName', 'contactEmail', 'contactPhone', 'city', 'status', 'statusReason', 'createdByUserId', 'creditBalance', 'createdAt', 'updatedAt'],
  },
  {
    category: 'complianceReviews', model: 'ComplianceReviewCase', by: ['userId'], key: 'id', omit: { note: 'INTERNAL_NOTE' },
    fields: ['id', 'userId', 'status', 'dueAt', 'decidedAt', 'createdAt'],
  },
  {
    category: 'deliveriesAsRider', model: 'Order', by: ['riderId'], via: 'rider', key: 'id', rest: 'OTHER_PERSON',
    fields: ['orderNumber', 'orderType', 'riderId', 'status', 'courierPackageSize', 'billableKm', 'routeMatchedKm', 'deliveryFee', 'tipAmount', 'currencyCode', 'paymentMethod', 'isExpress', 'scheduledFor', 'placedAt', 'acceptedAt', 'readyAt', 'pickedUpAt', 'deliveredAt', 'cancelledAt', 'doorCashCollectedAmount', 'doorCashShortfallAmount', 'doorCashReturnAmount', 'doorCashReturnStatus', 'createdAt'],
  },
  {
    category: 'tripsAsDriver', model: 'Order', by: ['driverId'], via: 'driver', key: 'id', rest: 'OTHER_PERSON',
    fields: ['orderNumber', 'orderType', 'driverId', 'status', 'taxiPassengerCount', 'taxiDistance', 'taxiDuration', 'taxiStopCount', 'billableKm', 'routeMatchedKm', 'tipAmount', 'currencyCode', 'taxiFareBase', 'taxiFarePerKm', 'taxiFarePerMin', 'taxiFareTotal', 'taxiFareSurge', 'rideClass', 'paymentMethod', 'acceptedAt', 'driverArrivedAt', 'pickedUpAt', 'deliveredAt', 'cancelledAt', 'lateCancelFeeDue', 'createdAt'],
  },
  {
    category: 'earnings', model: 'Earning', by: ['riderId', 'driverId'], via: 'mover', key: 'id',
    fields: ['id', 'riderId', 'driverId', 'orderId', 'type', 'amount', 'status', 'createdAt'],
  },
  {
    category: 'moverSubscriptions', model: 'Subscription', by: ['riderId', 'driverId'], via: 'mover', key: 'id',
    fields: ['id', 'riderId', 'driverId', 'type', 'status', 'weeklyRate', 'currentPeriodStart', 'currentPeriodEnd', 'nextBillingDate', 'isInGracePeriod', 'gracePeriodEnd', 'isTrialActive', 'trialEndDate', 'autoRenew', 'lastPaymentDate', 'lastPaymentId', 'failedAttempts', 'feeWaived', 'feeWaivedReason', 'customRate', 'currencyCode', 'autoSuspendEnabled', 'billingMethod', 'mmgPayerMsisdn', 'suspendedAt', 'billingConfirmationPausedAt', 'billingEnforcementDueAt', 'san', 'sanAssignedAt', 'createdAt', 'updatedAt'],
  },
  {
    category: 'cashSettlements', model: 'DeliveryCashSettlement', by: ['riderId'], via: 'rider', key: 'id',
    fields: ['id', 'orderId', 'riderId', 'amount', 'status', 'riderConfirmedAt', 'storeConfirmedAt', 'riderAttestedAmount', 'storeAttestedAmount', 'createdAt'],
  },
  {
    category: 'deliveryRuns', model: 'DeliveryRun', by: ['riderId'], via: 'rider', key: 'id',
    fields: ['id', 'riderId', 'status', 'vehicleType', 'capacityPointsUsed', 'cashToCollectTotal', 'plannedDistanceM', 'plannedDurationS', 'startedAt', 'completedAt', 'createdAt'],
  },
  {
    category: 'reimbursementClaims', model: 'ReimbursementClaim', by: ['riderId', 'driverId'], via: 'mover', key: 'id', omit: { gpsLat: 'OTHER_PERSON', gpsLng: 'OTHER_PERSON', evidence: 'OTHER_PERSON' },
    fields: ['id', 'orderId', 'riderId', 'driverId', 'amount', 'reason', 'status', 'reviewNote', 'reviewedAt', 'paidAt', 'paymentRef', 'paidAmount', 'evidenceComplete', 'handoverEvidenceId', 'createdAt'],
  },
  {
    category: 'handoverPhotoProofs', model: 'HandoverPhotoProof', by: ['riderId', 'driverId'], via: 'mover', key: 'id',
    fields: ['id', 'orderId', 'actorId', 'riderId', 'driverId', 'purpose', 'mimeType', 'byteSize', 'sourceStatus', 'issuedAt', 'invalidatedAt', 'invalidationReason'],
  },
  {
    category: 'cashHandoverRecords', model: 'CashHandoverEvidence', by: ['riderId', 'driverId'], via: 'mover', key: 'id', omit: { locationLat: 'OTHER_PERSON', locationLng: 'OTHER_PERSON', declaredLat: 'OTHER_PERSON', declaredLng: 'OTHER_PERSON' },
    fields: ['id', 'orderId', 'actorId', 'riderId', 'driverId', 'orderType', 'outcome', 'sourceStatus', 'filedAt', 'locationAt', 'arrivalLogId', 'arrivalAt', 'waitedMs', 'photoProofId', 'policyVersion', 'maxDistanceKm', 'maxLocationAgeMs', 'invalidatedAt', 'invalidationReason'],
  },
  {
    category: 'serviceJobsAsProvider', model: 'ServiceJob', by: ['providerId'], via: 'provider', key: 'id', rest: 'OTHER_PERSON',
    fields: ['providerId', 'status', 'quoteAmount', 'scheduledFor', 'providerConfirmedAt', 'completedAt', 'cancelledAt', 'createdAt'],
  },
  {
    category: 'serviceQualifications', model: 'ServiceQualification', by: ['providerId'], via: 'provider', key: 'id',
    fields: ['id', 'providerId', 'trade', 'type', 'referenceNumber', 'status', 'verifiedAt', 'createdAt'],
  },
];

/** Person links that are not exported, keyed `Model.column`, each with its reason. */
export const WITHHELD: Readonly<Record<string, { readonly reason: WithheldReason; readonly note: string }>> = {
  // A live cache that moves with each single rating; the ratings themselves are given in groups of 5 instead.
  'ActorRatingStat.subjectId': { reason: 'SYSTEM', note: 'the running rating summary the app keeps (your ratings are given in groups of 5 instead)' },
  'IdentityKey.accountId': { reason: 'FRAUD_SAFETY', note: 'identity signals used to stop one person opening many accounts' },
  'IdentityClusterMember.accountId': { reason: 'FRAUD_SAFETY', note: 'links between accounts found by fraud checks' },
  'FaceTemplate.accountId': { reason: 'FRAUD_SAFETY', note: 'face-match template used only to stop repeat sign-ups' },
  'TrialGrant.accountId': { reason: 'FRAUD_SAFETY', note: 'free-trial eligibility decided by fraud checks' },
  'EnforcementAction.accountId': { reason: 'FRAUD_SAFETY', note: 'account restrictions decided by fraud checks' },
  'FraudCase.subjectUserId': { reason: 'FRAUD_SAFETY', note: 'confirmed fraud cases' },
  'MmgPayerEvidence.accountId': { reason: 'FRAUD_SAFETY', note: 'payer signals used to detect shared or stolen payment accounts' },
  'Strike.userId': { reason: 'FRAUD_SAFETY', note: 'strikes for fake or abusive orders' },
  'ComplianceViolation.userId': { reason: 'FRAUD_SAFETY', note: 'compliance checks on movers and their evidence' },
  'IncidentCase.subjectUserId': { reason: 'FRAUD_SAFETY', note: 'safety cases opened about you' },
  'IncidentCase.reporterUserId': { reason: 'FRAUD_SAFETY', note: 'safety cases you reported (they hold details of other people)' },
  'EvidenceBundle.subjectUserId': { reason: 'FRAUD_SAFETY', note: 'sealed safety evidence' },
  'SafetyDeletionHold.userId': { reason: 'FRAUD_SAFETY', note: 'encrypted safety escrow kept after an account closes during an open case' },
  'TripSafetySession.passengerUserId': { reason: 'FRAUD_SAFETY', note: 'trip safety monitoring and its risk score' },
  'TripSafetySession.driverUserId': { reason: 'FRAUD_SAFETY', note: 'trip safety monitoring and its risk score' },
  'SosAlert.counterpartyUserId': { reason: 'FRAUD_SAFETY', note: 'emergency alerts other people raised on a trip with you' },
  'SosRetrigger.counterpartyUserId': { reason: 'FRAUD_SAFETY', note: 'emergency alerts other people raised on a trip with you' },
  'ReimbursementClaim.customerId': { reason: 'OTHER_PEOPLE', note: 'a claim a mover made about an order of yours' },
  'HandoverPhotoProof.customerId': { reason: 'OTHER_PEOPLE', note: 'the handover proof a mover filed for an order of yours' },
  'CashHandoverEvidence.customerId': { reason: 'OTHER_PEOPLE', note: 'the cash handover record a mover filed for an order of yours' },
  'Admin.userId': { reason: 'STAFF_WORK', note: 'your Swift staff permissions' },
  'AdCreative.reviewedByUserId': { reason: 'STAFF_WORK', note: 'ad reviews done as staff' },
  'AdRefundIntent.requestedByUserId': { reason: 'STAFF_WORK', note: 'ad refunds asked for on behalf of a business' },
  'AdsAuditLog.actorUserId': { reason: 'STAFF_WORK', note: 'changes made to the ads of a business' },
  'AuditChainEntry.actorId': { reason: 'STAFF_WORK', note: 'the tamper-evident log of document decisions made as staff' },
  'CustodyRecoveryCase.ownerUserId': { reason: 'STAFF_WORK', note: 'parcel recovery cases handled as staff' },
  'FxRate.setByUserId': { reason: 'STAFF_WORK', note: 'exchange rates set as staff' },
  'OpsAlertRecipient.userId': { reason: 'STAFF_WORK', note: 'operations alerts sent to staff' },
  'PricingConfigVersion.createdBy': { reason: 'STAFF_WORK', note: 'price settings changed as staff' },
  'PromoTerms.createdBy': { reason: 'STAFF_WORK', note: 'promotion terms written as staff' },
  'SafetyAccessLog.accessorUserId': { reason: 'STAFF_WORK', note: 'safety evidence opened as staff' },
  'SensitiveReadLog.actorUserId': { reason: 'STAFF_WORK', note: 'sensitive records opened as staff' },
  'SensitiveReadLog.subjectId': { reason: 'STAFF_WORK', note: 'the security log of staff who opened your sensitive records' },
  'StockAdjustment.createdBy': { reason: 'STAFF_WORK', note: 'stock changes made for a store' },
  'StockMovement.actorId': { reason: 'STAFF_WORK', note: 'stock changes made for a store' },
  'SupportTicket.resolvedById': { reason: 'STAFF_WORK', note: 'support tickets resolved as staff' },
  'DocLegalHold.subjectUserId': { reason: 'LEGAL_HOLD', note: 'a legal hold on your documents' },
  'AlertDelivery.recipientId': { reason: 'SYSTEM', note: 'delivery of job offers (the jobs you did are in deliveriesAsRider and tripsAsDriver)' },
  'AlgoDecision.subjectId': { reason: 'SYSTEM', note: 'logs of automated dispatch and pricing steps' },
  'BatchEvaluation.riderId': { reason: 'SYSTEM', note: 'dispatch checks of whether orders could be batched' },
  'BillingDunningClock.moverPayerUserId': { reason: 'SYSTEM', note: 'the weekly-fee reminder clock (the notices are in feeNotices)' },
  'CartMergeReceipt.userId': { reason: 'SYSTEM', note: 'replay protection for cart merges' },
  'CheckoutReceipt.userId': { reason: 'SYSTEM', note: 'replay protection for checkouts (the orders are in orders)' },
  'GuardianCheckinDelivery.userId': { reason: 'SYSTEM', note: 'delivery attempts of safety check-in messages' },
  'MmgCheckoutKey.createdByUserId': { reason: 'SYSTEM', note: 'one-time keys for MMG checkout pages' },
  'MoneySurfaceCommand.userId': { reason: 'SYSTEM', note: 'pending changes to payout and payment settings' },
  'MoverFeeAuthority.userId': { reason: 'SYSTEM', note: 'which weekly-fee subscription is in force (the subscription is in moverSubscriptions)' },
  'MoverFeeAuthority.tenantId': { reason: 'SYSTEM', note: 'which weekly-fee subscription is in force' },
  'MoverFeeSubscription.userId': { reason: 'SYSTEM', note: 'which weekly-fee subscription is in force' },
  'MoverRevocationOutbox.userId': { reason: 'SYSTEM', note: 'queued access changes' },
  // [S2-29] The row holds only the follow-up command an approval still owes (the trial decision), its retry
  // clock and the system's last error; the decision itself is in verificationDocuments and its notice in notifications.
  'VerificationDecisionOutbox.userId': { reason: 'SYSTEM', note: 'queued follow-up work after a document approval (the decision is in verificationDocuments, its notice in notifications)' },
  'StorageOrphan.userId': { reason: 'SYSTEM', note: 'cleanup of stored files' },
  'Subject.createdById': { reason: 'SYSTEM', note: 'the document register index (the documents are in verificationDocuments)' },
  'SubjectLink.accountId': { reason: 'SYSTEM', note: 'the document register index' },
  'PersonProfile.accountId': { reason: 'SYSTEM', note: 'the document register index' },
  'BusinessProfile.ownerAccountId': { reason: 'SYSTEM', note: 'the document register index' },
  'DocumentRecord.accountId': { reason: 'SYSTEM', note: 'the document register index (the documents are in verificationDocuments)' },
};

/**
 * [REVIEW-M S3-1] Child tables of a person's own record that hold a place (an address or a coordinate), have no
 * person column of their own and are NOT exported `through` that record, with the reason. Anything else like
 * them is red in account-export-register.test until it is exported through its parent or named here.
 */
export const PLACES_NOT_EXPORTED: Readonly<Record<string, string>> = {
  // [REVIEW-M S3 on #2027] Vendor is exported through the ownership now (storesOwned).
};

/** Person links whose rows are already in a category through another column of the same row. */
export const ALSO_COVERED: Readonly<Record<string, string>> = {
  'HandoverPhotoProof.actorId': 'handoverPhotoProofs',
  'CashHandoverEvidence.actorId': 'cashHandoverRecords',
};

/** Columns whose name looks like a person link but that hold something else. */
export const NOT_A_PERSON: Readonly<Record<string, string>> = {
  'AlertDelivery.subjectId': 'the order or job an offer was for',
  'DispatchSearch.subjectId': 'the order or ride being dispatched',
  'VerificationDocument.subjectId': 'a document register entry',
  'DocumentRecord.subjectId': 'a document register entry',
  'SubjectLink.subjectId': 'a document register entry',
  'PersonProfile.subjectId': 'a document register entry',
  'BusinessProfile.subjectId': 'a document register entry',
  'VehicleProfile.subjectId': 'a document register entry (a vehicle)',
};
