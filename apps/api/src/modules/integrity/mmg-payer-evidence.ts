import { identityTransaction, lockIdentityAuthority } from './identity-review';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { normalizePhone, hashSignal } from './normalize';

/** Declaration and observed credit metadata are advisory. A successful payment
 * proves money movement, not that a requested/observed phone owns the wallet.
 * No supported MMG adapter returns an authenticated settled payer identity. */
export async function recordMmgPayerObservation(prisma: PrismaClient, input: {
  userId: string; role: string; payerMsisdn: string;
  tier: 'DECLARED' | 'OBSERVED_UNVERIFIED' | 'LEGACY_UNVERIFIED';
  source: 'BILLING_DECLARATION' | 'AGENT_CREDIT' | 'BACKFILL';
  subscriptionId?: string; observationId?: string;
}): Promise<void> {
  const normalized = normalizePhone(input.payerMsisdn);
  if (!normalized) return;
  const payerHash = hashSignal(normalized);
  await identityTransaction(prisma, async (tx) => {
    await lockIdentityAuthority(tx);
    const accounts = await tx.$queryRaw<Array<{ tenantId: string; status: string }>>`
      SELECT "tenantId", status FROM users WHERE id = ${input.userId} FOR SHARE
    `;
    const account = accounts[0];
    if (!account || ['DEACTIVATED', 'BANNED', 'SUSPENDED'].includes(account.status)) return;
    const data = { tenantId: account.tenantId, accountId: input.userId, actorRole: input.role,
      payerHash, tier: input.tier, source: input.source, subscriptionId: input.subscriptionId ?? null,
      observationId: input.observationId ?? null };
    const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    await tx.mmgPayerEvidence.upsert({ where: { digest }, create: { ...data, digest }, update: {} });
  });
}

/** Common admission barrier, including matching historical peers. Intentionally
 * empty until an authenticated returned-payer provider contract is implemented
 * and reviewed. A caller flag, source label or durable unverified row cannot
 * enable HARD identity. Do not fall back to the requested payer number. */
export function hasSupportedSettledPayerContract(_contract: string | null): boolean {
  return false;
}
