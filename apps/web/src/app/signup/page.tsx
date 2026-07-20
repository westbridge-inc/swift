'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ShoppingBag, Store, Car, ChevronLeft } from 'lucide-react';
import { sendOtp } from '@/lib/auth';
import { verifyOtp, registerAccount, becomePartner } from '@/lib/customer';
import { SwiftLogo } from '@/components/swift-logo';

type Role = 'CUSTOMER' | 'VENDOR' | 'MOVER';
type Step = 'role' | 'phone' | 'code' | 'name' | 'business' | 'vehicle';

const ROLES: { role: Role; title: string; desc: string; Icon: any }[] = [
  { role: 'CUSTOMER', title: 'Order on Swift', desc: 'Food, groceries, shops & rides', Icon: ShoppingBag },
  { role: 'VENDOR', title: 'Put my business on Swift', desc: 'Take orders, keep 100%', Icon: Store },
  { role: 'MOVER', title: 'Drive & deliver', desc: 'Earn on your schedule', Icon: Car },
];

function coords(): Promise<{ lat: number; lng: number }> {
  return new Promise((res) => {
    if (!navigator.geolocation) return res({ lat: 6.8013, lng: -58.1551 });
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res({ lat: 6.8013, lng: -58.1551 }), { timeout: 5000 });
  });
}

export default function SignupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('role');
  const [role, setRole] = useState<Role>('CUSTOMER');
  const [phone, setPhone] = useState('+592');
  const [code, setCode] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [biz, setBiz] = useState({ name: '', vendorType: 'RESTAURANT', addressLine1: '', city: 'Georgetown' });
  const [veh, setVeh] = useState({ vehicleType: 'MOTORCYCLE', make: '', model: '', color: '', licensePlate: '', year: '2021' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wrap = async (fn: () => Promise<void>) => { setError(null); setBusy(true); try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };

  const doSend = () => wrap(async () => { await sendOtp(phone.trim()); setStep('code'); });
  const doVerify = () => wrap(async () => {
    const r = await verifyOtp(phone.trim(), code.trim());
    if (r.signedIn) {
      // Existing account: route by its ACTUAL roles, not the tile they tapped.
      const roles: string[] = r.user?.roles ?? [];
      const isVendor = roles.includes('VENDOR') || roles.includes('VENDOR_OWNER') || !!r.user?.vendorOwner;
      const isMover = roles.some((x) => ['MOVER', 'RIDER', 'DRIVER'].includes(x));
      router.replace(isVendor ? '/dashboard' : isMover ? '/portal' : '/order');
      return;
    }
    setStep('name');
  });
  const doRegister = () => wrap(async () => {
    // Consent is explicit clickwrap: the agreement line sits directly above
    // the button that triggers this. Recorded server-side [SWIFT-AUD-D9-03].
    await registerAccount({ phone: phone.trim(), firstName: first.trim(), lastName: last.trim() || 'Swift', role, acceptTerms: true });
    if (role === 'CUSTOMER') router.replace('/order');
    else setStep(role === 'VENDOR' ? 'business' : 'vehicle');
  });
  const doBusiness = () => wrap(async () => {
    const c = await coords();
    await becomePartner({ role: 'VENDOR', business: { name: biz.name.trim(), vendorType: biz.vendorType, phone: phone.trim(), addressLine1: biz.addressLine1.trim(), city: biz.city, region: 'Demerara-Mahaica', latitude: c.lat, longitude: c.lng } });
    router.replace('/dashboard');
  });
  const doVehicle = () => wrap(async () => {
    await becomePartner({ role: 'MOVER', vehicleType: veh.vehicleType, vehicle: { make: veh.make.trim() || 'Toyota', model: veh.model.trim() || 'Axio', year: Number(veh.year) || 2021, color: veh.color.trim() || 'White', licensePlate: veh.licensePlate.trim() } });
    router.replace('/portal');
  });

  const input = 'w-full rounded-lg border border-black/10 px-3 py-2.5 text-sm focus:border-[var(--swift-red)] focus:outline-none';
  const primary = 'w-full rounded-lg bg-[var(--swift-red)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--swift-red-600)] disabled:opacity-50';

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--swift-subtle)] p-4">
      <div className="w-full max-w-md rounded-2xl border border-black/5 bg-white p-8 shadow-sm">
        {step !== 'role' && <button onClick={() => setStep(step === 'code' ? 'phone' : step === 'phone' ? 'role' : step === 'name' ? 'code' : 'name')} className="mb-3 flex items-center gap-1 text-sm font-semibold text-[var(--swift-muted)]"><ChevronLeft className="h-4 w-4" /> Back</button>}
        <Link href="/" aria-label="Swift home"><SwiftLogo /></Link>

        {step === 'role' && (
          <div className="mt-5 space-y-3">
            <p className="font-bold">What brings you to Swift?</p>
            {ROLES.map(({ role: r, title, desc, Icon }) => (
              <button key={r} onClick={() => { setRole(r); setStep('phone'); }} className="flex w-full items-center gap-3 rounded-2xl border border-black/10 p-4 text-left hover:border-[var(--swift-red)] hover:bg-[var(--swift-red-50)]">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--swift-red-50)]"><Icon className="h-5.5 w-5.5 text-[var(--swift-red)]" /></span>
                <span><span className="block font-bold">{title}</span><span className="block text-sm text-[var(--swift-muted)]">{desc}</span></span>
              </button>
            ))}
            <p className="pt-2 text-sm text-[var(--swift-muted)]">Already on Swift? <Link href="/login?next=/order" className="font-semibold text-[var(--swift-red)]">Sign in</Link></p>
          </div>
        )}

        {step === 'phone' && (
          <div className="mt-5 space-y-4">
            <p className="text-sm text-[var(--swift-muted)]">We’ll text you a code to confirm your number.</p>
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doSend()} placeholder="+592 600 0001" className={input} />
            <button onClick={doSend} disabled={busy || phone.trim().length < 6} className={primary}>{busy ? 'Sending…' : 'Send code'}</button>
          </div>
        )}
        {step === 'code' && (
          <div className="mt-5 space-y-4">
            <p className="text-sm text-[var(--swift-muted)]">Enter the code sent to {phone}.</p>
            <input inputMode="numeric" autoFocus value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doVerify()} placeholder="000000" className={`${input} tracking-widest`} />
            <button onClick={doVerify} disabled={busy || code.trim().length < 4} className={primary}>{busy ? 'Checking…' : 'Continue'}</button>
          </div>
        )}
        {step === 'name' && (
          <div className="mt-5 space-y-3">
            <p className="font-bold">Your name</p>
            <input value={first} onChange={(e) => setFirst(e.target.value)} placeholder="First name" className={input} />
            <input value={last} onChange={(e) => setLast(e.target.value)} placeholder="Last name" className={input} />
            <p className="text-xs text-[var(--swift-muted)]">
              By creating an account you agree to the{' '}
              <a href="/legal/terms" target="_blank" rel="noreferrer" className="font-semibold text-[var(--swift-red)]">Terms of Service</a>{' '}
              and{' '}
              <a href="/legal/privacy" target="_blank" rel="noreferrer" className="font-semibold text-[var(--swift-red)]">Privacy Policy</a>.
            </p>
            <button onClick={doRegister} disabled={busy || !first.trim()} className={primary}>{busy ? 'Creating…' : 'Create account'}</button>
          </div>
        )}
        {step === 'business' && (
          <div className="mt-5 space-y-3">
            <p className="font-bold">Your business</p>
            <input value={biz.name} onChange={(e) => setBiz({ ...biz, name: e.target.value })} placeholder="Business name" className={input} />
            <select value={biz.vendorType} onChange={(e) => setBiz({ ...biz, vendorType: e.target.value })} className={input}>
              <option value="RESTAURANT">Restaurant / food</option><option value="SUPERMARKET">Supermarket / grocery</option><option value="STORE">Shop / goods</option><option value="SERVICE">Services</option>
            </select>
            <input value={biz.addressLine1} onChange={(e) => setBiz({ ...biz, addressLine1: e.target.value })} placeholder="Street address" className={input} />
            <input value={biz.city} onChange={(e) => setBiz({ ...biz, city: e.target.value })} placeholder="City" className={input} />
            <button onClick={doBusiness} disabled={busy || !biz.name.trim() || !biz.addressLine1.trim()} className={primary}>{busy ? 'Setting up…' : 'Create business (uses your location)'}</button>
            <p className="text-xs text-[var(--swift-muted)]">You’ll finish verification (documents) in your dashboard before going live.</p>
          </div>
        )}
        {step === 'vehicle' && (
          <div className="mt-5 space-y-3">
            <p className="font-bold">Your vehicle</p>
            <select value={veh.vehicleType} onChange={(e) => setVeh({ ...veh, vehicleType: e.target.value })} className={input}>
              <option value="MOTORCYCLE">Motorcycle / bicycle (deliveries)</option><option value="CAR">Car (taxi & deliveries)</option>
            </select>
            <input value={veh.make} onChange={(e) => setVeh({ ...veh, make: e.target.value })} placeholder="Make (e.g. Toyota)" className={input} />
            <input value={veh.model} onChange={(e) => setVeh({ ...veh, model: e.target.value })} placeholder="Model" className={input} />
            <input value={veh.licensePlate} onChange={(e) => setVeh({ ...veh, licensePlate: e.target.value })} placeholder="Licence plate" className={input} />
            <button onClick={doVehicle} disabled={busy || !veh.licensePlate.trim()} className={primary}>{busy ? 'Setting up…' : 'Create driver account'}</button>
            <p className="text-xs text-[var(--swift-muted)]">You’ll upload your documents in your earner dashboard before going online.</p>
          </div>
        )}

        {error && <p className="mt-4 text-sm text-[var(--swift-red)]">{error}</p>}
      </div>
    </div>
  );
}
