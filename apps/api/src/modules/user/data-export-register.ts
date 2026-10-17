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

/** Why a column of an exported table is left out. */
export type OmitReason =
  | 'SECRET' // codes, tokens, keys, hashes: they protect the account, they are not information about the person
  | 'STORED_FILE' // a pointer to a stored photo or document image (kept encrypted; a copy is asked for through Support)
  | 'FRAUD_SAFETY' // fraud-prevention and safety signals
  | 'OTHER_PERSON' // another person's details, or the staff member who acted
  | 'INTERNAL_NOTE' // a private note staff wrote while handling a case
  | 'SYSTEM'; // bookkeeping with no information about the person (versions, leases, tenant ids)

/** Name rules, in order; the first match decides. A `by` column is always exported (it is the person). */
export const OMIT_RULES: ReadonlyArray<readonly [OmitReason, RegExp]> = [
  ['SECRET', /^(token|refreshToken|previousRefreshToken|passwordHash|tokenDigest|tokenPrefix|ridePin|pickupCode|transferCode|clientKey|idempotencyKey|clientIdempotencyKey|requestKey|requestHash|stateHash|dedupeKey|noticeDedupeKey|payloadHash|documentContentHash|contentHash|contentSha256|sha256|ipHmac|valueHash|payerHash|bindingDigest|digest|oldDigest|newDigest|sealHash|stepUpSessionId|stepUpBinding|paymentToken|courierTrackingToken|lockedUntil|failedLoginAttempts)$/],
  ['STORED_FILE', /^(avatar|fileUrl|fileKey|objectKey|selfieUrl|idDocumentUrl|mediaUrl|photoUrl|photos|portfolioPhotos|posterUrl|nationalIdUrl|driverLicenseUrl|vehicleInsuranceUrl|vehicleInspectionUrl|profilePhotoUrl|vehiclePhotoUrl|courierPackagePhotoUrl|courierProofPhotoUrl|courierProofIssuedUrl|courierReturnProofPhotoUrl|courierPickupProofIssuedUrl|courierPickupProofPhotoUrl)$/],
  ['FRAUD_SAFETY', /^(riskFlagged|riskReason|riskScore|riskFactors|flags|flagged|flagReason|offPlatformFlag|safetyShadowRestrictedAt|signals|signalsFired|patternFlaggedAt|standing|enhancedSafetyMonitoring|deviationState|mmgClaimMismatchAt|doorCashMismatchAt)$/],
  ['OTHER_PERSON', /^(riderId|driverId|providerId|rateeId|raterId|recipientIds|counterpartyUserId|courierProofIssuedRiderId|courierPickupProofIssuedRiderId|holderRiderId|relayRiderId|assignedTo|candidatesTried|invitedBy|mergedIntoId|ownerId|vendorId|customerId)$|By$|ById$|ByUserId$/],
  ['SYSTEM', /^(tenantId|syntheticRunId|isSynthetic|riderAssignmentVersion|driverAssignmentVersion|fulfillmentModeVersion|mmgClaimRevision|mmgClaimResolvedRevision|revision|version|epoch|generation|attempts|maxAttempts|checkAttempts|noticeAttempts|leaseExpiresAt|leasedUntil|availableAt|claimedAt|lastError|noticeLastError|nextCheckAt|nextRetryAt|locationSessionId|actorSessionId|offerAttemptId|correlationId|hostedUrl|providerSessionRef|schemaVersion|purgeGeneration|configVersion|legalHoldId|kycRef|chatRoomId|subjectType|submissionId|deliveryReceipts)$/],
];

/** Kinds of whole records that are not in the file. */
export type WithheldReason = 'FRAUD_SAFETY' | 'OTHER_PEOPLE' | 'STAFF_WORK' | 'LEGAL_HOLD' | 'SYSTEM';

/** The person's own words for each; the `withheld` list of the file is built from these. */
export const WITHHELD_REASON_TEXT: Readonly<Record<WithheldReason, string>> = {
  FRAUD_SAFETY: 'Fraud-prevention and safety-investigation records, and reports other people made about you.',
  OTHER_PEOPLE: 'Records that are mainly about other people, such as each individual rating someone gave you (your rating summary is included).',
  STAFF_WORK: 'Records of work you did as Swift staff or for a business, and the logs of staff access to accounts.',
  LEGAL_HOLD: 'Records of a legal hold on your documents.',
  SYSTEM: 'System bookkeeping that holds nothing about you beyond what this file already lists.',
};

/** Which profile ids a `via` entry reads by (a person with no such profile has none). */
export type ExportVia = 'rider' | 'driver' | 'provider' | 'mover';

export interface ExportEntry {
  /** The key of this category in the file. */
  readonly category: string;
  /** Prisma model name. */
  readonly model: string;
  /** Columns that equal the person's id (or their profile id, with `via`); a row matches on any. */
  readonly by: readonly string[];
  readonly via?: ExportVia;
  /** A unique, sortable column for paging. */
  readonly key: string;
  /** The exported columns (always including `by`). */
  readonly fields: readonly string[];
  /** Columns left out for a reason the name rules do not give. */
  readonly omit?: Readonly<Record<string, OmitReason>>;
  /** The reason for every other column (work records: the rest of the record is the customer's). */
  readonly rest?: OmitReason;
}

/** The person's own account row. */
export const ACCOUNT_FIELDS = [
  'id', 'phone', 'email', 'emailChangedAt', 'firstName', 'lastName', 'selfieCapturedAt', 'roles', 'activeRole', 'lastMoverRole',
  'status', 'isPhoneVerified', 'isEmailVerified', 'acceptedTermsAt', 'tosVersion', 'trustLevel', 'lossProtectionSuspendedAt',
  'lossProtectionSuspendedReason', 'countryCode', 'notificationPrefs', 'lastKnownLat', 'lastKnownLng', 'walletBalance',
  'createdAt', 'updatedAt', 'lastActiveAt',
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
    category: 'orders', model: 'Order', by: ['customerId'], key: 'id',
    fields: ['id', 'orderNumber', 'orderType', 'customerId', 'status', 'pickupAddress', 'pickupLat', 'pickupLng', 'deliveryAddress', 'deliveryLat', 'deliveryLng', 'deliveryInstructions', 'courierPackageDescription', 'courierPackageSize', 'courierPackageWeight', 'courierRecipientName', 'courierRecipientPhone', 'courierSpeed', 'courierPayer', 'courierReturnReason', 'courierReturnRequestedAt', 'courierReturnedAt', 'courierPickupProofLat', 'courierPickupProofLng', 'taxiPickupAddress', 'taxiDropoffAddress', 'taxiPassengerCount', 'taxiDistance', 'taxiDuration', 'taxiStopCount', 'billableKm', 'billableKmSource', 'routeMatchedKm', 'routePolyline', 'routeMatchSource', 'routeMatchedAt', 'subtotalBase', 'subtotalMarkup', 'subtotalCustomer', 'deliveryFee', 'serviceFee', 'taxAmount', 'tipAmount', 'discount', 'totalAmount', 'currencyCode', 'taxiFareBase', 'taxiFarePerKm', 'taxiFarePerMin', 'taxiFareTotal', 'taxiFareSurge', 'rideClass', 'paymentMethod', 'paymentStatus', 'paymentId', 'mmgPayUrlSnapshot', 'mmgRecipientNameSnapshot', 'mmgAttestedRef', 'mmgAttestedAt', 'mmgAttestedAmount', 'customerClaimedPaidAt', 'customerPaymentRef', 'customerMmgClaim', 'customerMmgClaimAt', 'mmgClaimResolution', 'mmgClaimResolvedAt', 'estimatedPrepTime', 'estimatedDeliveryTime', 'promisedAt', 'promiseBaseSeconds', 'promisePadSeconds', 'promiseRevisedAt', 'promiseRevisionReason', 'promiseRevisions', 'actualDeliveryTime', 'isExpress', 'scheduledFor', 'holdExpiresAt', 'releasedToVendorAt', 'foodAgeHeldAt', 'foodAgeWaivedAt', 'placedAt', 'acceptedAt', 'driverArrivedAt', 'preparingAt', 'readyAt', 'pickedUpAt', 'deliveredAt', 'cancelledAt', 'cancellationReason', 'lateCancelFeeDue', 'refundOwedAmount', 'refundOwedAt', 'refundRef', 'refundPaidAmount', 'refundSettledAt', 'doorCashCollectedAmount', 'doorCashShortfallAmount', 'doorCashReturnAmount', 'doorCashReturnStatus', 'doorCashReturnRecordedAt', 'doorCashReturnResolvedAt', 'promoCodeId', 'channel', 'attributionQrCodeId', 'ridePinVerified', 'ridePinAttempts', 'ridePinVerifiedAt', 'pickupCodeAttempts', 'fulfillment', 'fulfillmentMode', 'appointmentSlot', 'createdAt', 'updatedAt'],
  },
  {
    category: 'ratingsGiven', model: 'Rating', by: ['raterId'], key: 'id',
    fields: ['id', 'orderId', 'raterId', 'type', 'score', 'comment', 'tags', 'isPublic', 'response', 'respondedAt', 'visibleAt', 'createdAt', 'state', 'stateReason', 'editableUntil', 'contextType', 'contextId'],
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
    fields: ['id', 'customerId', 'pickupLat', 'pickupLng', 'pickupAddress', 'dropoffLat', 'dropoffLng', 'dropoffAddress', 'rideClass', 'passengerCount', 'status', 'createdAt', 'expiresAt', 'matchedOrderId', 'expiredNotifiedAt'],
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
    fields: ['id', 'userId', 'authMethod', 'rotatedAt', 'deviceId', 'deviceType', 'ipAddress', 'userAgent', 'expiresAt', 'createdAt'],
  },
  {
    category: 'devices', model: 'DeviceToken', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'platform', 'isActive', 'createdAt'],
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
    category: 'livenessChecks', model: 'LivenessCheck', by: ['userId'], key: 'id', omit: { reviewNote: 'INTERNAL_NOTE' },
    fields: ['id', 'userId', 'profile', 'purpose', 'score', 'outcome', 'reviewRequired', 'reviewedAt', 'createdAt'],
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
    category: 'deletionReceipts', model: 'DeletionReceipt', by: ['subjectId'], key: 'id',
    fields: ['id', 'subjectId', 'docTypeCode', 'bytesDeleted', 'deletedAt', 'storeLocations', 'verificationProbeResult'],
  },
  {
    category: 'notifications', model: 'Notification', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'type', 'title', 'body', 'data', 'isRead', 'readAt', 'createdAt'],
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
    fields: ['id', 'subscriptionId', 'userId', 'purpose', 'status', 'provider', 'environment', 'providerAccount', 'amount', 'currencyCode', 'periodStart', 'expiresAt', 'returnedAt', 'confirmedAt', 'lastCheckedAt', 'consentVersion', 'consentAt', 'failureCode', 'instrumentId', 'paymentId', 'providerTransactionRef', 'completionClaimedAt', 'completionEvidence', 'providerVoidState', 'providerVoidAt', 'providerRefundState', 'providerRefundAt', 'bookClaimedAt', 'resolution', 'resolvedAt', 'createdAt', 'updatedAt'],
  },
  {
    category: 'mmgCheckouts', model: 'MmgCheckoutIntent', by: ['createdByUserId'], key: 'id',
    fields: ['id', 'subscriptionId', 'merchantTransactionId', 'amount', 'currencyCode', 'status', 'createdByUserId', 'platform', 'expiresAt', 'replyAt', 'outcomeHint', 'candidates', 'mmgTransactionId', 'providerPaymentId', 'confirmedAt', 'reason', 'createdAt', 'updatedAt'],
  },
  {
    category: 'feeNotices', model: 'BillingFeeNotice', by: ['userId'], key: 'id',
    fields: ['id', 'subscriptionId', 'clockId', 'stageKey', 'userId', 'status', 'payload', 'createdAt', 'updatedAt'],
  },
  {
    category: 'emergencyContacts', model: 'EmergencyContact', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'name', 'phoneE164', 'relationship', 'priority', 'verifiedAt', 'createdAt', 'updatedAt'],
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
    category: 'ratingSummary', model: 'ActorRatingStat', by: ['subjectId'], key: 'id',
    fields: ['id', 'subjectRole', 'subjectId', 'lifetimeCount', 'lifetimeSum', 'rollingCount', 'rollingSum', 'displayRating', 'topPositiveTags', 'topNegativeTags', 'actorVisibleAt', 'recomputedAt'],
  },
  {
    category: 'customerProfile', model: 'Customer', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'totalOrders', 'totalSpent', 'referralCode', 'createdAt'],
  },
  {
    category: 'riderProfile', model: 'Rider', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'riderType', 'vehicleType', 'vehicleMake', 'vehicleModel', 'vehicleYear', 'vehicleColor', 'licensePlate', 'documentsVerified', 'documentsVerifiedAt', 'isOnline', 'isAvailable', 'currentLat', 'currentLng', 'lastLocationUpdate', 'currentOrderId', 'lastLivenessPassAt', 'livenessLockedAt', 'livenessPromptDeadlineAt', 'safetySuspendedAt', 'totalDeliveries', 'totalCourierJobs', 'averageRating', 'totalRatings', 'completionRate', 'acceptanceRate', 'floatLimit', 'committedFloat', 'createdAt', 'updatedAt'],
  },
  {
    category: 'driverProfile', model: 'Driver', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'vehicleMake', 'vehicleModel', 'vehicleYear', 'vehicleColor', 'licensePlate', 'vehicleCapacity', 'vehicleType', 'rideClass', 'taxiStopsCapable', 'bodyType', 'colorHex', 'documentsVerified', 'documentsVerifiedAt', 'isOnline', 'isAvailable', 'currentLat', 'currentLng', 'lastLocationUpdate', 'currentRideId', 'lastLivenessPassAt', 'livenessLockedAt', 'livenessPromptDeadlineAt', 'safetySuspendedAt', 'totalRides', 'averageRating', 'totalRatings', 'acceptanceRate', 'cancellationRate', 'mmgPayUrl', 'mmgPayUrlPending', 'mmgPayUrlPendingAt', 'mmgPayUrlApplyAt', 'createdAt', 'updatedAt'],
  },
  {
    category: 'serviceProviderProfile', model: 'ServiceProvider', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'trade', 'bio', 'selfSkilled', 'isVerified', 'averageRating', 'totalRatings', 'createdAt', 'updatedAt'],
  },
  {
    category: 'storeOwnership', model: 'VendorOwner', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'createdAt'],
  },
  {
    category: 'storeStaffRoles', model: 'VendorStaff', by: ['userId'], key: 'id',
    fields: ['id', 'userId', 'role', 'createdAt'],
  },
  {
    category: 'advertiserMemberships', model: 'AdvertiserMember', by: ['userId'], key: 'advertiserId',
    fields: ['advertiserId', 'userId', 'role', 'createdAt'],
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
    fields: ['orderNumber', 'orderType', 'riderId', 'status', 'pickupAddress', 'courierPackageSize', 'billableKm', 'routeMatchedKm', 'deliveryFee', 'tipAmount', 'currencyCode', 'paymentMethod', 'isExpress', 'scheduledFor', 'placedAt', 'acceptedAt', 'readyAt', 'pickedUpAt', 'deliveredAt', 'cancelledAt', 'doorCashCollectedAmount', 'doorCashShortfallAmount', 'doorCashReturnAmount', 'doorCashReturnStatus', 'createdAt'],
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
    category: 'reimbursementClaims', model: 'ReimbursementClaim', by: ['riderId', 'driverId'], via: 'mover', key: 'id',
    fields: ['id', 'orderId', 'riderId', 'driverId', 'amount', 'reason', 'gpsLat', 'gpsLng', 'status', 'reviewNote', 'reviewedAt', 'paidAt', 'paymentRef', 'paidAmount', 'evidence', 'evidenceComplete', 'handoverEvidenceId', 'createdAt'],
  },
  {
    category: 'handoverPhotoProofs', model: 'HandoverPhotoProof', by: ['riderId', 'driverId'], via: 'mover', key: 'id',
    fields: ['id', 'orderId', 'actorId', 'riderId', 'driverId', 'purpose', 'mimeType', 'byteSize', 'sourceStatus', 'issuedAt', 'invalidatedAt', 'invalidationReason'],
  },
  {
    category: 'cashHandoverRecords', model: 'CashHandoverEvidence', by: ['riderId', 'driverId'], via: 'mover', key: 'id',
    fields: ['id', 'orderId', 'actorId', 'riderId', 'driverId', 'orderType', 'outcome', 'sourceStatus', 'filedAt', 'locationLat', 'locationLng', 'locationAt', 'declaredLat', 'declaredLng', 'arrivalLogId', 'arrivalAt', 'waitedMs', 'photoProofId', 'policyVersion', 'maxDistanceKm', 'maxLocationAgeMs', 'invalidatedAt', 'invalidationReason'],
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
  'Rating.rateeId': { reason: 'OTHER_PEOPLE', note: 'each rating someone gave you (your rating summary is in ratingSummary)' },
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
  'StorageOrphan.userId': { reason: 'SYSTEM', note: 'cleanup of stored files' },
  'Subject.createdById': { reason: 'SYSTEM', note: 'the document register index (the documents are in verificationDocuments)' },
  'SubjectLink.accountId': { reason: 'SYSTEM', note: 'the document register index' },
  'PersonProfile.accountId': { reason: 'SYSTEM', note: 'the document register index' },
  'BusinessProfile.ownerAccountId': { reason: 'SYSTEM', note: 'the document register index' },
  'DocumentRecord.accountId': { reason: 'SYSTEM', note: 'the document register index (the documents are in verificationDocuments)' },
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
