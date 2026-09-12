import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { IdentityService } from '../modules/integrity/identity.service';
import { approvedIdentityDocumentNumber } from '../modules/verification/identity-signal-policy';

describe('identity signal admission policy', () => {
  it.each([
    ['national_id', ' 154-829-063 ', '154829063'],
    ['owner_national_id', 'ab 12-34', 'AB1234'],
    ['passport', ' pa-009 ', 'PA009'],
    ['identity_l2', ' l2-123 ', 'L2123'],
  ])('admits a declared identity identifier for %s', (docType, raw, expected) => {
    expect(approvedIdentityDocumentNumber(docType, 'APPROVED', raw)).toBe(expected);
  });

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
