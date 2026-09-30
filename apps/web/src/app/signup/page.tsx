'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ShoppingBag, Store, Car, ChevronLeft } from 'lucide-react';
import { sendOtp } from '@/lib/auth';
import { verifyOtp, registerAccount, becomePartner } from '@/lib/customer';
import { SwiftLogo } from '@/components/swift-logo';
import { StoreLocationPicker } from '@/components/store-location-picker';
import { DocumentChecklist, ServiceProviderDocuments } from '@/components/document-checklist';
import type { ChecklistRole } from '@/lib/verification';
import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';
import { STORE_PIN_OUTSIDE, storePinInMarket, type StorePin } from '@/lib/store-pin';
import styles from '../auth-flow.module.css';

type Role = 'CUSTOMER' | 'VENDOR' | 'MOVER';
type Step = 'role' | 'phone' | 'code' | 'name' | 'business' | 'vehicle';

function safeReturnPath(): string {
  if (typeof window === 'undefined') return '';
  const candidate = new URLSearchParams(window.location.search).get('next') ?? '';
  return /^\/(?!\/)/.test(candidate) && !candidate.includes('..') && !candidate.includes('\\') ? candidate : '';
}

const ROLES: { role: Role; title: string; desc: string; Icon: any }[] = [
  { role: 'CUSTOMER', title: 'Order on Swift', desc: 'Food, groceries, shops & rides', Icon: ShoppingBag },
  { role: 'VENDOR', title: 'Put my business on Swift', desc: 'Take orders, keep 100%', Icon: Store },
  { role: 'MOVER', title: 'Drive & deliver', desc: 'Earn on your schedule', Icon: Car },
];


export default function SignupPage() {
  const router = useRouter();
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
  const [agreement, setAgreement] = useState(false);
  const needsVehicleDetails = veh.vehicleType === 'CAR';
  const vehicleValid = !needsVehicleDetails || (veh.make.trim() && veh.model.trim() && veh.color.trim() && veh.licensePlate.trim() && Number.isInteger(Number(veh.year)) && Number(veh.year) >= 1980 && Number(veh.year) <= new Date().getFullYear() + 1);
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
      router.replace(customerReturnPath || (isVendor ? '/dashboard' : isMover ? '/portal' : '/'));
      return;
    }
    setStep('name');
  });
  const doRegister = () => wrap(async () => {
    // Consent is explicit clickwrap: the agreement line sits directly above
    // the button that triggers this. Recorded server-side [SWIFT-AUD-D9-03].
    try {
      await registerAccount({ phone: phone.trim(), firstName: first.trim(), lastName: last.trim(), role, acceptTerms: true });
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
      router.replace(safeReturnPath() || '/');
    }
    else setStep(role === 'VENDOR' ? 'business' : 'vehicle');
  });
  const doBusiness = () => wrap(async () => {
    if (!agreement) throw new Error('Accept the vendor agreement to continue.');
    if (!storePin || placingStore) throw new Error('Place your store on the map');
    if (!storePinInMarket(storePin)) throw new Error(STORE_PIN_OUTSIDE);
    await becomePartner({ role: 'VENDOR', acceptAgreement: true, business: { name: biz.name.trim(), vendorType: biz.vendorType, phone: phone.trim(), addressLine1: biz.addressLine1.trim(), city: biz.city.trim(), region: biz.region.trim(), latitude: storePin.latitude, longitude: storePin.longitude } });
    router.replace('/dashboard#documents');
  });
  const editBusinessAddress = (patch: Partial<typeof biz>) => {
    setBiz({ ...biz, ...patch });
    setStorePin(null);
    setPlacingStore(false);
    setError(null);
  };
  const doVehicle = () => wrap(async () => {
    if (!agreement || !vehicleValid) return;
    await becomePartner({ role: 'MOVER', acceptAgreement: true, vehicleType: veh.vehicleType, ...(needsVehicleDetails ? { vehicle: { make: veh.make.trim(), model: veh.model.trim(), year: Number(veh.year), color: veh.color.trim(), licensePlate: veh.licensePlate.trim() } } : {}) });
    router.replace('/portal/documents');
  });

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
        <Link href="/" aria-label="Swift home" className={styles.brandLink}><SwiftLogo /></Link>

        {step === 'role' && (
          <div className={styles.stackTight}>
            <h1 id="signup-title" className={styles.heading}>What brings you to Swift?</h1>
            {ROLES.map(({ role: r, title, desc, Icon }) => (
              <button key={r} type="button" onClick={() => { setRole(r); setAgreement(false); setStep('phone'); }} className={styles.roleButton}>
                <span className={styles.roleIcon}><Icon size={22} aria-hidden="true" /></span>
                <span className={styles.roleCopy}><span className={styles.roleTitle}>{title}</span><span className={styles.roleDescription}>{desc}</span></span>
              </button>
            ))}
            <p className={styles.inlineText}>Already on Swift? <Link
              href="/login?next=/"
              onClick={(event) => {
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
            {role !== 'CUSTOMER' ? <p className={styles.smallCopy}>After creating your account, you’ll see the documents required for your business or vehicle before finishing setup.</p> : null}
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
                {storePin && <p role="status" className={styles.bodyCopy}>Store location confirmed. {storePin.address ?? biz.addressLine1} — Latitude {storePin.latitude.toFixed(6)}, Longitude {storePin.longitude.toFixed(6)}</p>}
              </>
            )}
            <DocumentChecklist role={biz.vendorType as ChecklistRole} />
            <ServiceProviderDocuments />
            <label className={styles.smallCopy}><input type="checkbox" checked={agreement} onChange={(event) => setAgreement(event.target.checked)} /> I accept the <Link className={styles.inlineLink} href={`${BROWSER_API_ORIGIN}/legal/vendor-agreement`} target="_blank" rel="noreferrer">vendor agreement</Link>.</label>
            <button type="button" onClick={() => void doBusiness()} disabled={busy || !agreement || placingStore || !storePin || !biz.name.trim() || !biz.addressLine1.trim() || !biz.city.trim() || !biz.region.trim()} className={styles.primaryButton}>{busy ? 'Setting up…' : 'Create business'}</button>
            <p className={styles.smallCopy}>Your dashboard shows your checklist. Upload documents in the Swift phone app before going live.</p>
          </div>
        )}
        {step === 'vehicle' && (
          <div className={styles.stackTight}>
            <h1 id="signup-title" className={styles.heading}>Your vehicle</h1>
            <div className={styles.field}><label htmlFor="vehicle-type" className={styles.label}>Vehicle type</label><select id="vehicle-type" value={veh.vehicleType} onChange={(e) => setVeh({ ...veh, vehicleType: e.target.value })} className={styles.input}>
              <option value="BICYCLE">Bicycle (deliveries)</option><option value="MOTORCYCLE">Motorcycle (deliveries)</option><option value="CAR">Car (taxi & deliveries)</option>
            </select></div>
            {needsVehicleDetails ? <>
            <div className={styles.field}><label htmlFor="vehicle-make" className={styles.label}>Make</label><input id="vehicle-make" value={veh.make} onChange={(e) => setVeh({ ...veh, make: e.target.value })} className={styles.input} /></div>
            <div className={styles.field}><label htmlFor="vehicle-model" className={styles.label}>Model</label><input id="vehicle-model" value={veh.model} onChange={(e) => setVeh({ ...veh, model: e.target.value })} className={styles.input} /></div>
            <div className={styles.field}><label htmlFor="vehicle-year" className={styles.label}>Year</label><input id="vehicle-year" inputMode="numeric" value={veh.year} onChange={(e) => setVeh({ ...veh, year: e.target.value })} className={styles.input} /></div>
            <div className={styles.field}><label htmlFor="vehicle-color" className={styles.label}>Colour</label><input id="vehicle-color" value={veh.color} onChange={(e) => setVeh({ ...veh, color: e.target.value })} className={styles.input} /></div>
            <div className={styles.field}><label htmlFor="vehicle-plate" className={styles.label}>Licence plate</label><input id="vehicle-plate" value={veh.licensePlate} onChange={(e) => setVeh({ ...veh, licensePlate: e.target.value })} className={styles.input} /></div>
            </> : null}
            <DocumentChecklist role="MOVER" vehicleType={veh.vehicleType} />
            <label className={styles.smallCopy}><input type="checkbox" checked={agreement} onChange={(event) => setAgreement(event.target.checked)} /> I accept the <Link className={styles.inlineLink} href={`${BROWSER_API_ORIGIN}/legal/driver-agreement`} target="_blank" rel="noreferrer">driver agreement</Link>.</label>
            <button type="button" onClick={() => void doVehicle()} disabled={busy || !agreement || !vehicleValid} className={styles.primaryButton}>{busy ? 'Setting up…' : 'Create driver account'}</button>
            <p className={styles.smallCopy}>You’ll upload your documents in your earner dashboard before going online.</p>
          </div>
        )}

        {error ? <p className={styles.error} role="alert" aria-live="assertive">{error}</p> : null}
      </section>
    </main>
  );
}
