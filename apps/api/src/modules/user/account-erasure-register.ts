/**
 * [GUARDRAILS §2 "honour deletion end to end" · REVIEW-F 18 Oct] THE ERASURE REGISTER.
 *
 * Every table that holds a person's id (a relation to User, or a `userId` column) says what the account
 * erasure (account.service deleteAccount and its passes) does with the person's rows:
 *  - ERASURE_CLEARED: the erasure deletes them (the census finds the delete in the erasure code);
 *  - ERASURE_KEPT: they stay, pointing at the de-identified account row, for the reason given;
 *  - ERASURE_UNDECIDED: measured on 18 Oct and not yet ruled. Each is a question to the coordinator,
 *    with the recommended answer; the list may only shrink.
 * account-erasure-register.test.ts reads the schema (Prisma DMMF): a new table that holds a person's id
 * is red there until it is put in one of these lists.
 */

/** Link (`Model.column`) -> the erasure step that deletes the person's rows. */
export const ERASURE_CLEARED: Readonly<Record<string, string>> = {
  'Session.userId': 'erasure transaction: access revoked with the authority cut-off',
  'DeviceToken.userId': 'erasure transaction: access revoked with the authority cut-off',
  'VerificationDecisionOutbox.userId': 'erasure transaction: work an approval still owed (no trial for a closed account)',
  'AdvertiserMember.userId': 'advertiser wind-down (seat removed)',
  'VendorStaff.userId': 'staff seats removed',
  'Address.userId': 'saved places dropped',
  'AccountRecovery.userId': 'ephemeral high-risk rows (NR-3 gap 6)',
  'LivenessCheck.userId': 'shift selfies: each row once its photo is confirmed gone (upload-erasure.ts)',
  'EmergencyContact.userId': 'ephemeral high-risk rows (NR-3 gap 6)',
  'Cart.customerId': 'ephemeral high-risk rows (NR-3 gap 6)',
  'CartMergeReceipt.userId': 'ephemeral high-risk rows (NR-3 gap 6)',
};

/** Link -> why the person's rows stay after erasure (they point at the de-identified account row). */
export const ERASURE_KEPT: Readonly<Record<string, string>> = {
  'Order.customerId': 'order history, kept for disputes, guarantees, tax and legal duties (Privacy Policy §6)',
  'ServiceJob.customerId': 'order history, kept for disputes, guarantees, tax and legal duties (Privacy Policy §6)',
  'Transaction.userId': 'settlement history (Privacy Policy §6)',
  'PayoutRequest.userId': 'settlement history (Privacy Policy §6)',
  'PayoutSchedule.userId': 'settlement history (Privacy Policy §6)',
  'BillingFeeNotice.userId': 'weekly-fee billing record (settlement history, Privacy Policy §6)',
  'MoverFeeSubscription.userId': 'weekly-fee billing record (settlement history, Privacy Policy §6)',
  'MoverFeeAuthority.userId': 'weekly-fee billing record (settlement history, Privacy Policy §6)',
  'MoverFeeAuthority.tenantId': 'weekly-fee billing record (settlement history, Privacy Policy §6)',
  'ChatRoomParticipant.userId': "order-scoped chat is kept with its order's record (Privacy Policy §6)",
  'Rating.raterId': 'the score stays in the other side\'s standing; the erasure strips the written comment and reply',
  'Rating.rateeId': 'the score stays in the other side\'s standing; the erasure strips the written comment and reply',
  'VerificationDocument.userId': 'each document is purged by the erasure (image, key and values shredded, receipt); the row is the custody record',
  'AuditLog.userId': 'administrative actions leave a permanent trail (Privacy Policy §7); append-only',
  'DocLegalHold.subjectUserId': 'a legal hold outlives the account until it is released (DOC-1 §9.4)',
  'SafetyDeletionHold.userId': 'encrypted safety escrow kept after closure while a case is open (by design)',
  'StorageOrphan.userId': 'the open deletion obligations the erasure leaves to its retry sweep',
  'Subject.createdById': 'the document register index (the custody record of purged documents)',
  'SubjectLink.accountId': 'the document register index (the custody record of purged documents)',
};

/** Link -> what the rows hold and the recommended ruling. Measured 18 Oct; may only shrink. */
export const ERASURE_UNDECIDED: Readonly<Record<string, string>> = {
  'Notification.userId': 'in-app notices (titles and bodies can name orders and people) - recommend: delete at erasure',
  'PaymentInstrument.userId': 'saved payment methods - recommend: delete at erasure once no open refund needs one',
  'CardSession.userId': 'card checkout sessions - recommend: delete at erasure',
  'MoneySurfaceCommand.userId': 'pending payout/payment-setting changes - recommend: delete at erasure',
  'MoverRevocationOutbox.userId': 'queued mover access changes - recommend: delete at erasure, like the decision outbox',
  'GuardianCheckinDelivery.userId': 'delivery attempts of safety check-in messages - recommend: delete at erasure',
  'CheckoutReceipt.userId': 'checkout replay records - recommend: delete at erasure, like CartMergeReceipt',
  'Customer.userId': 'order totals and referral code/referredBy - recommend: keep totals, clear the referral link',
  'Rider.userId': 'document pointers are cleared; the profile row (vehicle, plate, photos) stays - recommend: de-identify',
  'Driver.userId': 'document pointers are cleared; the profile row (vehicle, plate, photos) stays - recommend: de-identify',
  'ServiceProvider.userId': 'unverified at erasure; portfolio photos are deleted (stored objects via storage_orphans, then the pointers cleared); the profile row (bio) stays - recommend: de-identify',
  'VendorOwner.userId': 'a business closes through Support - recommend: confirm what the owner row keeps after closure',
  'Admin.userId': 'staff permissions - recommend: delete when the staff member leaves',
  'OpsAlertRecipient.userId': 'staff alert routing - recommend: delete when the staff member leaves',
  'SupportTicket.userId': 'support history (incl. the closure ticket) - recommend: keep for a stated window',
  'SupportTicket.resolvedById': 'tickets resolved as staff - recommend: keep (staff work)',
  'Strike.userId': 'strikes for fake or abusive orders - recommend: keep for a stated fraud window',
  'ComplianceViolation.userId': 'mover compliance checks - recommend: keep for a stated window',
  'ComplianceReviewCase.userId': 'compliance review cases - recommend: keep for a stated window',
  'MmgPayerEvidence.accountId': 'payer fraud signals - recommend: keep for a stated fraud window',
  'RectificationRequest.userId': 'a data-subject rectification request - recommend: keep as the rights-request record',
};
