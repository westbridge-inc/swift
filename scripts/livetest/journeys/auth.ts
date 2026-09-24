// Authentication journeys [TASK-057]: AUTH-01, AUTH-02, AUTH-03 and PLAT-03
// (OTP abuse). AUTH-04 (deletion) lives with the account journeys.

import { FIXTURE_PNG, OTP, upload, type Session } from '../client.js';
import type { Journey } from '../journey.js';
import { GET, POST, req, sleep, codeOf, freshPhone, placeOrder, orderIdsOf, pick, brief } from './common.js';
import type { Ctx } from './context.js';

/** A fictional non-Guyana number from Ofcom's drama range (07700 900xxx), already used by the repo's tests.
 *  Only ever given to verify-otp/register to prove the refusal; never sent a message. */
export const UK_FICTIONAL = (runId: string) => `+447700900${String(Math.abs(hash(runId)) % 1000).padStart(3, '0')}`;
function hash(s: string): number { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; }

/** verify-otp without the 429 retry, so throttling is observed rather than waited out. */
const verifyRaw = (phone: string, code: string, headers?: Record<string, string>) =>
  req('POST', '/auth/verify-otp', { body: { phone, code }, retry429: false, headers });
const sendRaw = (phone: string) => req('POST', '/auth/send-otp', { body: { phone }, retry429: false });

/** A brand-new phone for this run: verify-otp must answer isNewUser. */
async function newSignupProof(ctx: Ctx, slot: string): Promise<{ phone: string; proof: string } | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const phone = freshPhone(ctx.runId, slot, attempt);
    const v = await req('POST', '/auth/verify-otp', { body: { phone, code: OTP } });
    if (v.json?.data?.isNewUser && typeof v.json.data.registrationProof === 'string') return { phone, proof: v.json.data.registrationProof };
  }
  return null;
}

export async function registerFresh(ctx: Ctx, slot: string, role: 'CUSTOMER' | 'VENDOR' | 'MOVER' = 'CUSTOMER'): Promise<{ phone: string; session: Session; user: any } | null> {
  const p = await newSignupProof(ctx, slot);
  if (!p) return null;
  const r = await POST('/auth/register', {
    phone: p.phone, registrationProof: p.proof, firstName: `TEST-${slot}`, lastName: 'Journey', role, countryCode: 'GY', acceptTerms: true,
  });
  const d = r.json?.data;
  if (!d?.tokens?.accessToken) return null;
  const { sessionFrom } = await import('../client.js');
  return { phone: p.phone, session: sessionFrom(d), user: d.user };
}

export const AUTH_01: Journey<Ctx> = {
  id: 'AUTH-01',
  estimateSeconds: 100,
  title: 'Guyana-only phone signup + Twilio OTP',
  cases: 'happy; bad/expired OTP; resend throttling; non-Guyana denial; registration replay',
  async run(rec, ctx) {
    // The per-IP OTP bucket (5/min) is shared with every sign-in: start from an empty window.
    await sleep(61_000);
    // happy: the real order — send, verify (the private instance's dev code), register.
    const countries = await GET('/auth/countries');
    const codes = (countries.json?.data ?? []).map((c: any) => c.code);
    rec.check('country picker offers Guyana only', countries.ok && codes.length === 1 && codes[0] === 'GY', `GET /auth/countries → ${countries.status} ${JSON.stringify(codes)}`);

    let p: { phone: string; proof: string } | null = null;
    let send = null as Awaited<ReturnType<typeof sendRaw>> | null;
    for (let attempt = 0; attempt < 4 && !p; attempt += 1) {
      const phone = freshPhone(ctx.runId, 'auth01', attempt);
      send = await sendRaw(phone);
      const v = await verifyRaw(phone, OTP);
      if (v.json?.data?.isNewUser && typeof v.json.data.registrationProof === 'string') p = { phone, proof: v.json.data.registrationProof };
    }
    rec.expect('send-otp accepts a Guyana number (dev SMS channel)', send!, 200, undefined, `expiresIn=${send!.json?.data?.expiresIn}`);
    rec.require('verify-otp turns a fresh fictional +592 number into a signup continuation', !!p, p ? `${p.phone} → isNewUser + registrationProof` : 'no fresh number in 4 tries');
    const reg = await POST('/auth/register', {
      phone: p!.phone, registrationProof: p!.proof, firstName: 'TEST-Auth01', lastName: 'Journey', role: 'CUSTOMER', countryCode: 'GY', acceptTerms: true,
    });
    const user = reg.json?.data?.user;
    rec.expect('register creates the account', reg, 201);
    rec.check('the new account is Guyana, L1, customer', user?.countryCode === 'GY' && user?.trustLevel === 'L1' && user?.activeRole === 'CUSTOMER',
      `countryCode=${user?.countryCode} trustLevel=${user?.trustLevel} activeRole=${user?.activeRole}`);
    const token = reg.json?.data?.tokens?.accessToken;
    const me = await req('GET', '/auth/me', { token, refresh: false });
    rec.check('GET /auth/me reads the persisted account', me.ok && me.json?.data?.user?.phone === p!.phone, `→ ${me.status} phone=${me.json?.data?.user?.phone}`);

    // registration replay: the continuation was consumed.
    const replay = await POST('/auth/register', {
      phone: p!.phone, registrationProof: p!.proof, firstName: 'TEST-Replay', lastName: 'Journey', role: 'CUSTOMER', countryCode: 'GY', acceptTerms: true,
    });
    rec.deny('replaying a consumed registration proof', replay, [403], ['REGISTRATION_PROOF_REQUIRED']);
    const noProof = await POST('/auth/register', { phone: freshPhone(ctx.runId, 'auth01-noproof'), firstName: 'X', lastName: 'Y', role: 'CUSTOMER', acceptTerms: true });
    rec.deny('register without any proof', noProof, [403], ['REGISTRATION_PROOF_REQUIRED']);

    // bad/expired OTP: a code for a number with no live OTP, and a wrong code after a real send.
    const unsent = await verifyRaw(freshPhone(ctx.runId, 'auth01-unsent'), '123456');
    rec.deny('a code for a number that has no live OTP (expired/not found)', unsent, [400], ['INVALID_OTP'], String(unsent.json?.error?.message ?? ''));
    const other = freshPhone(ctx.runId, 'auth01-wrong');
    const otherSend = await sendRaw(other);
    rec.expect('a second number receives a code', otherSend, 200);
    const wrong = await verifyRaw(other, '000001');
    rec.deny('a wrong code after a real send', wrong, [400], ['INVALID_OTP'], String(wrong.json?.error?.message ?? ''));

    // resend throttling: a second send inside 60 s is refused for that number.
    const resend = await sendRaw(other);
    rec.deny('an immediate resend for the same number', resend, [429], ['RATE_LIMITED'], String(resend.json?.error?.message ?? ''));

    // non-Guyana denial: phone ownership proven, account refused.
    const uk = UK_FICTIONAL(ctx.runId);
    const ukv = await verifyRaw(uk, OTP);
    const ukProof = ukv.json?.data?.registrationProof;
    if (ukProof) {
      const ukReg = await POST('/auth/register', { phone: uk, registrationProof: ukProof, firstName: 'TEST-Uk', lastName: 'Journey', role: 'CUSTOMER', countryCode: 'GY', acceptTerms: true });
      rec.deny('a non-Guyana number cannot register (even claiming GY)', ukReg, [400], ['COUNTRY_NOT_ACTIVE']);
    } else {
      rec.deny('a non-Guyana number is refused at verify', ukv, [400, 403], undefined, 'no continuation issued');
    }

    rec.deviceCase('real OTP delivery and code entry',
      'Phase A has no SMS provider (NOTIFICATION_PROVIDER=dev keeps codes in process memory) and the private instance verifies with the DEV_OTP_BYPASS code; Twilio delivery to a consented Guyana SIM is the device gate');
  },
};

export const AUTH_02: Journey<Ctx> = {
  id: 'AUTH-02',
  estimateSeconds: 45,
  title: 'Role picker & switch-role',
  cases: 'role switch; wrong-role denial; session refresh',
  async run(rec, ctx) {
    const owner = ctx.roster.vendors.R1!.session;
    const me0 = await GET('/auth/me', owner.token);
    const roles: string[] = me0.json?.data?.user?.roles ?? [];
    rec.check('a vendor owner holds VENDOR_OWNER and CUSTOMER', roles.includes('VENDOR_OWNER') && roles.includes('CUSTOMER'), `roles=${JSON.stringify(roles)}`);

    const toCustomer = await POST('/customer/switch-role', { role: 'CUSTOMER' }, owner.token);
    rec.expect('switch to customer mode', toCustomer, 200, undefined, `activeRole=${toCustomer.json?.data?.activeRole}`);
    const me1 = await GET('/auth/me', owner.token);
    rec.check('the switch is durable (GET /auth/me)', me1.json?.data?.user?.activeRole === 'CUSTOMER', `activeRole=${me1.json?.data?.user?.activeRole}`);
    const toVendor = await POST('/customer/switch-role', { role: 'VENDOR' }, owner.token);
    rec.expect('switch back to vendor mode', toVendor, 200, undefined, `activeRole=${toVendor.json?.data?.activeRole}`);
    const board = await GET('/vendor/profile', owner.token);
    rec.expect('the vendor destination opens in vendor mode', board, 200);
    const me2 = await GET('/auth/me', owner.token);
    rec.check('active role is VENDOR_OWNER again', me2.json?.data?.user?.activeRole === 'VENDOR_OWNER', `activeRole=${me2.json?.data?.user?.activeRole}`);

    // wrong-role denial
    const cust = ctx.roster.customers.C2!.session;
    rec.deny('a customer cannot switch into a role they do not hold', await POST('/customer/switch-role', { role: 'VENDOR' }, cust.token), [403]);
    rec.deny('a customer cannot open the vendor board', await GET('/vendor/profile', cust.token), [403, 404]);
    rec.deny('a customer cannot open the rider surface', await GET('/rider/profile', cust.token), [403, 404]);
    rec.deny('a customer cannot open admin', await GET('/admin/dashboard/overview', cust.token), [403]);
    rec.deny('no bearer, no session', await req('GET', '/auth/me', {}), [401]);

    // session refresh: a separate session so the roster's stays untouched.
    const fresh = await req('POST', '/auth/verify-otp', { body: { phone: ctx.roster.customers.C2!.phone, code: OTP } });
    const t0 = fresh.json?.data?.tokens;
    rec.require('a second session for the refresh case', !!t0?.refreshToken, `verify-otp → ${brief(fresh)}`);
    const rotated = await req('POST', '/auth/refresh', { body: { refreshToken: t0.refreshToken }, refresh: false });
    const t1 = rotated.json?.data;
    rec.check('refresh rotates both tokens', rotated.ok && !!t1?.accessToken && t1.refreshToken !== t0.refreshToken, `→ ${brief(rotated)}`);
    const me3 = await req('GET', '/auth/me', { token: t1?.accessToken, refresh: false });
    rec.expect('the rotated access token works', me3, 200);
    const reuse = await req('POST', '/auth/refresh', { body: { refreshToken: 'x'.repeat(40) }, refresh: false });
    rec.deny('a forged refresh token', reuse, [401]);
    const out = await req('POST', '/auth/logout', { token: t1?.accessToken, body: {}, refresh: false });
    rec.expect('logout', out, 200);
    const after = await req('GET', '/auth/me', { token: t1?.accessToken, refresh: false });
    rec.deny('the logged-out access token is dead at once', after, [401]);
  },
};

export const AUTH_03: Journey<Ctx> = {
  id: 'AUTH-03',
  estimateSeconds: 45,
  title: 'Mandatory selfie gate',
  cases: 'camera upload; unauthenticated/spoofed image denial; ordinary checkout after policy correction',
  async run(rec, ctx) {
    const acct = await registerFresh(ctx, 'auth03');
    rec.require('a fresh customer for the selfie gate', !!acct, acct ? acct.phone : 'signup failed');
    const s = acct!.session;
    const png = { name: 'selfie.png', type: 'image/png', bytes: FIXTURE_PNG };

    rec.deny('an unauthenticated selfie upload', await upload('/auth/selfie', 'x'.repeat(24), png), [401]);
    rec.deny('a spoofed image (text bytes labelled PNG)', await upload('/auth/selfie', s.token, { name: 'selfie.png', type: 'image/png', bytes: Buffer.from('definitely not an image') }), [400], ['BAD_IMAGE']);
    rec.deny('a non-image type', await upload('/auth/selfie', s.token, { name: 'selfie.txt', type: 'text/plain', bytes: Buffer.from('hello') }), [400], ['BAD_IMAGE_TYPE']);

    // Owner ruling (LANES.md, E27): no selfie merely to place an ordinary food/grocery/retail order.
    const R2 = ctx.roster.vendors.R2!, item = ctx.world.items.R2;
    if (item) {
      const before = await placeOrder(s, R2.vendorId!, item.itemId, R2.lat, R2.lng, { pickup: true, key: `${ctx.runId}-auth03-noselfie` });
      rec.check('ordinary pickup checkout succeeds WITHOUT a selfie (owner ruling; E27)', before.status === 201 || before.status === 200,
        `→ ${brief(before)}${codeOf(before) === 'SELFIE_REQUIRED' ? ' — the selfie gate still blocks ordinary checkout (E27 open)' : ''}`);
      for (const id of orderIdsOf(before)) await POST(`/customer/orders/${id}/cancel`, { reason: 'journey cleanup' }, s.token);
    } else {
      rec.check('R2 pickup item provisioned for the checkout case', false, 'no R2 item');
    }

    const ok = await upload('/auth/selfie', s.token, png);
    rec.expect('selfie upload (image bytes, magic-byte checked)', ok, [200, 201]);
    const prof = await GET('/customer/profile', s.token);
    rec.check('the profile carries the captured selfie', !!pick(prof.json, 'data.selfieCapturedAt') && !!pick(prof.json, 'data.avatar'),
      `selfieCapturedAt=${pick(prof.json, 'data.selfieCapturedAt') ?? 'null'}`);
    if (item) {
      const after = await placeOrder(s, R2.vendorId!, item.itemId, R2.lat, R2.lng, { pickup: true, key: `${ctx.runId}-auth03-selfie` });
      rec.expect('checkout after the selfie', after, [200, 201]);
      for (const id of orderIdsOf(after)) {
        const c = await POST(`/customer/orders/${id}/cancel`, { reason: 'journey cleanup' }, s.token);
        rec.expect('cancel inside the free window (cleanup)', c, 200);
      }
    }
    rec.deviceCase('camera-only capture', 'the server accepts any well-formed image; restricting capture to the live camera is a client property — device gate');
  },
};

export const PLAT_03: Journey<Ctx> = {
  id: 'PLAT-03',
  estimateSeconds: 180,
  title: 'OTP/rate-limit abuse',
  cases: 'OTP brute force; IP/phone throttle; no session',
  async run(rec, ctx) {
    // The per-IP OTP bucket is 5/minute: start from an empty window.
    await sleep(61_000);
    const victim = freshPhone(ctx.runId, 'plat03');
    const sent = await sendRaw(victim);
    rec.expect('an OTP is issued to the target number', sent, 200);

    // Brute force within one window: every wrong code refused, no session.
    const tries: string[] = [];
    let tokens = false;
    for (let i = 0; i < 5; i += 1) {
      const r = await verifyRaw(victim, String(100000 + i * 7919).slice(0, 6));
      tries.push(brief(r));
      if (r.json?.data?.tokens || r.json?.data?.registrationProof) tokens = true;
    }
    rec.check('five wrong codes: all refused, none opens a session', !tokens && tries.every((t) => t.startsWith('400')), tries.join(', '));
    const sixth = await verifyRaw(victim, '999999');
    rec.deny('the sixth attempt in the window is throttled per IP', sixth, [429]);

    // A forged bearer header must not buy a fresh bucket on an anonymous route.
    const forged = await verifyRaw(victim, '999998', { authorization: `Bearer forged-${ctx.runId}-${Date.now()}` });
    rec.deny('a forged bearer header does not reset the per-IP OTP throttle', forged, [429], undefined,
      forged.status === 429 ? '' : 'the limiter keys anonymous routes on the unverified bearer hash (utils/rate-limit-key.ts), so each forged token gets its own 5/min bucket');

    // After the window: the code itself is locked after five wrong attempts.
    await sleep(61_000);
    const locked = await verifyRaw(victim, '999997');
    const msg = String(locked.json?.error?.message ?? '');
    rec.deny('the code is locked after five wrong attempts', locked, [400], ['INVALID_OTP'], msg);
    rec.check('the lock is the attempt cap, not a plain mismatch', /too many attempts/i.test(msg), `message="${msg}"`);

    // Phone throttle: a resend inside 60 s is refused for that number.
    const again = await sendRaw(victim);
    const again2 = await sendRaw(victim);
    rec.check('the first resend after the window is accepted', again.status === 200, `→ ${brief(again)}`);
    rec.deny('an immediate second resend is refused for the number', again2, [429], ['RATE_LIMITED']);
    rec.deny('no session exists for the attacker', await req('GET', '/auth/me', {}), [401]);

    // Note, not a ledger case: the limiter store is Redis only when NODE_ENV=production
    // (apps/api/src/app.ts); loadtest keeps a per-process store, so a ceiling shared
    // across instances is not what this run proves.
  },
};

export const AUTH_JOURNEYS = [AUTH_01, AUTH_02, AUTH_03, PLAT_03];
