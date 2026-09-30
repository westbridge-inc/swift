// [STG-DRILLS D2/D3] A drill store's weekly bill, settled by agent cash.
//
// deploy/drill-fixtures.sh made the store on the server with a trial that
// ended 15 days ago; the REAL conversion and billing jobs then billed it
// (deploy/drill-run-job.sh convert-trials billing-cycle, or the schedule).
// Here, over HTTP only: the owner reads the bill, an agent-cash receipt for the
// exact amount due is recorded by two operators (ADM-005), the instant re-bill
// spends it on the owed week, and the same receipt again credits nothing.
// VEND-04 and MONEY-03 each settle their OWN drill store, so neither journey
// consumes the bill the other needs.

import { login, type Session } from '../client.js';
import type { Recorder } from '../journey.js';
import type { DrillBillingStore } from '../drills.js';
import { GET, brief } from './common.js';
import { twoPerson } from './admin-util.js';
import type { Ctx } from './context.js';

const WEEK_MS = 7 * 86_400_000;

export async function settleDrillBill(rec: Recorder, ctx: Ctx, store: DrillBillingStore, tag: 'V04' | 'M03'): Promise<void> {
  let owner: Session | null = null;
  try {
    owner = await login(store.phone);
  } catch (e: any) {
    rec.require('the drill store owner signs in (dev code, private instance)', false, `${store.phone}: ${String(e?.message ?? e).slice(0, 200)}`);
    return;
  }
  const read = async () => {
    const r = await GET('/vendor/subscription', owner!.token);
    return { r, sub: r.json?.data };
  };

  const billed = await read();
  const b = billed.sub;
  const due = Number(b?.amountDueGyd ?? 0);
  const notYet = b?.status === 'TRIAL' ? ' — not billed yet: run ./deploy/drill-run-job.sh convert-trials billing-cycle before the journeys' : '';
  rec.require(
    `the drill store ${store.vendorName} was billed by the real billing job: its week is due and a cash charge failed on the empty wallet`,
    billed.r.ok && b?.id === store.subscriptionId && b?.status === 'PAST_DUE' && Number(b?.failedAttempts) >= 1 && due > 0 && Number(b?.walletBalanceGyd) === 0 && b?.san === store.san,
    `→ ${brief(billed.r)} status=${b?.status} failedAttempts=${b?.failedAttempts} due=${b?.amountDueGyd} wallet=${b?.walletBalanceGyd} san=${b?.sanFormatted ?? b?.san}${notYet}`,
  );

  const receipt = {
    san: String(store.san),
    amount: due,
    paidAt: new Date().toISOString(),
    receiptNumber: `${ctx.drill!.marker}-${tag}`.slice(0, 64),
    verifiedInPortal: true,
  };
  const pay = await twoPerson(rec, ctx, `record the drill store's agent-cash receipt for the week due (${tag})`, 'POST', '/admin/billing/agent-payments', receipt);
  if (!pay.done) return; // held for a second admin that this target lacks (recorded as SKIP), or refused (recorded as FAIL)
  rec.check('the receipt is accepted and credited to the drill store', pay.final?.json?.data?.status === 'accepted' && pay.final?.json?.data?.subscriptionId === store.subscriptionId,
    `status=${pay.final?.json?.data?.status} subscription=${pay.final?.json?.data?.subscriptionId}`);

  const paid = (await read()).sub;
  const moved = Date.parse(paid?.nextBillingDate) - Date.parse(b?.nextBillingDate);
  rec.check('the bill is settled: the instant re-bill spent the cash on the owed week and the store is reinstated',
    paid?.status === 'ACTIVE' && Number(paid?.failedAttempts) === 0 && Number(paid?.walletBalanceGyd) === 0 && moved === WEEK_MS,
    `status=${paid?.status} failedAttempts=${paid?.failedAttempts} wallet=${paid?.walletBalanceGyd} next bill moved ${Math.round(moved / 86_400_000)} day(s)`);

  const replay = await twoPerson(rec, ctx, `record the same agent-cash receipt again (${tag})`, 'POST', '/admin/billing/agent-payments', receipt);
  const after = (await read()).sub;
  const answer = replay.final?.json?.data?.status;
  rec.check('the same receipt again credits nothing: the answer names the duplicate and the bill does not move',
    replay.done && ['duplicate', 'reconciled'].includes(answer) && after?.status === 'ACTIVE' && Number(after?.walletBalanceGyd) === Number(paid?.walletBalanceGyd) && after?.nextBillingDate === paid?.nextBillingDate,
    `→ ${replay.final ? brief(replay.final) : 'held'} status=${answer ?? '-'} wallet ${paid?.walletBalanceGyd} → ${after?.walletBalanceGyd}, next bill ${paid?.nextBillingDate} → ${after?.nextBillingDate}`);
}
