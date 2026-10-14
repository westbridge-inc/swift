/**
 * [MMG REVERSAL · owner decision #11] The owner's UAT check of a whole-payment
 * reversal, run against MMG's TEST system only (no real money).
 *
 * The owner runs it from a local command that makes a small UAT checkout
 * payment first and asks for MMG's merchant credentials at hidden prompts. This script then uses EXACTLY the code the
 * production reversal uses — the live MMG adapter's reverseTransaction and
 * transactionLookupDetail, and the same lookup-proof rule (mmg-reversal-proof.ts)
 * — and prints what MMG answered and what Swift would record.
 *
 *   tsx scripts/mmg-reversal-uat.ts --txn <MMG transaction id> [--yes] [--try-ledger]
 *
 * Credentials come from the environment the .command sets (MMG_API_KEY,
 * MMG_MERCHANT_ID, MMG_PASSWORD, MMG_MKEY, MMG_MSECRET) and are never printed.
 * It refuses anything but MMG's UAT address, and refuses NODE_ENV=production.
 * Printed: MMG's status words, amounts, dates and transaction references only —
 * never a credential, a token, or the payer's number.
 */
import { createInterface } from 'node:readline/promises';
import { appendFileSync } from 'node:fs';
import { LiveMmgProvider, MMG_UAT_URL, type MmgLookupDetail, type MmgTxResult } from '../src/providers/mmg/mmg-provider';
import { lookupProof, verdictOf } from '../src/modules/billing/mmg-reversal-proof';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

function fail(message: string): never {
  console.error(`\nSTOPPED: ${message}`);
  process.exit(2);
}

/** What may be shown of a lookup: status words, amount, dates, references. */
function safe(detail: MmgLookupDetail): Record<string, unknown> {
  if (detail.outcome !== 'found') return { outcome: detail.outcome, ...(detail.outcome === 'error' ? { reason: detail.reason.slice(0, 160) } : {}) };
  return {
    outcome: 'found', status: detail.status, statusText: detail.statusText, amountMinor: detail.amountMinor,
    currency: detail.currencyCode, created: detail.createdAt, mmgLedgerReference: detail.ledgerReference,
    transactionType: typeof detail.raw['transactionType'] === 'string' ? detail.raw['transactionType'] : null,
    type: typeof detail.raw['type'] === 'string' ? detail.raw['type'] : null,
  };
}
const answerWords = (a: MmgTxResult) => ({ status: a.status, reference: a.transactionId || null, reason: a.reason?.slice(0, 160) ?? null });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') fail('this is a UAT check; it never runs in production.');
  const baseUrl = process.env['MMG_API_URL'] || MMG_UAT_URL;
  if (!/mmgtest/i.test(baseUrl)) fail("only MMG's UAT (test) address is allowed here.");
  const cfg = {
    baseUrl,
    apiKey: process.env['MMG_API_KEY'] ?? '', merchantMsisdn: process.env['MMG_MERCHANT_ID'] ?? '',
    password: process.env['MMG_PASSWORD'] ?? '', mkey: process.env['MMG_MKEY'] ?? '', msecret: process.env['MMG_MSECRET'] ?? '',
  };
  const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) fail(`MMG test credentials missing (${missing.join(', ')}). Run it from the .command, which asks for them.`);
  const txn = arg('txn');
  if (!txn || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(txn)) fail('give the MMG transaction id: --txn <id>');
  const mmg = new LiveMmgProvider(cfg);
  const results: Record<string, unknown> = { when: new Date().toISOString(), txn };

  console.log('\n1) MMG lookup of the payment, BEFORE the return:');
  const before = await mmg.transactionLookupDetail(txn);
  console.log('  ', JSON.stringify(safe(before)));
  results['before'] = safe(before);
  if (before.outcome !== 'found') fail("MMG's lookup does not find this payment; nothing was asked.");
  if (before.status !== 'approved') fail(`MMG reports this payment as "${before.statusText}", not successful; nothing was asked.`);
  if (before.amountMinor === null || before.currencyCode !== 'GYD') fail("MMG's answer has no exact GYD amount; nothing was asked.");
  const row = { mmgTransactionId: txn, providerReference: null as string | null, amount: before.amountMinor / 100, currencyCode: 'GYD' };

  if (!flag('yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await rl.question(`\nType YES to ask MMG's TEST system to return this whole payment (GYD ${row.amount}): `)).trim();
    rl.close();
    if (typed !== 'YES') fail('not confirmed; nothing was asked.');
  }

  console.log('\n2) Asking MMG to reverse it (by the transaction id MMG gave the checkout):');
  const answer = await mmg.reverseTransaction({ transactionId: txn });
  console.log('  ', JSON.stringify(answerWords(answer)));
  results['answer'] = answerWords(answer);
  if (answer.status === 'pending' || answer.status === 'reversed') row.providerReference = answer.transactionId || null;

  if (answer.status === 'declined' && flag('try-ledger') && before.ledgerReference && before.ledgerReference !== txn) {
    console.log("\n   MMG refused by the checkout's transaction id; trying MMG's own ledger number for the same payment:");
    const byLedger = await mmg.reverseTransaction({ transactionId: before.ledgerReference });
    console.log('  ', JSON.stringify(answerWords(byLedger)));
    results['answerByLedgerNumber'] = answerWords(byLedger);
    if (byLedger.status === 'pending' || byLedger.status === 'reversed') row.providerReference = byLedger.transactionId || null;
  }

  console.log("\n3) Waiting 10 seconds, then MMG's lookup AFTER the return:");
  await sleep(10_000);
  const after = await mmg.transactionLookupDetail(txn);
  console.log('   payment:', JSON.stringify(safe(after)));
  results['after'] = safe(after);
  if (row.providerReference && row.providerReference !== txn) {
    const reversal = await mmg.transactionLookupDetail(row.providerReference);
    console.log('   the reversal MMG named:', JSON.stringify(safe(reversal)));
    results['reversalLookup'] = safe(reversal);
  }

  const proof = await lookupProof(mmg, row);
  const verdict = verdictOf(proof, answer);
  console.log(`\n4) SWIFT WOULD RECORD: ${verdict.state}${verdict.detail ? ` (${verdict.detail})` : ''}`);
  results['swiftWouldRecord'] = verdict;
  const log = process.env['UAT_RESULTS_LOG'];
  if (log) appendFileSync(log, `${JSON.stringify(results)}\n`);
}

main().catch((err) => fail(`unexpected error: ${(err as Error).message.slice(0, 200)}`));
