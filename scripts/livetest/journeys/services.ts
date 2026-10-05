// Services journeys [TASK-057]: SERV-01 (provider onboarding) and SERV-02
// (job → quote → schedule → confirm → complete). SP1 is verified in
// provisioning; SERV-01 onboards a fresh provider each run.

import type { Journey } from '../journey.js';
import { GET, POST, req, sleep, brief, pick, waitFor, notificationsOf } from './common.js';
import type { Ctx } from './context.js';
import { registerFresh } from './auth.js';
import { submitDoc, approveDoc } from '../provision.js';

/** Tomorrow (or `days` ahead) at hh:00 UTC — 13:00Z is 09:00 in Guyana (UTC−4). */
function slot(days: number, hourUtc: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

export const SERV_01: Journey<Ctx> = {
  id: 'SERV-01',
  estimateSeconds: 60,
  title: 'Provider onboarding',
  cases: 'provider join; canonical trade/docs; review; wrong trade denial',
  async run(rec, ctx) {
    const cat = await GET('/services/catalog');
    const trades = JSON.stringify(cat.json?.data ?? []);
    rec.check('the canonical trade catalogue is public', cat.ok && trades.includes('carpenter'), `→ ${brief(cat)}`);
    const acct = await registerFresh(ctx, 'serv01');
    rec.require('a fresh account to become a provider', !!acct, '');
    const s = acct!.session;
    rec.deny('an unknown trade', await POST('/services/providers', { trade: 'astronaut' }, s.token), [400], ['UNKNOWN_SERVICE_TRADE']);
    rec.deny('a trade not open yet', await POST('/services/providers', { trade: 'barber' }, s.token), [409], ['SERVICE_CATEGORY_UNAVAILABLE']);
    const join = await POST('/services/providers', { trade: 'carpenter', bio: 'Synthetic journey carpenter' }, s.token);
    rec.expect('join as a carpenter', join, [200, 201], undefined, `verified=${join.json?.data?.isVerified}`);
    rec.check('a new provider starts unverified', join.json?.data?.isVerified === false, '');
    rec.deny('a qualification for another trade', await POST('/services/providers/qualifications', { type: 'GEI_LICENCE' }, s.token), [400], ['QUALIFICATION_TRADE_MISMATCH']);
    const listBefore = await GET('/services/providers?trade=carpenter');
    rec.check('an unverified provider is not listed', !JSON.stringify(listBefore.json?.data ?? {}).includes(join.json?.data?.id ?? '§'), '');

    const st = (await GET('/verification/status?role=SERVICE_PROVIDER', s.token)).json?.data;
    const missing: string[] = st?.missing ?? [];
    rec.check('the provider checklist is published', missing.length >= 2, `missing=${JSON.stringify(missing)}`);
    const ids: Record<string, string> = {};
    for (const t of missing) {
      const d = await submitDoc(s, 'SERVICE_PROVIDER', t, 'serv01');
      if (rec.expect(`submit ${t}`, d.res, 201)) ids[t] = d.id!;
    }
    const queue = await GET('/admin/verification/queue?status=PENDING&role=customer&limit=50', ctx.admin.token);
    rec.check('the documents wait in the reviewer queue (customer lane)', Object.values(ids).every((id) => JSON.stringify(queue.json?.data ?? []).includes(id)), `→ ${brief(queue)}`);
    for (const t of missing) rec.expect(`the reviewer approves ${t}`, await approveDoc(ctx.admin, ids[t]!, t), 200);
    const me = (await GET('/services/providers/me', s.token)).json?.data;
    rec.check('the provider is verified by the review', me?.isVerified === true, `isVerified=${me?.isVerified}`);
    const listAfter = await GET('/services/providers?trade=carpenter');
    rec.check('the verified provider is listed to guests', JSON.stringify(listAfter.json?.data ?? {}).includes(me?.id ?? '§'), '');
    // Note (E24, not a ledger case here): high-risk trades have no trade-specific proof yet.
  },
};

export const SERV_02: Journey<Ctx> = {
  id: 'SERV-02',
  estimateSeconds: 60,
  title: 'Job → quote → schedule → confirm → complete',
  cases: 'request; quote; schedule; confirm; complete; slot race/timezone/retry',
  async run(rec, ctx) {
    const SP1 = ctx.roster.providers?.SP1;
    const providerId = ctx.world.providers.SP1;
    rec.require('SP1 is a verified provider', !!SP1 && !!providerId && !ctx.world.notReady.SP1, ctx.world.notReady.SP1 ?? '');
    const C1 = ctx.roster.customers.C1!.session, C2 = ctx.roster.customers.C2!.session, C3 = ctx.roster.customers.C3!.session;
    const p = SP1!.session;

    const job = await POST('/services/jobs', { providerId, description: `Fix a sticking door (journey ${ctx.runId})` }, C1.token);
    rec.expect('the customer requests a job', job, 201, undefined, `status=${job.json?.data?.status}`);
    const id = job.json?.data?.id;
    rec.require('a job id', !!id, '');
    rec.deny('a stranger cannot read the job', await GET(`/services/jobs/${id}`, C3.token), [403]);
    rec.deny('the customer cannot quote', await POST(`/services/jobs/${id}/quote`, { amount: 1000 }, C1.token), [403], ['PROVIDER_ONLY']);
    rec.deny('a provider cannot hire itself', await POST('/services/jobs', { providerId, description: 'Self job should be refused' }, p.token), [400], ['SELF_JOB']);
    rec.expect('the provider quotes', await POST(`/services/jobs/${id}/quote`, { amount: 45000 }, p.token), 200);
    rec.deny('the provider cannot schedule', await POST(`/services/jobs/${id}/schedule`, { scheduledFor: slot(1, 13) }, p.token), [403], ['CUSTOMER_ONLY']);
    rec.deny('a slot in the past', await POST(`/services/jobs/${id}/schedule`, { scheduledFor: slot(-1, 13) }, C1.token), [400], ['SLOT_IN_PAST']);
    const at = slot(1, 13);
    rec.expect('the customer schedules 13:00 UTC tomorrow', await POST(`/services/jobs/${id}/schedule`, { scheduledFor: at }, C1.token), 200);
    const toConfirm = await waitFor(async () => (await notificationsOf(p)).find((n) => JSON.stringify(n.data ?? {}).includes(id) && /confirm/i.test(`${n.title} ${n.body} ${n.data?.kind ?? ''}`)), 20_000);
    rec.check('the provider is asked to confirm, in Guyana time (9:00 AM)', !!toConfirm && /9:00\s?AM/i.test(`${toConfirm.body}`), `notice: ${toConfirm ? `${toConfirm.title} — ${toConfirm.body}` : 'none'}`);
    rec.deny('the customer cannot confirm for the provider', await POST(`/services/jobs/${id}/confirm`, {}, C1.token), [403]);
    rec.expect('the provider confirms', await POST(`/services/jobs/${id}/confirm`, {}, p.token), 200);
    const confirmed = await waitFor(async () => (await notificationsOf(C1)).find((n) => JSON.stringify(n.data ?? {}).includes(id) && /confirm/i.test(`${n.title} ${n.data?.kind ?? ''}`)), 20_000);
    rec.check('the customer is told it is confirmed', !!confirmed, confirmed ? confirmed.title : 'no notice');

    // slot race: two customers want the same hour with the same provider
    const mk = async (c: typeof C1, who: string) => {
      const j = await POST('/services/jobs', { providerId, description: `Race for a slot (${who}, ${ctx.runId})` }, c.token);
      const jid = j.json?.data?.id;
      await POST(`/services/jobs/${jid}/quote`, { amount: 20000 }, p.token);
      return jid as string;
    };
    const ja = await mk(C2, 'C2'), jb = await mk(C3, 'C3');
    const raceAt = slot(2, 14);
    const [ra, rb] = await Promise.all([
      POST(`/services/jobs/${ja}/schedule`, { scheduledFor: raceAt }, C2.token),
      POST(`/services/jobs/${jb}/schedule`, { scheduledFor: raceAt }, C3.token),
    ]);
    const winners = [ra, rb].filter((r) => r.ok).length;
    rec.check('two customers race one slot: one wins, one SLOT_TAKEN', winners === 1 && [ra, rb].some((r) => r.status === 409 && r.json?.error?.code === 'SLOT_TAKEN'), `→ ${brief(ra)} / ${brief(rb)}`);
    const loser = ra.ok ? { id: jb, s: C3 } : { id: ja, s: C2 };
    rec.expect('the loser retries an hour later and gets it', await POST(`/services/jobs/${loser.id}/schedule`, { scheduledFor: slot(2, 15) }, loser.s.token), 200);

    // complete and rate
    rec.deny('the customer cannot complete the job', await POST(`/services/jobs/${id}/complete`, {}, C1.token), [403]);
    rec.expect('the provider completes the job', await POST(`/services/jobs/${id}/complete`, {}, p.token), 200);
    rec.deny('completing twice', await POST(`/services/jobs/${id}/complete`, {}, p.token), [400], ['BAD_STATE']);
    const read = (await GET(`/services/jobs/${id}`, C1.token)).json?.data;
    rec.check('the job reads COMPLETED', read?.status === 'COMPLETED', `status=${read?.status}`);
    rec.expect('the customer rates the job', await POST(`/services/jobs/${id}/rate`, { score: 5, comment: 'journey' }, C1.token), [200, 201]);
    rec.deny('a second rating', await POST(`/services/jobs/${id}/rate`, { score: 4 }, C1.token), [409], ['ALREADY_RATED']);
    for (const [jid, s] of [[ja, C2], [jb, C3]] as const) await POST(`/services/jobs/${jid}/cancel`, {}, s.token);
    // Note: the visit reminder runs from the hourly :30 job and shares the Guyana-time formatter proven above.
    void req; void sleep; void pick;
  },
};

export const SERVICE_JOURNEYS = [SERV_01, SERV_02];
