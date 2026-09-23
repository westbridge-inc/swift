/**
 * [NO-AI · trial integrity §2.1] ID_DOC_NUMBER is a HARD identity signal: it unions
 * accounts and can revoke a later trial. It used to be captured automatically from a
 * model's reading of an approved document. That path went with the model: no production
 * code captures ID_DOC_NUMBER any more, and the policy module that admitted model output
 * into the graph is deleted rather than left as an invitation.
 * What remains is the service-level guard that an empty signal never hashes or opens a
 * transaction.
 *
 * Consequence, recorded in the lane report: a reviewer-keyed ID_DOC_NUMBER capture is a
 * follow-up. Until it lands, duplicate-identity detection rests on PHONE, DEVICE, PLATE
 * and DOC_CONTENT (the file hash) alone.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { IdentityService } from '../modules/integrity/identity.service';

const API_SRC = join(__dirname, '..');
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (!['node_modules', 'dist', '__tests__'].includes(entry)) walk(full, out); }
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
};

describe('identity signal admission after the no-AI rule', () => {
  it('the model-output admission policy is gone, and no production code captures ID_DOC_NUMBER', () => {
    expect(existsSync(join(API_SRC, 'modules', 'verification', 'identity-signal-policy.ts'))).toBe(false);
    const capturing = walk(API_SRC)
      .filter((f) => /type:\s*'ID_DOC_NUMBER'/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(API_SRC, f));
    expect(capturing).toEqual([]);
    // The signal keeps its HARD strength, so a future reviewer-keyed capture inherits the law unchanged.
    expect(readFileSync(join(API_SRC, 'modules', 'integrity', 'identity.service.ts'), 'utf8')).toMatch(/ID_DOC_NUMBER:\s*'HARD'/);
  });

  it('refuses an empty normalized signal before hashing or opening a transaction', async () => {
    const transaction = vi.fn();
    const prisma = { $transaction: transaction } as unknown as PrismaClient;
    const result = await new IdentityService(prisma).capture({
      accountId: 'account-1',
      actorRole: 'CUSTOMER',
      type: 'ID_DOC_NUMBER',
      normalizedValue: '   ',
      source: 'HUMAN_REVIEW',
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
