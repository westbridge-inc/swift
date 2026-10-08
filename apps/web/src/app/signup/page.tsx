'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { sendOtp, sessionProbe } from '@/lib/auth';
import { LEGAL_URL } from '@/lib/api';
import { verifyOtp, registerAccount, becomePartner } from '@/lib/customer';
import { clearStorefrontContinuation, storefrontAuthReturn } from '@/lib/storefront-continuation';
import { useStorefrontAuthJourney } from '@/lib/use-storefront-auth-journey';
import { useWebOrderingOpen } from '@/lib/use-web-ordering';
import { launchCity } from '@/lib/web-ordering';
import { SwiftLogo } from '@/components/swift-logo';
import { Pictogram, type PictogramName } from '@/components/glyphs';
import { MOVER_VEHICLES } from '@/lib/signup-roles';
import { StoreLocationPicker } from '@/components/store-location-picker';
import { STORE_PIN_OUTSIDE, storePinInMarket, type StorePin } from '@/lib/store-pin';
import styles from '../auth-flow.module.css';

/** The server's rule for a taxi's year (partner.routes vehicle schema): 1980
 *  to next year. Checked here too, so a typo is caught before the round trip. */
function vehicleYearAccepted(year: string): boolean {
  const n = Number(year);
  return Number.isInteger(n) && n >= 1980 && n <= new Date().getFullYear() + 1;
}

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


/** The partner agreement clickwrap: unticked until the person ticks it. */
function PartnerAgreement({ kind, doc, agree, onChange }: {
  kind: 'Vendor' | 'Driver';
  doc: 'vendor-agreement' | 'driver-agreement';
  agree: boolean;
  onChange: (_next: boolean) => void;
}) {
  return (
    <label className={styles.legal} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
      <input type="checkbox" checked={agree} onChange={(e) => onChange(e.target.checked)} />
      <span>
        I agree to the{' '}
        <a href={LEGAL_URL(doc)} target="_blank" rel="noreferrer" className={styles.inlineLink}>{kind} Partner Agreement</a>
      </span>
    </label>
  );
}

export default function SignupPage() {
  const router = useRouter();
  const continueJourney = useStorefrontAuthJourney();
  const orderingOpen = useWebOrderingOpen();
  useEffect(() => { safeReturnPath(); }, []);
  const [step, setStep] = useState<Step>('role');
  const [role, setRole] = useState<Role>('CUSTOMER');
  const [phone, setPhone] = useState('+592');
  const [code, setCode] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [biz, setBiz] = useState({ name: '', vendorType: 'RESTAURANT', addressLine1: '', city: '', region: '' });
  const [storePin, setStorePin] = useState<StorePin | null>(null);
  const [placingStore, setPlacingStore] = useState(false);
  const storePinButton = useRef<HTMLButtonElement>(null);
  const restorePinFocus = useRef(false);
  useEffect(() => {
    if (!placingStore && restorePinFocus.current) {
      storePinButton.current?.focus();
      restorePinFocus.current = false;
    }
  }, [placingStore]);
  const closeStorePicker = () => { restorePinFocus.current = true; setPlacingStore(false); };
  const [veh, setVeh] = useState({ vehicleType: 'MOTORCYCLE', make: '', model: '', color: '', licensePlate: '', year: '' });
  const mover = role === 'RIDER' || role === 'DRIVER' ? role : null;
  // The partner agreement: an explicit, unticked clickwrap. The API records the
  // consent and refuses a partner sign-up without it (AGREEMENT_REQUIRED).
  const [agree, setAgree] = useState(false);
  // A tick is given to the agreement on screen: it is cleared whenever the role
  // or the step changes, so it never carries from one agreement to the other,
  // nor survives leaving the step (reset during render, so no frame shows it).
  const agreementScope = `${role}:${step}`;
  const [agreeScope, setAgreeScope] = useState(agreementScope);
  if (agreeScope !== agreementScope) {
    setAgreeScope(agreementScope);
    setAgree(false);
  }
  // A signed-in business account whose store was never created comes back
  // here from the console (/signup?resume=business) straight to that step.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('resume') !== 'business') return;
    let cancelled = false;
    void sessionProbe().then((session) => {
      if (cancelled || !session.ok) return;
      const accountPhone = session.user?.['phone'];
      if (typeof accountPhone === 'string') setPhone(accountPhone);
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

  const doSend = () => wrap(async () => { await sendOtp(phone.trim()); setStep('code'); });
  const doVerify = () => wrap(async () => {
    const r = await verifyOtp(phone.trim(), code.trim());
    if (r.signedIn) {
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
    // Consent is explicit clickwrap: the agreement line sits directly above
    // the button that triggers this. Recorded server-side [SWIFT-AUD-D9-03].
    try {
      await registerAccount({ phone: phone.trim(), firstName: first.trim(), lastName: last.trim(), role: accountRole(role), acceptTerms: true });
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
  const doBusiness = () => wrap(async () => {
    if (!storePin || placingStore) throw new Error('Place your store on the map');
    if (!storePinInMarket(storePin)) throw new Error(STORE_PIN_OUTSIDE);
    if (!agree) throw new Error('Tick the Vendor Partner Agreement to continue');
    await becomePartner({ role: 'VENDOR', acceptAgreement: true, business: { name: biz.name.trim(), vendorType: biz.vendorType, phone: phone.trim(), addressLine1: biz.addressLine1.trim(), city: biz.city.trim(), region: biz.region.trim(), latitude: storePin.latitude, longitude: storePin.longitude } });
    router.replace('/dashboard');
  });
  const editBusinessAddress = (patch: Partial<typeof biz>) => {
    setBiz({ ...biz, ...patch });
    setStorePin(null);
    setPlacingStore(false);
    setError(null);
  };
  const doVehicle = () => wrap(async () => {
    if (!agree) throw new Error('Tick the Driver Partner Agreement to continue');
    if (!mover || !MOVER_VEHICLES[mover].some((v) => v.value === veh.vehicleType)) throw new Error('Choose your vehicle');
    // A rider's bike needs no make or plate here (the documents step asks for
    // what the vehicle needs); a taxi's details are required by the server.
    await becomePartner(mover === 'DRIVER'
      ? { role: 'MOVER', acceptAgreement: true, vehicleType: veh.vehicleType, vehicle: { make: veh.make.trim(), model: veh.model.trim(), year: Number(veh.year), color: veh.color.trim(), licensePlate: veh.licensePlate.trim() } }
      : { role: 'MOVER', acceptAgreement: true, vehicleType: veh.vehicleType });
    router.replace('/portal');
  });
  const chooseRole = (r: Role) => {
    if (r !== 'CUSTOMER') clearStorefrontContinuation();
    setRole(r);
    // Each mover starts on their own kind of vehicle.
    if (r === 'RIDER' || r === 'DRIVER') setVeh((current) => ({ ...current, vehicleType: MOVER_VEHICLES[r][0]!.value }));
    setStep('phone');
  };

  return (
    <main className={styles.page}>
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

        {step === 'role' && (
          <div className={styles.stackTight}>
            <h1 id="signup-title" className={styles.heading}>Who are you signing up as?</h1>
            <p className={styles.bodyCopy}>Every sign-up starts with your phone and a 6-digit code. Partners also accept their partner agreement.</p>
            {ROLES.map(({ role: r, title, desc, pictogram }) => {
              // [Item 7] Before launch, the public site cannot start a customer
              // account; businesses, riders and drivers can still sign up.
              const closed = r === 'CUSTOMER' && !orderingOpen;
              return (
                <button key={r} type="button" disabled={closed} onClick={() => chooseRole(r)} className={styles.roleButton}>
                  <span className={styles.roleIcon} data-role-tile={r === 'CUSTOMER' ? 'brand' : 'neutral'}><Pictogram name={pictogram} size={24} /></span>
                  <span className={styles.roleCopy}><span className={styles.roleTitle}>{title}</span><span className={styles.roleDescription}>{closed ? `Launching soon in ${launchCity()}` : desc}</span></span>
                </button>
              );
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

        {step === 'phone' && (
          <div className={styles.stack}>
            <h1 id="signup-title" className={styles.heading}>Confirm your phone</h1>
            <p className={styles.bodyCopy}>We’ll text you a code to confirm your number.</p>
            <div className={styles.field}>
              <label htmlFor="signup-phone" className={styles.label}>Phone number</label>
              <input id="signup-phone" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void doSend()} placeholder="+592 600 0001" className={styles.input} />
            </div>
            <button type="button" onClick={() => void doSend()} disabled={busy || phone.trim().length < 6} className={styles.primaryButton}>{busy ? 'Sending…' : 'Send code'}</button>
          </div>
        )}
        {step === 'code' && (
          <div className={styles.stack}>
            <h1 id="signup-title" className={styles.heading}>Enter your code</h1>
            <p className={styles.bodyCopy}>Enter the code sent to {phone}.</p>
            <div className={styles.field}>
              <label htmlFor="signup-code" className={styles.label}>Verification code</label>
              <input id="signup-code" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void doVerify()} placeholder="000000" className={`${styles.input} ${styles.codeInput}`} />
            </div>
            <button type="button" onClick={() => void doVerify()} disabled={busy || code.trim().length < 4} className={styles.primaryButton}>{busy ? 'Checking…' : 'Continue'}</button>
          </div>
        )}
        {step === 'name' && (
          <div className={styles.stackTight}>
            <h1 id="signup-title" className={styles.heading}>Your name</h1>
            <div className={styles.field}>
              <label htmlFor="signup-first" className={styles.label}>First name</label>
              <input id="signup-first" autoComplete="given-name" value={first} onChange={(e) => setFirst(e.target.value)} className={styles.input} />
            </div>
            <div className={styles.field}>
              <label htmlFor="signup-last" className={styles.label}>Last name</label>
              <input id="signup-last" autoComplete="family-name" value={last} onChange={(e) => setLast(e.target.value)} className={styles.input} />
            </div>
            <p className={styles.legal}>
              By creating an account you agree to the{' '}
              <a href="/legal/terms" target="_blank" rel="noreferrer" className={styles.inlineLink}>Terms of Service</a>{' '}
              and{' '}
              <a href="/legal/privacy" target="_blank" rel="noreferrer" className={styles.inlineLink}>Privacy Policy</a>.
            </p>
            <button type="button" onClick={() => void doRegister()} disabled={busy || !first.trim() || !last.trim()} className={styles.primaryButton}>{busy ? 'Creating…' : 'Create account'}</button>
          </div>
        )}
        {step === 'business' && (
          <div className={styles.stackTight}>
            <h1 id="signup-title" className={styles.heading}>Your business</h1>
            <div className={styles.field}><label htmlFor="business-name" className={styles.label}>Business name</label><input id="business-name" value={biz.name} onChange={(e) => setBiz({ ...biz, name: e.target.value })} className={styles.input} /></div>
            <div className={styles.field}><label htmlFor="business-type" className={styles.label}>Business type</label><select id="business-type" value={biz.vendorType} onChange={(e) => setBiz({ ...biz, vendorType: e.target.value })} className={styles.input}>
              <option value="RESTAURANT">Restaurant / food</option><option value="SUPERMARKET">Supermarket / grocery</option><option value="STORE">Shop / goods</option><option value="SERVICE">Services</option>
            </select></div>
            <div className={styles.field}><label htmlFor="business-street" className={styles.label}>Street address</label><input id="business-street" autoComplete="street-address" disabled={busy || placingStore} value={biz.addressLine1} onChange={(e) => editBusinessAddress({ addressLine1: e.target.value })} className={styles.input} /></div>
            <div className={styles.field}><label htmlFor="business-city" className={styles.label}>City or town</label><input id="business-city" autoComplete="address-level2" disabled={busy || placingStore} value={biz.city} onChange={(e) => editBusinessAddress({ city: e.target.value })} className={styles.input} /></div>
            <div className={styles.field}><label htmlFor="business-region" className={styles.label}>Region</label><input id="business-region" autoComplete="address-level1" disabled={busy || placingStore} value={biz.region} onChange={(e) => editBusinessAddress({ region: e.target.value })} className={styles.input} /></div>
            {placingStore ? (
              <StoreLocationPicker current={storePin} address={[biz.addressLine1, biz.city, biz.region].filter(Boolean).join(', ')} onConfirm={(pin) => { setStorePin(pin); closeStorePicker(); setError(null); }} onClose={closeStorePicker} />
            ) : (
              <>
                <button ref={storePinButton} type="button" disabled={busy || !biz.addressLine1.trim() || !biz.city.trim()} className={styles.roleButton} onClick={() => { setError(null); setPlacingStore(true); }}>{storePin ? 'Move the store pin' : 'Place your store on the map'}</button>
                {storePin && <p role="status" className={styles.bodyCopy}>Store location confirmed: {storePin.address ?? biz.addressLine1}.</p>}
              </>
            )}
            <PartnerAgreement kind="Vendor" doc="vendor-agreement" agree={agree} onChange={setAgree} />
            <button type="button" onClick={() => void doBusiness()} disabled={busy || !agree || placingStore || !storePin || !biz.name.trim() || !biz.addressLine1.trim() || !biz.city.trim() || !biz.region.trim()} className={styles.primaryButton}>{busy ? 'Setting up…' : 'Create business'}</button>
            <p className={styles.smallCopy}>You’ll finish verification (documents) in your dashboard before going live.</p>
          </div>
        )}
        {step === 'vehicle' && mover && (
          <div className={styles.stackTight}>
            <h1 id="signup-title" className={styles.heading}>{mover === 'DRIVER' ? 'Your taxi' : 'How you deliver'}</h1>
            <div className={styles.field}><label htmlFor="vehicle-type" className={styles.label}>Vehicle</label><select id="vehicle-type" value={veh.vehicleType} onChange={(e) => setVeh({ ...veh, vehicleType: e.target.value })} className={styles.input}>
              {MOVER_VEHICLES[mover].map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select></div>
            {mover === 'DRIVER' ? (
              <>
                <div className={styles.field}><label htmlFor="vehicle-make" className={styles.label}>Make</label><input id="vehicle-make" value={veh.make} onChange={(e) => setVeh({ ...veh, make: e.target.value })} className={styles.input} /></div>
                <div className={styles.field}><label htmlFor="vehicle-model" className={styles.label}>Model</label><input id="vehicle-model" value={veh.model} onChange={(e) => setVeh({ ...veh, model: e.target.value })} className={styles.input} /></div>
                <div className={styles.field}><label htmlFor="vehicle-year" className={styles.label}>Year</label><input id="vehicle-year" inputMode="numeric" value={veh.year} onChange={(e) => setVeh({ ...veh, year: e.target.value })} className={styles.input} /></div>
                <div className={styles.field}><label htmlFor="vehicle-color" className={styles.label}>Colour</label><input id="vehicle-color" value={veh.color} onChange={(e) => setVeh({ ...veh, color: e.target.value })} className={styles.input} /></div>
                <div className={styles.field}><label htmlFor="vehicle-plate" className={styles.label}>Licence plate</label><input id="vehicle-plate" value={veh.licensePlate} onChange={(e) => setVeh({ ...veh, licensePlate: e.target.value })} className={styles.input} /></div>
              </>
            ) : null}
            <PartnerAgreement kind="Driver" doc="driver-agreement" agree={agree} onChange={setAgree} />
            {mover === 'DRIVER' ? (
              <button type="button" onClick={() => void doVehicle()} disabled={busy || !agree || !veh.make.trim() || !veh.model.trim() || !veh.color.trim() || !veh.licensePlate.trim() || !vehicleYearAccepted(veh.year)} className={styles.primaryButton}>{busy ? 'Setting up…' : 'Create driver account'}</button>
            ) : (
              <button type="button" onClick={() => void doVehicle()} disabled={busy || !agree} className={styles.primaryButton}>{busy ? 'Setting up…' : 'Create rider account'}</button>
            )}
            <p className={styles.smallCopy}>You’ll upload your documents in your earner dashboard before going online.</p>
          </div>
        )}

        {error ? <p className={styles.error} role="alert" aria-live="assertive">{error}</p> : null}
      </section>
    </main>
  );
}
