'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { sessionProbe } from '@/lib/auth';
import { sendOtp } from '@/lib/otp-send';
import { markSignedIn } from '@/lib/session-hint';
import { verifyOtp, registerAccount } from '@/lib/customer-account';
import { clearStorefrontContinuation, storefrontAuthReturn } from '@/lib/storefront-continuation';
import { useStorefrontAuthJourney } from '@/lib/use-storefront-auth-journey';
import { useWebOrderingOpen } from '@/lib/use-web-ordering';
import { launchCity } from '@/lib/web-ordering';
import { EXAMPLE, LIMIT, NAME_AS_ON_ID } from '@/lib/signup-fields';
import { SwiftLogo } from '@/components/swift-logo';
import { Pictogram, type PictogramName } from '@/components/glyphs';
import { partnerDoorRole } from '@/lib/signup-roles';
// [PERF] The map picker's stylesheet stays in the page, so its code (loaded on demand by the business step) arrives
// alone, with no stylesheet to fetch on demand.
import '@/components/store-location-picker.module.css';
// [D6 · perf] The business and vehicle steps (with the store map picker, the own-name choice and the weekly fee block
// they load) are their own chunk: only partners reach them. Loading starts on a partner's name step (partner-steps.tsx).
import type * as PartnerStepsModule from './partner-steps';
import { loadPartnerSteps } from './partner-steps-loader';
import styles from '../auth-flow.module.css';
import { AGE_TICK_LABEL, AGE_TICK_REQUIRED } from '@/lib/age-tick';
import { CODE_NOT_SEEN_HINT, PhoneField } from '@/components/phone-field';
import { loadSignedIn } from '@/components/signed-in-loader';
import type { SignedIn, SignedInAlready as SignedInAlreadyComponent } from '@/components/signed-in-already';
import { sendCooldownOf, sendLabel, useSendCooldown } from '@/lib/otp-cooldown';
import { GUYANA_DIAL_CODE, guyanaLocal, guyanaPhone, guyanaPhoneProblem, guyanaPhoneReady } from '@/lib/guyana-phone';

/** [W9] The four ways in. A delivery rider and a taxi driver are both movers
 *  to the API; the vehicle each chooses decides which (partner.service:
 *  a car or a bus provisions a Driver, a motorbike or bicycle a Rider). */
type Role = 'CUSTOMER' | 'VENDOR' | 'RIDER' | 'DRIVER';
const accountRole = (r: Role): 'CUSTOMER' | 'VENDOR' | 'MOVER' => (r === 'RIDER' || r === 'DRIVER' ? 'MOVER' : r);
type Step = 'role' | 'phone' | 'code' | 'name' | 'business' | 'vehicle';

function safeReturnPath(): string {
  if (typeof window === 'undefined') return '';
  return storefrontAuthReturn(new URLSearchParams(window.location.search).get('next'));
}

const ROLES: { role: Role; title: string; desc: string; pictogram: PictogramName }[] = [
  { role: 'CUSTOMER', title: 'Order on Swift', desc: 'Food, groceries, shops, parcels and rides.', pictogram: 'food' },
  { role: 'VENDOR', title: 'Put my business on Swift', desc: 'Take orders and keep 100% of your prices. A flat weekly fee, paid through MMG checkout.', pictogram: 'shops' },
  { role: 'RIDER', title: 'Deliver with Swift', desc: 'Motorbike or bicycle deliveries on your own schedule.', pictogram: 'send' },
  { role: 'DRIVER', title: 'Drive a taxi with Swift', desc: 'Take ride requests with your car. Documents are checked before your first trip.', pictogram: 'taxi' },
];


export default function SignupPage() {
  const router = useRouter();
  const continueJourney = useStorefrontAuthJourney();
  const orderingOpen = useWebOrderingOpen();
  useEffect(() => { safeReturnPath(); }, []);
  const [step, setStep] = useState<Step>('role');
  const [role, setRole] = useState<Role>('CUSTOMER');
  // [REVIEW-G G1] A resumed mover account says first whether it delivers or drives a taxi.
  const [pickMover, setPickMover] = useState(false);
  // [SIGNUP-PHONE] The local number only: the +592 chip sits beside it, as on sign-in and in the app.
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const phoneProblem = guyanaPhoneProblem(phone);
  const cooldown = useSendCooldown();
  const [codeNotice, setCodeNotice] = useState<string | null>(null);
  // [SIGNUP-PHONE] A browser already signed in is not asked for a code again (components/signed-in-already).
  const [signedIn, setSignedIn] = useState<{ who: SignedIn; Card: typeof SignedInAlreadyComponent } | null>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('resume')) return;
    let alive = true;
    loadSignedIn().then((m) => m.probeSignedIn().then((who) => { if (alive && who) setSignedIn({ who, Card: m.SignedInAlready }); })).catch(() => {});
    return () => { alive = false; };
  }, []);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  // [D6] What a partner typed on the business or vehicle step, kept here across Back and forward (the steps themselves
  // load on demand: partner-steps.tsx).
  const [bizDraft, setBizDraft] = useState<PartnerStepsModule.BusinessDraft | null>(null);
  const [vehDraft, setVehDraft] = useState<PartnerStepsModule.VehicleDraft | null>(null);
  const mover = role === 'RIDER' || role === 'DRIVER' ? role : null;
  // [Owner ruling 15 Oct 2026] the sign-up ticks: Terms + Privacy, and "I am 18 or older". Both start
  // unticked and are cleared whenever the role or the step changes (the partner agreement and the weekly fee tick
  // live on the partner steps, which start empty each time).
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [adult, setAdult] = useState(false);
  const partnerStep = step === 'business' || step === 'vehicle';
  const [Steps, setSteps] = useState<typeof PartnerStepsModule | null>(null);
  const [stepsFailed, setStepsFailed] = useState(false);
  useEffect(() => {
    // A partner door starts loading them as soon as it is chosen, well before its name step ends.
    if (Steps || stepsFailed || !(partnerStep || (step !== 'role' && role !== 'CUSTOMER'))) return;
    loadPartnerSteps().then((m) => setSteps(() => m), () => setStepsFailed(true));
  }, [Steps, stepsFailed, partnerStep, step, role]);
  // A tick is given to what is on screen: it is cleared whenever the role or the step changes, so it never carries
  // over, nor survives leaving the step (reset during render, so no frame shows it).
  const agreementScope = `${role}:${step}`;
  const [agreeScope, setAgreeScope] = useState(agreementScope);
  if (agreeScope !== agreementScope) {
    setAgreeScope(agreementScope);
    setAcceptTerms(false);
    setAdult(false);
  }
  // A signed-in business account whose store was never created comes back
  // here from the console (/signup?resume=business) straight to that step.
  // [REVIEW-G G1 · owner rule 3] A rider or driver account that stopped after its name comes back
  // (/signup?resume=mover, from the signed-in card) straight to the vehicle step.
  useEffect(() => {
    const resume = new URLSearchParams(window.location.search).get('resume');
    if (resume !== 'business' && resume !== 'mover') return;
    let cancelled = false;
    void sessionProbe().then((session) => {
      if (cancelled || !session.ok) return;
      const accountPhone = session.user?.['phone'];
      if (typeof accountPhone === 'string') setPhone(guyanaLocal(accountPhone));
      if (resume === 'mover') { setPickMover(true); setStep('vehicle'); return; }
      setRole('VENDOR');
      setStep('business');
    });
    return () => { cancelled = true; };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyNow = useRef(false);

  const wrap = async (fn: () => Promise<void>) => {
    if (busyNow.current) return;
    busyNow.current = true;
    setError(null);
    setBusy(true);
    try { await fn(); }
    catch (e: any) { setError(e.message); }
    finally { busyNow.current = false; setBusy(false); }
  };

  const doSend = () => wrap(async () => {
    setCodeNotice(null);
    try {
      await sendOtp(guyanaPhone(phone));
      setStep('code');
    } catch (e) {
      // A wait is not an error: the button counts down; a code already on its way is entered, not asked for again.
      const wait = sendCooldownOf(e);
      if (!wait) throw e;
      cooldown.start(wait.seconds);
      if (wait.codeAlreadySent) { setCodeNotice('We already sent a code to this number. Enter it below.'); setStep('code'); }
    }
  });
  const doVerify = () => wrap(async () => {
    const r = await verifyOtp(guyanaPhone(phone), code.trim());
    if (r.signedIn) {
      markSignedIn();
      // Existing account: route by its ACTUAL roles, not the tile they tapped.
      const roles: string[] = r.user?.roles ?? [];
      const isVendor = roles.includes('VENDOR') || roles.includes('VENDOR_OWNER') || !!r.user?.vendorOwner;
      const isMover = roles.some((x) => ['MOVER', 'RIDER', 'DRIVER'].includes(x));
      const customerReturnPath = role === 'CUSTOMER' ? safeReturnPath() : '';
      if (customerReturnPath) continueJourney();
      router.replace(customerReturnPath || (isVendor ? '/dashboard' : isMover ? '/portal' : '/'));
      return;
    }
    setStep('name');
  });
  const doRegister = () => wrap(async () => {
    // Consent is explicit clickwrap: both ticks sit directly above the button
    // that triggers this. Recorded server-side [SWIFT-AUD-D9-03 · owner 15 Oct 2026].
    if (!acceptTerms) throw new Error('Tick the Terms of Service and Privacy Policy to continue');
    if (!adult) throw new Error(AGE_TICK_REQUIRED);
    try {
      await registerAccount({ phone: guyanaPhone(phone), firstName: first.trim(), lastName: last.trim(), role: accountRole(role), acceptTerms, ageConfirmed: adult });
      markSignedIn();
    } catch (cause) {
      // Registration consumes its HttpOnly continuation before account reads
      // and writes. A transport or server error is therefore ambiguous: never
      // encourage replay of the old code/cookie. Keep the entered profile data
      // but return to the step that starts a completely fresh ceremony.
      setCode('');
      setStep('phone');
      const detail = cause instanceof Error ? cause.message : 'Could not create your account.';
      throw new Error(`${detail} Request a new verification code to try again.`);
    }
    if (role === 'CUSTOMER') {
      // [E27] No profile selfie merely to browse or order: a new customer goes
      // where they were headed (else to ordering), not to the camera.
      const destination = safeReturnPath();
      if (destination) continueJourney();
      router.replace(destination || '/');
    }
    else setStep(role === 'VENDOR' ? 'business' : 'vehicle');
  });
  /** [D6] What the partner steps need from the page (they load on demand). */
  const shell: PartnerStepsModule.StepShell = { phone, busy, wrap, setError, done: (path) => router.replace(path) };
  const stepsLoading = stepsFailed
    ? <button type="button" className={styles.roleButton} onClick={() => setStepsFailed(false)}>Couldn’t load this step — try again</button>
    : <p role="status" className={styles.smallCopy}>Loading…</p>;
  const chooseRole = (r: Role) => {
    if (r !== 'CUSTOMER') clearStorefrontContinuation();
    setRole(r);
    setStep('phone');
  };
  // [OPEN-EARLY · owner 31 Oct 2026] A partner page's button (/signup?as=business|rider|driver) opens straight
  // onto that door's phone step, as if its tile had been tapped; Back still reaches the four doors. Only the three
  // partner doors: no link can open the customer door (closed on the public site before launch). A business
  // account resuming its store (?resume=business) keeps its own path.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('resume') === 'business' || params.get('resume') === 'mover') return;
    const door = partnerDoorRole(params.get('as'));
    if (door) chooseRole(door);
  }, []);
  const chosenDoor = ROLES.find((r) => r.role === role && r.role !== 'CUSTOMER');

  return (
    <main id="main" tabIndex={-1} className={styles.page}>
      <section className={styles.card} aria-labelledby="signup-title">
        {step !== 'role' ? (
          <button
            type="button"
            onClick={() => setStep(step === 'code' ? 'phone' : step === 'phone' ? 'role' : step === 'name' ? 'code' : 'name')}
            className={styles.backButton}
            aria-label="Go back one signup step"
          >
            <ChevronLeft size={18} aria-hidden="true" /> Back
          </button>
        ) : null}
        <Link href="/" aria-label="Swift home" onClick={clearStorefrontContinuation} className={styles.brandLink}><SwiftLogo /></Link>

        {signedIn && (step === 'role' || step === 'phone') ? (
          <signedIn.Card who={signedIn.who} here="/signup" titleId="signup-title" onSignedOut={() => setSignedIn(null)} />
        ) : null}
        {step === 'role' && !signedIn && (
          <div className={styles.stackTight}>
            <h1 id="signup-title" className={styles.heading}>Who are you signing up as?</h1>
            <p className={styles.bodyCopy}>Every sign-up starts with your phone and a 6-digit code. Partners also accept their partner agreement.</p>
            {ROLES.map(({ role: r, title, desc, pictogram }) => {
              // [Item 7] Before launch, the public site cannot start a customer
              // account; businesses, riders and drivers can still sign up.
              const closed = r === 'CUSTOMER' && !orderingOpen;
              const inner = (
                <>
                  <span className={styles.roleIcon} data-role-tile={r === 'CUSTOMER' ? 'brand' : 'neutral'}><Pictogram name={pictogram} size={24} /></span>
                  <span className={styles.roleCopy}><span className={styles.roleTitle}>{title}</span><span className={styles.roleDescription}>{closed ? `Launching soon in ${launchCity()}` : desc}</span></span>
                </>
              );
              // [FLOW-QA F28] the closed door is not a dead button: it opens the launching-soon page
              return closed
                ? <Link key={r} href="/launching-soon" className={styles.roleButton}>{inner}</Link>
                : <button key={r} type="button" onClick={() => chooseRole(r)} className={styles.roleButton}>{inner}</button>;
            })}
            <p className={styles.inlineText}>Already on Swift? <Link
              href="/login?next=/"
              onClick={(event) => {
                continueJourney();
                const next = safeReturnPath();
                if (!next) return;
                event.preventDefault();
                router.push(`/login?next=${encodeURIComponent(next)}`);
              }}
              className={styles.inlineLink}
            >Sign in</Link></p>
          </div>
        )}

        {step === 'phone' && !signedIn && (
          <div className={styles.stack}>
            <h1 id="signup-title" className={styles.heading}>Confirm your phone</h1>
            {chosenDoor ? <p className={styles.smallCopy} data-chosen-door>Signing up as: {chosenDoor.title}</p> : null}
            <p className={styles.bodyCopy}>We’ll text you a code to confirm your number.</p>
            <PhoneField id="signup-phone" value={phone} onChange={setPhone} onEnter={() => { if (guyanaPhoneReady(phone)) void doSend(); }} />
            {phoneProblem ? <p className={styles.smallCopy} aria-live="polite">{phoneProblem}</p> : null}
            <button type="button" onClick={() => void doSend()} disabled={busy || !guyanaPhoneReady(phone) || cooldown.secondsLeft > 0} className={styles.primaryButton}>{busy ? 'Sending…' : sendLabel(cooldown.secondsLeft, 'Send code')}</button>
          </div>
        )}
        {step === 'code' && (
          <div className={styles.stack}>
            <h1 id="signup-title" className={styles.heading}>Enter your code</h1>
            <p className={styles.bodyCopy}>Enter the code sent to {GUYANA_DIAL_CODE} {guyanaLocal(phone)}.</p>
            <div className={styles.field}>
              <label htmlFor="signup-code" className={styles.label}>Verification code</label>
              <input id="signup-code" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void doVerify()} placeholder="000000" className={`${styles.input} ${styles.codeInput}`} />
            </div>
            {codeNotice ? <p className={styles.smallCopy} role="status">{codeNotice}</p> : null}
            <p className={styles.smallCopy}>{CODE_NOT_SEEN_HINT}</p>
            <button type="button" onClick={() => void doVerify()} disabled={busy || code.trim().length < 4} className={styles.primaryButton}>{busy ? 'Checking…' : 'Continue'}</button>
            <button type="button" onClick={() => void doSend()} disabled={busy || cooldown.secondsLeft > 0} className={styles.roleButton}>{sendLabel(cooldown.secondsLeft, 'Send a new code')}</button>
          </div>
        )}
        {step === 'name' && (
          <div className={styles.stackTight}>
            <h1 id="signup-title" className={styles.heading}>Your name</h1>
            <div className={styles.field}>
              <label htmlFor="signup-first" className={styles.label}>First name</label>
              <input id="signup-first" autoComplete="given-name" maxLength={LIMIT.name} placeholder={EXAMPLE.first} value={first} onChange={(e) => setFirst(e.target.value)} className={styles.input} />
            </div>
            <div className={styles.field}>
              <label htmlFor="signup-last" className={styles.label}>Last name</label>
              <input id="signup-last" autoComplete="family-name" maxLength={LIMIT.name} placeholder={EXAMPLE.last} value={last} onChange={(e) => setLast(e.target.value)} className={styles.input} />
            </div>
            {/* [WEB-ONBOARDING] a person compares each partner document's name with the account's (NAME_MISMATCH) */}
            {role !== 'CUSTOMER' ? <p className={styles.smallCopy}>{NAME_AS_ON_ID}</p> : null}
            {/* Two explicit, unticked ticks (the Terms say acceptance is by "ticking the acceptance box at registration"):
                the Terms and Privacy consent, and the owner's 15 Oct 18+ declaration. The API records both in the consent ledger. */}
            <label className={styles.legal} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <input type="checkbox" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} />
              <span>
                I agree to the{' '}
                <a href="/legal/terms" target="_blank" rel="noreferrer" className={styles.inlineLink}>Terms of Service</a>{' '}
                and{' '}
                <a href="/legal/privacy" target="_blank" rel="noreferrer" className={styles.inlineLink}>Privacy Policy</a>
              </span>
            </label>
            <label className={styles.legal} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
              <span>{AGE_TICK_LABEL}</span>
            </label>
            <button type="button" onClick={() => void doRegister()} disabled={busy || !first.trim() || !last.trim() || !acceptTerms || !adult} className={styles.primaryButton}>{busy ? 'Creating…' : 'Create account'}</button>
          </div>
        )}
        {step === 'business' && (Steps ? <Steps.BusinessStep shell={shell} draft={bizDraft} onDraft={setBizDraft} /> : stepsLoading)}
        {step === 'vehicle' && !mover && pickMover && (
          <div className={styles.stackTight}>
            <h1 id="signup-title" className={styles.heading}>Finish signing up</h1>
            <p className={styles.bodyCopy}>Your account is made. Tell us how you work with Swift to add your vehicle.</p>
            {(['RIDER', 'DRIVER'] as const).map((r) => (
              <button key={r} type="button" className={styles.roleButton} onClick={() => { setRole(r); setPickMover(false); }}>
                <span className={styles.roleCopy}><span className={styles.roleTitle}>{ROLES.find((x) => x.role === r)?.title}</span><span className={styles.roleDescription}>{ROLES.find((x) => x.role === r)?.desc}</span></span>
              </button>
            ))}
          </div>
        )}
        {step === 'vehicle' && mover && (Steps ? <Steps.VehicleStep key={mover} shell={shell} mover={mover} draft={vehDraft} onDraft={setVehDraft} /> : stepsLoading)}

        {error ? <p className={styles.error} role="alert" aria-live="assertive">{error}</p> : null}
      </section>
    </main>
  );
}
