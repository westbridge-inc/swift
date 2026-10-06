import type { Prisma, SubscriptionPayment } from '@prisma/client';
import type { MmgTransaction } from '../../providers/mmg/mmg-provider';

export type MmgTerminalStatus = 'declined' | 'expired' | 'reversed';
export function isMmgTerminalStatus(status: unknown): status is MmgTerminalStatus {
  return status === 'declined' || status === 'expired' || status === 'reversed';
}
export function paymentFacts(payment: Pick<SubscriptionPayment, 'id' | 'subscriptionId' | 'externalRef' | 'clientKey' | 'amount' | 'periodStart' | 'periodEnd'>) {
  return { paymentId: payment.id, subscriptionId: payment.subscriptionId, transactionId: payment.externalRef,
    reference: payment.clientKey, amountMinor: Math.round(Number(payment.amount) * 100),
    periodStart: payment.periodStart.toISOString(), periodEnd: payment.periodEnd.toISOString() };
}
export function mmgPaymentRaw(payment: { failureRaw: Prisma.JsonValue | null }): Prisma.JsonObject {
  return payment.failureRaw && typeof payment.failureRaw === 'object' && !Array.isArray(payment.failureRaw) ? payment.failureRaw : {};
}
/** Lookup evidence is exact. A missing response field never borrows our request
 * value. GY/GYD is the existing, explicit legacy MMG currency equivalence. */
export function mmgNegativeMatches(payment: SubscriptionPayment, currency: string | null, evidence: MmgTransaction): boolean {
  const expected = paymentFacts(payment);
  const sameCurrency = (value: string) => value === 'GY' ? 'GYD' : value;
  return isMmgTerminalStatus(evidence.status) && typeof evidence.transactionId === 'string'
    && !!expected.transactionId && evidence.transactionId === expected.transactionId
    && typeof evidence.reference === 'string' && !!expected.reference && evidence.reference === expected.reference
    && Number.isSafeInteger(evidence.amountMinor) && evidence.amountMinor > 0 && evidence.amountMinor === expected.amountMinor
    && typeof evidence.currencyCode === 'string' && !!currency && sameCurrency(evidence.currencyCode) === sameCurrency(currency);
}
/** The generation token changes before every remote lookup. Fresh facts and
 * positive observations are also checked under the payment lock by callers. */
export type MmgLookupObservation = { generation: string; facts: ReturnType<typeof paymentFacts>; evidence: MmgTransaction };
export function matchesLookupGeneration(payment: SubscriptionPayment, observation: MmgLookupObservation): boolean {
  return mmgPaymentRaw(payment)['mmgLookupGeneration'] === observation.generation
    && JSON.stringify(paymentFacts(payment)) === JSON.stringify(observation.facts);
}
export function mmgTerminalProof(payment: SubscriptionPayment, currency: string, evidence: MmgTransaction,
  source: 'LOOKUP' | 'INITIATE', generation: string, now: Date): Prisma.InputJsonObject {
  return { version: 1, provider: 'MMG', source, ...paymentFacts(payment), currencyCode: currency,
    status: evidence.status, generation, observedAt: now.toISOString(),
    observation: { transactionId: evidence.transactionId, reference: evidence.reference!, amountMinor: evidence.amountMinor,
      currencyCode: evidence.currencyCode, status: evidence.status } };
}
/** Historical status/failure text is not proof. Only this versioned, bound
 * record (or a separately checked finance resolution) can repair dunning. */
export function hasMmgTerminalProof(payment: SubscriptionPayment, currency: string | null): boolean {
  const raw = mmgPaymentRaw(payment);
  if (payment.paidAt || raw['providerOutcome'] === 'CAPTURED' || ['SETTLEMENT_MISMATCH', 'HISTORY_APPROVAL_UNVERIFIED'].includes(payment.failureCode ?? '')) return false;
  const proof = raw['mmgTerminalEvidence'];
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof['version'] !== 1
    || proof['provider'] !== 'MMG' || !isMmgTerminalStatus(proof['status']) || !currency
    || proof['currencyCode'] !== currency || typeof proof['observedAt'] !== 'string'
    || !Number.isFinite(Date.parse(proof['observedAt'])) || Date.parse(proof['observedAt']) < payment.createdAt.getTime()) return false;
  for (const [key, value] of Object.entries(paymentFacts(payment))) if (proof[key] !== value) return false;
  if (proof['source'] === 'LOOKUP') {
    const observation = proof['observation'];
    return typeof proof['generation'] === 'string' && proof['generation'].length > 0
      && !!observation && typeof observation === 'object' && !Array.isArray(observation)
      && observation['status'] === proof['status'] && mmgNegativeMatches(payment, currency, observation as unknown as MmgTransaction);
  }
  const observation = proof['observation'];
  return proof['source'] === 'INITIATE' && !!observation && typeof observation === 'object' && !Array.isArray(observation)
    && observation['reference'] === payment.clientKey && observation['amountMinor'] === paymentFacts(payment).amountMinor
    && observation['currencyCode'] === currency && observation['status'] === proof['status'] && payment.externalRef === null
    && typeof raw['authorizedAt'] === 'string' && proof['generation'] === raw['authorizedAt']
    && raw['providerEffect'] === 'AUTHORIZED' && !!payment.clientKey;
}
