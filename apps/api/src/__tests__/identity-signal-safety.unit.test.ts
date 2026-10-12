import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { IdentityService } from '../modules/integrity/identity.service';
import { approvedIdentityDocumentNumber, reviewerTypedDocumentSignal, reviewerTypedFields } from '../modules/verification/identity-signal-policy';

describe('identity signal admission policy', () => {
  it.each([
    ['national_id', ' 154-829-063 ', '154829063'],
    ['owner_national_id', 'ab 12-34', 'AB1234'],
    ['passport', ' pa-009 ', 'PA009'],
    ['identity_l2', ' l2-123 ', 'L2123'],
  ])('admits a declared identity identifier for %s', (docType, raw, expected) => {
    expect(approvedIdentityDocumentNumber(docType, 'APPROVED', raw)).toBe(expected);
  });

  // [VERIFY-DOCS · coordinator ruling 6 Oct 2026 — a DELIBERATE change, read
  // the next describe] This processor path still refuses `drivers_licence`: a
  // processor's generic `documentNumber` on a licence may be ANY number printed
  // on it. A licence number does now become a duplicate-account signal — but
  // only when a REVIEWER types the licence number itself at approval, and in
  // its own `DL:` namespace (reviewerTypedDocumentSignal below).
  it.each([
    'vehicle_registration',
    'vehicle_insurance',
    'drivers_licence',
    'hire_car_permit',
    'business_registration',
  ])('does not misclassify a %s number as a person identity', (docType) => {
    expect(approvedIdentityDocumentNumber(docType, 'APPROVED', 'AB-1234')).toBeNull();
  });

  it.each(['PENDING', 'REJECTED'])('does not trust %s OCR as HARD identity evidence', (status) => {
    expect(approvedIdentityDocumentNumber('national_id', status, '154-829-063')).toBeNull();
  });

  it('drops a punctuation-only identity number before capture', () => {
    expect(approvedIdentityDocumentNumber('national_id', 'APPROVED', '---')).toBeNull();
  });

  it('refuses an empty normalized signal before hashing or opening a transaction', async () => {
    const transaction = vi.fn();
    const prisma = { $transaction: transaction } as unknown as PrismaClient;
    const result = await new IdentityService(prisma).capture({
      accountId: 'account-1',
      actorRole: 'CUSTOMER',
      type: 'ID_DOC_NUMBER',
      normalizedValue: '   ',
      source: 'AI_ID_ANALYZER',
    });

    expect(result).toEqual({
      strength: 'HARD',
      matchedAccountIds: [],
      merged: false,
      clusterId: null,
      dropped: true,
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('[VERIFY-DOCS] numbers a reviewer types at approval', () => {
  it.each([
    ['national_id', ' 154-829-063 ', '154829063'],
    ['owner_national_id', 'ab 12-34', 'AB1234'],
    ['passport', ' pa-0091 ', 'PA0091'],
    ['identity_l2', ' l2-1234 ', 'L21234'],
  ])('an identity number keeps the same value as an extracted one (%s)', (docType, raw, expected) => {
    expect(reviewerTypedDocumentSignal(docType, raw)).toBe(expected);
  });

  it('a typed driver’s licence number is a signal, in its own namespace — never equal to an ID number of the same characters', () => {
    expect(reviewerTypedDocumentSignal('drivers_licence', ' l-123 45 ')).toBe('DL:L12345');
    expect(reviewerTypedDocumentSignal('national_id', 'L12345')).toBe('L12345');
  });

  it.each(['vehicle_registration', 'vehicle_insurance', 'hire_car_permit', 'business_registration', 'police_clearance'])(
    'a %s number is never a person identity, typed or not', (docType) => {
      expect(reviewerTypedDocumentSignal(docType, 'AB-123456')).toBeNull();
    });

  it('a number too short to identify anyone is no signal', () => {
    expect(reviewerTypedDocumentSignal('national_id', '1-2')).toBeNull();
    expect(reviewerTypedDocumentSignal('drivers_licence', '---')).toBeNull();
  });

  it('the console is told what to ask for, per type', () => {
    expect(reviewerTypedFields('national_id')).toEqual(['documentNumber']);
    expect(reviewerTypedFields('drivers_licence')).toEqual(['documentNumber']);
    expect(reviewerTypedFields('police_clearance')).toEqual(['issuedOn']);
    expect(reviewerTypedFields('business_registration')).toEqual([]);
  });
});
