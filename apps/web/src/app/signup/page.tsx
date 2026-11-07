'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { hasProviderProfile, sessionProbe } from '@/lib/auth';
import { sendOtp } from '@/lib/otp-send';
import { markSignedIn } from '@/lib/session-hint';
import { ACCOUNT_STEPS, clearDraft, readDraft, saveDraft, stepOf, stepUrl } from '@/lib/signup-draft';
import { roleHome } from '@/lib/role-home';
import { otpVerifyRefusal } from '@/lib/otp-send-refusal';
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
import { guyanaDisplay, guyanaLocal, guyanaPhone, guyanaPhoneProblem, guyanaPhoneReady } from '@/lib/guyana-phone';

/** [W9] The four ways in. A delivery rider and a taxi driver are both movers
 *  to the API; the vehicle each chooses decides which (partner.service:
 *  a car or a bus provisions a Driver, a motorbike or bicycle a Rider). */
type Role = 'CUSTOMER' | 'VENDOR' | 'RIDER' | 'DRIVER';
const accountRole = (r: Role): 'CUSTOMER' | 'VENDOR' | 'MOVER' => (r === 'RIDER' || r === 'DRIVER' ? 'MOVER' : r);
/** A self-employed pro's profile, asked of the server; any failure is "no", as on sign-in. */
async function isPro(): Promise<boolean> {
  try { return await hasProviderProfile(); } catch { return false; }
}

type Step = 'role' | 'phone' | 'code' | 'name' | 'business' | 'vehicle';

function safeReturnPath(): string {
  if (typeof window === 'undefined') return '';
  return storefrontAuthReturn(new URLSearchParams(window.location.search).get('next'));
}

const ROLES: { role: Role; title: string; desc: string; pictogram: PictogramName }[] = [
  { role: 'CUSTOMER', title: 'Order on Swift', desc: 'Food, groceries, shops, parcels and rides.', pictogram: 'food' },
  { role: 'VENDOR', title: 'Put my business on Swift', desc: 'Take orders and keep 100% of your prices. A flat weekly fee, paid through MMG checkout or in person.', pictogram: 'shops' },
  // [CARS-PLATES · owner 6 Nov 2026] A private (P) plate car delivers too (the vehicle step offers it while Swift takes
  // cars); the door names no vehicle list, so its words stay true even with car deliveries paused (the kill switch).
  { role: 'RIDER', title: 'Deliver with Swift', desc: 'Deliver orders and parcels on your own schedule.', pictogram: 'send' },
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
  // [FLOW-QA F9] Set when an existing account goes on to add a business or a vehicle.
  const [addingTo, setAddingTo] = useState<string | null>(null);
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
  // [FLOW-QA F6] One history entry per step, and what was typed kept for this tab (lib/signup-draft).
  const fromHistory = useRef(false);
  const stepNow = useRef<Step>('role');
  useEffect(() => { stepNow.current = step; }, [step]);
  const restored = useRef(false);
  // The step a kept draft is being restored to: until the page shows it, nothing is saved over the draft and the
  // partner-door effect below leaves the door alone (REVIEW-GMF2 S3-1).
  const restoringTo = useRef<Step | null>(null);
  useEffect(() => {
    const wanted = stepOf(window.location.search);
    const draft = readDraft();
    if (wanted && wanted !== 'role' && draft && draft.step === wanted) {
      restoringTo.current = wanted;
      if (draft.role === 'CUSTOMER' || draft.role === 'VENDOR' || draft.role === 'RIDER' || draft.role === 'DRIVER') setRole(draft.role);
      setPhone(draft.phone); setFirst(draft.first); setLast(draft.last);
      setStep(wanted);
    } else if (wanted) {
      // an old step address with nothing kept for it: start at the beginning, without an extra entry
      fromHistory.current = true;
      window.history.replaceState(window.history.state, '', stepUrl('role'));
    }
    restored.current = true;
    const onPop = () => {
      // [REVIEW-GMF2 S3] Back has already left sign-up (every way in is a client-side link, so this page's listener
      // can still hear the page it came from): nothing more to do, and never another step back.
      if (window.location.pathname !== '/signup') return;
      const popped = stepOf(window.location.search) ?? 'role';
      // [REVIEW-GMF2 S3-3] Once the account exists, Back never reopens the steps that made it: it keeps going back,
      // past them, so one press leaves sign-up (the page stays on its step while it does).
      if (ACCOUNT_STEPS.includes(stepNow.current) && !ACCOUNT_STEPS.includes(popped)) { window.history.back(); return; }
      fromHistory.current = true;
      setStep(popped);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    if (!restored.current) return;
    if (restoringTo.current) {
      if (step !== restoringTo.current) return; // the restored values have not landed yet
      restoringTo.current = null;
    } else if (fromHistory.current) { fromHistory.current = false; }
    else if (stepOf(window.location.search) !== step) {
      if (stepOf(window.location.search) === null && step === 'role') window.history.replaceState(window.history.state, '', stepUrl(step));
      else window.history.pushState(window.history.state, '', stepUrl(step));
    }
    saveDraft({ step, role, phone, first, last });
  }, [step, role, phone, first, last]);
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
  const resumeAccount = (resume: 'business' | 'mover', live: () => boolean = () => true) => {
    void sessionProbe().then((session) => {
      if (!live() || !session.ok) return;
      const accountPhone = session.user?.['phone'];
      if (typeof accountPhone === 'string') setPhone(guyanaLocal(accountPhone));
      if (resume === 'mover') { setPickMover(true); setStep('vehicle'); return; }
      setRole('VENDOR');
      setStep('business');
    });
  };
  useEffect(() => {
    const resume = new URLSearchParams(window.location.search).get('resume');
    if (resume !== 'business' && resume !== 'mover') return;
    let cancelled = false;
    resumeAccount(resume, () => !cancelled);
    return () => { cancelled = true; };
  }, []);
  /** [FLOW-QA2 NEW-1] The signed-in card's "Finish signing up" (/signup?resume=mover) is this page: a link to it
   *  changes only the address and this page stays mounted, so the card's tap resumes here, as a refresh would. */
  const goFromCard = (href: string): boolean => {
    const resume = /^\/signup\?resume=(mover|business)$/.exec(href)?.[1] as 'mover' | 'business' | undefined;
    if (!resume) return false;
    window.history.replaceState(window.history.state, '', href);
    resumeAccount(resume);
    return true;
  };
  /** [FLOW-QA F9] An existing account that chose another partner door goes on to that door's step (its account is
   *  kept; a business or a vehicle is added to it). [FLOW-QA2 NEW-9] So does a signed-in one, from the card. */
  const addToAccount = (door: Role) => {
    setAddingTo(door === 'VENDOR' ? 'Add a business to your Swift account.' : 'Add your vehicle to your Swift account.');
    setStep(door === 'VENDOR' ? 'business' : 'vehicle');
  };
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
    let r: Awaited<ReturnType<typeof verifyOtp>>;
    // [FLOW-QA F16] a refused code in plain words
    try { r = await verifyOtp(guyanaPhone(phone), code.trim()); } catch (e) { throw new Error(otpVerifyRefusal(e)); }
    if (r.signedIn) {
      markSignedIn();
      // Existing account: route by its ACTUAL roles, not the tile they tapped.
      const { kind, home } = roleHome(r.user);
      const isVendor = kind === 'business';
      const isMover = kind === 'earner';
      // [FLOW-QA F9] An existing account that chose another partner door goes on to that door's step (its account is
      // kept; a business or a vehicle is added to it), never silently back to its old home.
      if (role === 'VENDOR' ? !isVendor : role !== 'CUSTOMER' && !isMover) { addToAccount(role); return; }
      const customerReturnPath = role === 'CUSTOMER' ? safeReturnPath() : '';
      if (customerReturnPath) continueJourney();
      clearDraft();
      // [REVIEW-GMF2 S4] a self-employed pro (no partner role) goes where sign-in sends them: their weekly fee
      const pro = !customerReturnPath && kind === 'customer' && await isPro();
      router.replace(customerReturnPath || (pro ? '/portal/weekly-fee' : home));
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
      clearDraft();
      router.replace(destination || '/');
    }
    else setStep(role === 'VENDOR' ? 'business' : 'vehicle');
  });
  /** [D6] What the partner steps need from the page (they load on demand). */
  const shell: PartnerStepsModule.StepShell = { phone, busy, wrap, setError, done: (path) => { clearDraft(); router.replace(path); } };
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
    // [REVIEW-GMF2 S3-1] a refresh or Back on a partner page's sign-up (?as=…&step=…) resumes its step: the door is
    // already in the kept draft, so it is not opened again on the phone step
    if (restoringTo.current) return;
    const door = partnerDoorRole(params.get('as'));
    if (door) chooseRole(door);
  }, []);
  const chosenDoor = ROLES.find((r) => r.role === role && r.role !== 'CUSTOMER');
  // [FLOW-QA2 NEW-9] The partner door this signed-in visit came by, when the account is not already that partner.
  const cardDoor = signedIn && chosenDoor && signedIn.who.kind
    && (chosenDoor.role === 'VENDOR' ? signedIn.who.kind !== 'business' : signedIn.who.kind !== 'earner') ? chosenDoor : null;

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
          <signedIn.Card who={signedIn.who} here="/signup" titleId="signup-title" onGo={goFromCard} onSignedOut={() => setSignedIn(null)}
            addTo={cardDoor ? (cardDoor.role === 'VENDOR' ? 'business' : 'vehicle') : undefined}
            onAddTo={() => { if (cardDoor) { clearStorefrontContinuation(); setPhone(guyanaLocal(signedIn.who.phone)); addToAccount(cardDoor.role); } }} />
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
              href={orderingOpen ? '/login?next=/' : '/login'}
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
            <p className={styles.bodyCopy}>Enter the code sent to {guyanaDisplay(phone)}.</p>
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
        {step === 'business' && (Steps ? <Steps.BusinessStep shell={shell} draft={bizDraft} onDraft={setBizDraft} note={addingTo} /> : stepsLoading)}
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
        {step === 'vehicle' && mover && (Steps ? <Steps.VehicleStep key={mover} shell={shell} mover={mover} draft={vehDraft} onDraft={setVehDraft} note={addingTo} /> : stepsLoading)}

        {error ? <p className={styles.error} role="alert" aria-live="assertive">{error}</p> : null}
      </section>
    </main>
  );
}
