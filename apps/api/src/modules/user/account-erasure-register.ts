/**
 * [GUARDRAILS §2 "honour deletion end to end" · REVIEW-F 18 Oct · COORD 18 Oct 23:28Z] THE ERASURE REGISTER.
 *
 * Every table that holds a person's id says what the account erasure (account.service deleteAccount and its
 * passes) does with the person's rows. "Holds a person's id" is the export register's rule (data-export-register,
 * account-export-register.test): a relation to User or to a rider, driver or service-provider profile, or a
 * column named for a person (userId, customerId, accountId, subjectId, reporterId, senderId, ...UserId, createdBy,
 * actorId ...), minus the columns that register already proved are not a person (NOT_A_PERSON).
 *  - ERASURE_CLEARED: the erasure deletes them (the census finds the delete in the erasure code);
 *  - ERASURE_DEIDENTIFIED: the row stays and the erasure strips what identifies the person from it;
 *  - ERASURE_KEPT: they stay, pointing at the de-identified account row, for the reason given (a Privacy Policy
 *    §6 retention, the §7 administrative trail, or a row that holds nothing about the person but the link);
 *  - ERASURE_UNDECIDED: keeping them needs a retention the Privacy Policy does not state. Each waits on the
 *    owner (PRIVACY ASK 19 Oct 00:01Z); the list may only shrink.
 * account-erasure-register.test.ts reads the schema (Prisma DMMF): a new table that holds a person's id is red
 * there until it is put in one of these lists.
 */

/** Link (`Model.column`) -> the erasure step that deletes the person's rows. */
export const ERASURE_CLEARED: Readonly<Record<string, string>> = {
  'Session.userId': 'erasure transaction: access revoked with the authority cut-off',
  'DeviceToken.userId': 'erasure transaction: access revoked with the authority cut-off',
  'VerificationDecisionOutbox.userId': 'erasure transaction: work an approval still owed (no trial for a closed account)',
  'Notification.userId': 'erasure transaction: in-app notices (titles and bodies can name orders and people)',
  'MoneySurfaceCommand.userId': 'erasure transaction: staged payout and payment-setting commands with their notices (a command queue, not a money record)',
  'MoverRevocationOutbox.userId': 'erasure transaction: finished rows; a row still owed to other people (their re-dispatch and notices) stays until it is done, then the standing re-sweep deletes it',
  'GuardianCheckinDelivery.userId': 'erasure transaction: safety check-in deliveries, unless a safety deletion hold is open (kept until it ends; the standing re-sweep deletes them)',
  'CardSession.userId': 'erasure transaction: card sessions that moved no money; one a payment or a confirmation hold names, or one still in flight, is settlement history (Privacy Policy §6)',
  'PaymentInstrument.userId': 'erasure transaction: every saved card is revoked and its sealed token forgotten; the row goes unless a payment record names it (then it is settlement history, token gone)',
  'RenewalSchedule.subjectId': 'erasure transaction: renewal reminders for documents the erasure purges',
  'Admin.userId': 'erasure transaction: staff permissions end with the account',
  'AdvertiserMember.userId': 'advertiser wind-down (seat removed)',
  'VendorStaff.userId': 'staff seats removed',
  'Address.userId': 'saved places dropped',
  'AccountRecovery.userId': 'ephemeral high-risk rows (NR-3 gap 6)',
  'LivenessCheck.userId': 'shift selfies: each row once its photo is confirmed gone (upload-erasure.ts)',
  'EmergencyContact.userId': 'ephemeral high-risk rows (NR-3 gap 6)',
  'Cart.customerId': 'ephemeral high-risk rows (NR-3 gap 6)',
  'CartMergeReceipt.userId': 'ephemeral high-risk rows (NR-3 gap 6)',
  'TripShareToken.createdByUserId': 'ephemeral high-risk rows (NR-3 gap 6): public trip shares',
  'RideQueueEntry.customerId': 'ephemeral high-risk rows (NR-3 gap 6): exact-location queue rows',
  'SupplyWatch.customerId': 'ephemeral high-risk rows (NR-3 gap 6): exact-location watch rows',
  'FaceTemplate.accountId': 'identity-integrity purge: the biometric template, in every case',
  'IdentityKey.accountId': 'identity-integrity purge (kept only as salted fraud tombstones while IntegritySettings.tombstoneRetentionEnabled is ON; default OFF)',
  'IdentityClusterMember.accountId': 'identity-integrity purge (kept only as fraud tombstones while IntegritySettings.tombstoneRetentionEnabled is ON; default OFF)',
};

/** Link -> what the erasure strips from the row it keeps. */
export const ERASURE_DEIDENTIFIED: Readonly<Record<string, string>> = {
  'Rider.userId': 'the profile row stays for order history; vehicle, plate and last location are cleared (photos and documents go through the mover-object erasure)',
  'Driver.userId': 'the profile row stays for ride history; vehicle, plate, colour, last location and MMG pay link are cleared (photos and documents go through the mover-object erasure)',
  'ServiceProvider.userId': 'the profile row stays for job history; the bio and portfolio photo pointers are cleared (an uploaded photo goes with the unclaimed-upload erasure)',
  'Customer.userId': 'order totals stay; the referral link is cleared and the referral code retired',
  'CheckoutReceipt.userId': 'the replay record stays with its order ids and date (the amounts are on the kept orders); the frozen checkout response (names, phones, addresses, notes) and the request hash are replaced',
};

/** Link -> why the person's rows stay after erasure (they point at the de-identified account row). */
export const ERASURE_KEPT: Readonly<Record<string, string>> = {
  'Order.customerId': 'order history, kept for disputes, guarantees, tax and legal duties (Privacy Policy §6)',
  'Order.riderId': 'order history (Privacy Policy §6)',
  'Order.driverId': 'ride history (Privacy Policy §6)',
  'Booking.customerId': 'ride history (Privacy Policy §6)',
  'ServiceJob.customerId': 'order history, kept for disputes, guarantees, tax and legal duties (Privacy Policy §6)',
  'ServiceJob.providerId': 'job history (Privacy Policy §6)',
  'ServiceQualification.providerId': 'the qualification a kept job was done under (job history, Privacy Policy §6); its document is purged',
  'DeliveryRun.riderId': 'order history: the delivery run that carried kept orders (Privacy Policy §6)',
  'BatchEvaluation.riderId': 'order history: the dispatch check made for a kept order (Privacy Policy §6)',
  'AlertDelivery.recipientId': 'order history: the job offers made while dispatching a kept order (Privacy Policy §6)',
  'ReturnRequest.customerId': 'order history: a return on a kept order (Privacy Policy §6)',
  'HandoverPhotoProof.customerId': 'order history: proof of a handover, kept for disputes (Privacy Policy §6)',
  'HandoverPhotoProof.actorId': 'order history: proof of a handover, kept for disputes (Privacy Policy §6)',
  'HandoverPhotoProof.riderId': 'order history: proof of a handover, kept for disputes (Privacy Policy §6)',
  'HandoverPhotoProof.driverId': 'order history: proof of a handover, kept for disputes (Privacy Policy §6)',
  'CashHandoverEvidence.customerId': 'the cash record is kept as part of the order record (Privacy Policy §6)',
  'CashHandoverEvidence.actorId': 'the cash record is kept as part of the order record (Privacy Policy §6)',
  'CashHandoverEvidence.riderId': 'the cash record is kept as part of the order record (Privacy Policy §6)',
  'CashHandoverEvidence.driverId': 'the cash record is kept as part of the order record (Privacy Policy §6)',
  'Transaction.userId': 'settlement history (Privacy Policy §6)',
  'PayoutRequest.userId': 'settlement history (Privacy Policy §6)',
  'PayoutSchedule.userId': 'settlement history (Privacy Policy §6)',
  'Earning.riderId': 'settlement history (Privacy Policy §6)',
  'Earning.driverId': 'settlement history (Privacy Policy §6)',
  'DeliveryCashSettlement.riderId': 'settlement history: the cash record of kept orders (Privacy Policy §6)',
  'ReimbursementClaim.customerId': 'settlement history (Privacy Policy §6)',
  'ReimbursementClaim.riderId': 'settlement history (Privacy Policy §6)',
  'ReimbursementClaim.driverId': 'settlement history (Privacy Policy §6)',
  'MmgRefundObligation.customerId': 'settlement history: a refund owed on a kept order (Privacy Policy §6)',
  'MmgRefundSend.customerId': 'settlement history: a refund sent on a kept order (Privacy Policy §6)',
  'Subscription.riderId': 'weekly-fee billing record (settlement history, Privacy Policy §6)',
  'Subscription.driverId': 'weekly-fee billing record (settlement history, Privacy Policy §6)',
  'BillingFeeNotice.userId': 'weekly-fee billing record (settlement history, Privacy Policy §6)',
  'BillingDunningClock.moverPayerUserId': 'weekly-fee billing record (settlement history, Privacy Policy §6)',
  'MoverFeeSubscription.userId': 'weekly-fee billing record (settlement history, Privacy Policy §6)',
  'MoverFeeAuthority.userId': 'weekly-fee billing record (settlement history, Privacy Policy §6)',
  'MoverFeeAuthority.tenantId': 'weekly-fee billing record (settlement history, Privacy Policy §6)',
  'MmgCheckoutIntent.createdByUserId': 'weekly-fee payment-confirmation history (settlement history, Privacy Policy §6)',
  'MmgCheckoutKey.createdByUserId': 'weekly-fee payment-confirmation history: the one-time key of a kept checkout (settlement history, Privacy Policy §6)',
  'AdRefundIntent.requestedByUserId': "settlement history of the advertiser's refunds (Privacy Policy §6)",
  'ChatRoomParticipant.userId': "order-scoped chat is kept with its order's record (Privacy Policy §6)",
  'ChatMessage.senderId': "order-scoped chat is kept with its order's record (Privacy Policy §6)",
  'Rating.raterId': 'the score stays in the other side\'s standing; the erasure strips the written comment and reply',
  'Rating.rateeId': 'the score stays in the other side\'s standing; the erasure strips the written comment and reply',
  'ItemFeedback.raterUserId': "a thumbs verdict on an item of a kept order (no text): it stays in the item's standing, like a rating's score",
  'ActorRatingStat.subjectId': 'the running summary of kept rating scores (no text)',
  'VerificationDocument.userId': 'each document is purged by the erasure (image, key and values shredded, receipt); the row is the custody record',
  'EncryptedObject.createdBy': 'the envelope of an uploaded file: the erasure shreds its key and deletes the object (custody record)',
  'AuditLog.userId': 'administrative actions leave a permanent trail (Privacy Policy §7); append-only',
  'AuditChainEntry.actorId': 'administrative actions leave a permanent trail (Privacy Policy §7); append-only',
  'AdsAuditLog.actorUserId': 'administrative actions leave a permanent trail (Privacy Policy §7)',
  'SafetyAccessLog.accessorUserId': 'access to production data is audit-logged (Privacy Policy §7)',
  'SensitiveReadLog.actorUserId': 'access to production data is audit-logged (Privacy Policy §7)',
  'SensitiveReadLog.subjectId': 'access to production data is audit-logged (Privacy Policy §7)',
  'AdCreative.reviewedByUserId': 'staff work: the reviewer of an ad (administrative trail, Privacy Policy §7)',
  'FxRate.setByUserId': 'staff work: who set a rate (administrative trail, Privacy Policy §7)',
  'PricingConfigVersion.createdBy': 'staff work: who published a price version (administrative trail, Privacy Policy §7)',
  'PromoTerms.createdBy': 'staff work: who published promo terms (administrative trail, Privacy Policy §7)',
  'StockAdjustment.createdBy': "a store's stock ledger: who adjusted stock (the store's business record)",
  'StockMovement.actorId': "a store's stock ledger: who moved stock (the store's business record)",
  'SupportTicket.resolvedById': 'staff work: who resolved a ticket (administrative trail, Privacy Policy §7)',
  'OpsAlertRecipient.userId': 'staff work: who was paged for an operations alert and who acknowledged it (administrative trail, Privacy Policy §7)',
  'CustodyRecoveryCase.ownerUserId': 'staff work: the staff member who owned a parcel recovery case (administrative trail, Privacy Policy §7)',
  'Advertiser.createdByUserId': "the business's record: a business closes through Support (Privacy Policy §6)",
  'VendorOwner.userId': "the business's record: the row holds only the link; a business closes through Support (Privacy Policy §6)",
  'ConsentRecord.subjectId': 'the consent ledger is kept as legal evidence after deletion (Privacy Policy §6); append-only',
  'DeletionReceipt.subjectId': 'the proof that a purge happened (Privacy Policy §6: the purge itself is logged); append-only',
  'DocLegalHold.subjectUserId': 'a legal hold outlives the account until it is released (DOC-1 §9.4)',
  'SafetyDeletionHold.userId': 'encrypted safety escrow kept after closure while a case is open (by design)',
  'StorageOrphan.userId': 'the open deletion obligations the erasure leaves to its retry sweep',
  'Subject.createdById': 'the document register index (the custody record of purged documents)',
  'SubjectLink.accountId': 'the document register index (the custody record of purged documents)',
  'DocumentRecord.accountId': 'the document register index (the custody record of purged documents)',
  'PersonProfile.accountId': 'the document register index (the custody record of purged documents)',
  'BusinessProfile.ownerAccountId': 'the document register index (the custody record of purged documents)',
  'AlgoDecision.subjectId': 'the log of automated dispatch and pricing steps (Privacy Policy §4); order and store ids, not the person',
};

/** Link -> what the rows hold and the question to the owner (PRIVACY ASK 19 Oct 00:01Z). May only shrink. */
export const ERASURE_UNDECIDED: Readonly<Record<string, string>> = {
  'Strike.userId': 'G1 fraud signal: strikes for fake or abusive orders carry a phone and an address key - keep de-identified, or keep for a stated fraud window',
  'MmgPayerEvidence.accountId': 'G1 fraud signal: a keyed hash of the paying MMG number - keep de-identified, or keep for a stated fraud window',
  'EnforcementAction.accountId': 'G1 fraud signal: enforcement decisions with the signals fired and the appeal note - keep de-identified, or keep for a stated fraud window',
  'TrialGrant.accountId': 'G1 fraud signal: the one-trial-per-identity grant - keep de-identified, or keep for a stated fraud window',
  'SupportTicket.userId': 'G2 case text: support history (incl. the closure ticket) - keep the row without its text, or keep the text for a stated window',
  'ComplianceViolation.userId': 'G2 case text: mover compliance checks with their evidence - keep the row without its text, or keep for a stated window',
  'ComplianceReviewCase.userId': 'G2 case text: compliance review cases with a note - keep the row without its text, or keep for a stated window',
  'RectificationRequest.userId': 'G2 case text: a data-subject rectification request with its note - keep the row without its text, or keep for a stated window',
  'ContentReport.reporterId': 'G2 case text: reports the person filed, with their detail - keep the row without its text, or keep for a stated window',
  'RatingReport.reporterId': 'G2 case text: rating reports the person filed, with a note - keep the row without its text, or keep for a stated window',
  'SosAlert.actorUserId': 'G3 safety record: SOS alerts with trigger location, address and note - hold rules, or a stated safety window',
  'SosAlert.counterpartyUserId': 'G3 safety record: SOS alerts naming the other party - hold rules, or a stated safety window',
  'SosRetrigger.counterpartyUserId': 'G3 safety record: SOS re-triggers naming the other party - hold rules, or a stated safety window',
  'TripSafetySession.passengerUserId': 'G3 safety record: trip safety sessions (risk, deviation, check-ins) - hold rules, or a stated safety window',
  'TripSafetySession.driverUserId': 'G3 safety record: trip safety sessions (risk, deviation, check-ins) - hold rules, or a stated safety window',
  'IncidentCase.subjectUserId': 'G3 safety record: incident cases with summary and details - hold rules, or a stated safety window',
  'IncidentCase.reporterUserId': 'G3 safety record: incident cases with summary and details - hold rules, or a stated safety window',
  'EvidenceBundle.subjectUserId': 'G3 safety record: sealed evidence bundles - hold rules, or a stated safety window',
  'FraudCase.subjectUserId': 'G3 safety record: confirmed fraud cases and their referral - hold rules, or a stated safety window',
};
