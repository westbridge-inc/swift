// Money journeys [TASK-057]: MONEY-01..03. Swift is SaaS: order money moves
// person to person (cash, or the store's own MMG link); only the weekly
// partner fee is Swift's, collected by agent cash or MMG merchant billing.

import { createHmac } from 'node:crypto';
import type { Journey } from '../journey.js';
import { GET, POST, PUT, req, brief, pick, placeOrder, orderIdsOf, customerOrder, idemKey, codeOf } from './common.js';
import type { Ctx } from './context.js';
import { twoPerson } from './admin-util.js';

export const MONEY_01: Journey<Ctx> = {
  id: 'MONEY-01',
  estimateSeconds: 30,
  title: 'Cash-only guardrail (no card, no Swift custody)',
  cases: 'cash succeeds; card/bank denied; no Swift order-money custody',
  async run(rec, ctx) {
    const C4 = ctx.roster.customers.C4!, OV1 = ctx.roster.vendors.OV1!, item = ctx.world.items.OV1;
    rec.require('OV1 orderable', !!item, ctx.world.notReady.OV1 ?? '');
    for (const method of ['CARD', 'BANK_TRANSFER', 'WALLET']) {
      const r = await placeOrder(C4.session, OV1.vendorId!, item!.itemId, OV1.lat, OV1.lng, { payment: method, pickup: true });
      rec.deny(`order payment by ${method}`, r, [400], ['VALIDATION_ERROR']);
    }
    const cash = await placeOrder(C4.session, OV1.vendorId!, item!.itemId, OV1.lat, OV1.lng, { pickup: true, key: idemKey(ctx.runId, 'money01') });
    rec.expect('a cash order succeeds', cash, [200, 201]);
    const id = orderIdsOf(cash)[0];
    rec.check('the checkout hands the customer no Swift payment step', !cash.json?.data?.paymentAction, `paymentAction=${JSON.stringify(cash.json?.data?.paymentAction ?? null)}`);
    const o = id ? await customerOrder(C4.session, id) : null;
    rec.check('the order is cash, payable to the store/rider in person', o?.paymentMethod === 'CASH' && o?.paymentStatus === 'PENDING' && !o?.paymentAction,
      `paymentMethod=${o?.paymentMethod} paymentStatus=${o?.paymentStatus} paymentAction=${JSON.stringify(o?.paymentAction ?? null)}`);
    const claim = id ? await POST(`/customer/orders/${id}/payment-claim`, { paid: true }, C4.session.token) : null;
    if (claim) rec.deny('no wallet claim exists on a cash order', claim, [409], ['NOT_A_WALLET_ORDER']);
    const cart = await GET('/customer/cart', C4.session.token);
    const caps = cart.json?.data?.paymentCapabilities;
    rec.check('the cart offers no card rail', !caps || caps?.card?.available !== true, `paymentCapabilities=${JSON.stringify(caps ?? null)}`);
    const mix = await GET('/admin/finance/payment-mix', ctx.admin.token);
    rec.expect('the operator’s payment mix is readable', mix, 200, undefined, JSON.stringify(mix.json?.data ?? null).slice(0, 200));
    rec.deny('a customer cannot read the payment mix', await GET('/admin/finance/payment-mix', C4.session.token), [403]);
    if (id) rec.expect('the cash order cancels (cleanup)', await POST(`/customer/orders/${id}/cancel`, { reason: 'journey cleanup' }, C4.session.token), 200);
  },
};

export const MONEY_02: Journey<Ctx> = {
  id: 'MONEY-02',
  estimateSeconds: 30,
  title: 'Vendor MMG pay-link rail (Swift holds nothing)',
  cases: 'vendor pay link; claim; duplicate; mismatch; expiry and recovery',
  async run(rec, ctx) {
    const C2 = ctx.roster.customers.C2!, R1 = ctx.roster.vendors.R1!, item = ctx.world.items.R1;
    rec.require('R1 orderable', !!item, ctx.world.notReady.R1 ?? '');
    const mmg = await placeOrder(C2.session, R1.vendorId!, item!.itemId, R1.lat, R1.lng, { payment: 'MOBILE_MONEY', pickup: true });
    rec.deny('MMG checkout when the store holds no pay link', mmg, [400, 503], ['MMG_NOT_AVAILABLE', 'MMG_PAY_LINKS_NOT_CONFIGURED']);
    const cash = await placeOrder(C2.session, R1.vendorId!, item!.itemId, R1.lat, R1.lng, { pickup: true, key: idemKey(ctx.runId, 'money02-cash') });
    const id = orderIdsOf(cash)[0];
    if (id) {
      rec.deny('the store cannot attest an MMG payment on a cash order', await POST(`/vendor/orders/${id}/confirm-payment`, { reference: 'MMG12345' }, R1.session.token), [400, 404], ['NOT_MMG', 'NOT_FOUND']);
      await POST(`/customer/orders/${id}/cancel`, { reason: 'journey cleanup' }, C2.session.token);
    }
    const set = await PUT('/vendor/profile', { mmgPayUrl: 'https://pay.example.invalid/store' }, R1.session.token);
    rec.deny('a pay link cannot be set without a fresh step-up', set, [400, 403, 503], ['STEP_UP_REQUIRED', 'INVALID_MMG_PAY_URL', 'MMG_PAY_LINKS_NOT_CONFIGURED']);
    rec.skipAll(`every case needs a store with a live MMG pay link; setting one needs a step-up whose code reaches the owner only by SMS (the dev OTP code does not apply)${codeOf(set) === 'MMG_PAY_LINKS_NOT_CONFIGURED' ? ', and pay links are not configured on this target (MMG_PAY_URL_ALLOWED_HOSTS)' : ''}. Every order-side MMG step is an attestation record (no provider call), so Phase B needs Twilio for the step-up, not an MMG round-trip`);
  },
};

export const MONEY_03: Journey<Ctx> = {
  id: 'MONEY-03',
  estimateSeconds: 45,
  title: 'Weekly fee via agent cash / MMG merchant billing',
  cases: 'bill; signed agent receipt; duplicate/bad signature; disabled channel',
  async run(rec, ctx) {
    const R1 = ctx.roster.vendors.R1!;
    const sub = (await GET('/vendor/subscription', R1.session.token)).json?.data;
    rec.check('the store has a weekly-fee account (SAN) and rate', !!sub?.san && Number(sub?.weeklyFeeGyd ?? sub?.weeklyRate) > 0, `status=${sub?.status} san=${sub?.sanFormatted ?? sub?.san} weekly=${sub?.weeklyFeeGyd ?? sub?.weeklyRate}`);
    const body = JSON.stringify({ transactionId: `SYN-${ctx.runId}`, accountNumber: String(sub?.san ?? ''), amount: 1000, currency: 'GYD' });
    const unsigned = await req('POST', '/billing/mmg/agent-notification', { body: JSON.parse(body) });
    const dark = unsigned.status === 503;
    rec.check('an unsigned agent-cash notification is refused', dark || unsigned.status === 401, `→ ${unsigned.status} ${unsigned.text.slice(0, 120)}`);
    // A signature made with a key the runner invents can never be the channel's.
    const ts = String(Date.now());
    const forged = createHmac('sha256', `not-the-secret-${ctx.runId}`).update(`${ts}.${body}`).digest('hex');
    const bad = await req('POST', '/billing/mmg/agent-notification', { body: JSON.parse(body), headers: { 'x-swift-timestamp': ts, 'x-swift-signature': forged } });
    rec.deny('a notification with a bad signature', bad, dark ? [503] : [401]);
    const stale = await req('POST', '/billing/mmg/agent-notification', { body: JSON.parse(body), headers: { 'x-swift-timestamp': String(Date.now() - 3_600_000), 'x-swift-signature': forged } });
    rec.deny('a notification with a stale timestamp', stale, dark ? [503] : [401]);
    if (dark) rec.step('disabled channel: the agent-cash webhooks answer 503 channel_disabled', true, 'AGENT_CASH_WEBHOOK_SECRET is not configured on this target, so the channel is dark by design');
    const inq = await req('POST', '/billing/mmg/inquiry', { body: { accountNumber: String(sub?.san ?? '') } });
    rec.check('the agent inquiry is gated the same way', inq.status === (dark ? 503 : 401), `→ ${inq.status}`);

    // A manual agent receipt recorded by operators (two people), then the same receipt again.
    const receipt = { san: String(sub?.san ?? ''), amount: 1000, paidAt: new Date().toISOString(), receiptNumber: `SYN-${ctx.runId}`.slice(0, 60), verifiedInPortal: true };
    const before = Number(sub?.walletBalanceGyd ?? 0);
    const first = await twoPerson(rec, ctx, 'record a synthetic agent-cash receipt', 'POST', '/admin/billing/agent-payments', receipt);
    if (first.done) {
      const after = Number((await GET('/vendor/subscription', R1.session.token)).json?.data?.walletBalanceGyd ?? 0);
      rec.check('the receipt credits the store’s fee wallet once', after === before + 1000, `wallet ${before} → ${after}`);
      const dup = await twoPerson(rec, ctx, 'record the same synthetic receipt again', 'POST', '/admin/billing/agent-payments', receipt);
      rec.check('the same receipt is not credited twice', !dup.done || !dup.final?.ok || dup.final?.json?.data?.duplicate === true, `→ ${dup.final ? brief(dup.final) : 'held'}`);
    }
    rec.skipAll(`the defining case — a weekly bill settled by a signed agent receipt — cannot run here: the bill is produced by the hourly billing job only after the 14-day trial${dark ? ', the agent-cash channel is dark (no webhook secret on this target)' : ''}, and a signed receipt needs the webhook secret, which the runner must never hold`);
    void pick; void codeOf;
  },
};

export const MONEY_JOURNEYS = [MONEY_01, MONEY_02, MONEY_03];
