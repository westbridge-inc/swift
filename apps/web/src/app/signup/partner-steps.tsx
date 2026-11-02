'use client';

// ---------------------------------------------------------------------------
// [D6 · WEB-ONBOARDING · perf · COORD-approved 1 Nov 2026] The sign-up's business and vehicle steps, loaded on demand.
// Only partners reach them, so the sign-up page's first load (the role, phone, code and name steps every visitor sees)
// no longer carries them: the store form, its map-picker and own-name loaders, the taxi form and its plate rule, the
// "what is missing" asks, the weekly fee block's loader and the partner agreement tick. The page starts loading this
// module on a partner's name step, before "Create account" is tapped (partner-steps-loader.ts; page-size.test.ts).
// Everything here behaves exactly as it did inside the page; what the person typed lives in the page (`draft`), so
// going Back and forward keeps it.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { LEGAL_URL } from '@/lib/legal-url';
import { becomePartner, signOwnName } from '@/lib/customer-account';
import { ownNameStoreType } from '@/lib/own-name-store-type';
import { AGREEMENT, agreementAsk, businessAsk, EXAMPLE, LIMIT, taxiAsk } from '@/lib/signup-fields';
import { isHirePlate, MOVER_VEHICLES, TAXI_PLATE_ERROR, TAXI_PLATE_HINT, type MoverRole } from '@/lib/signup-roles';
import type { StoreLocationPicker as StoreLocationPickerComponent } from '@/components/store-location-picker';
import { loadStorePicker } from './store-picker-loader';
// [Row 628] The weekly fee block (its price read, words and tick) loads on the partner steps only.
import type { WeeklyFee as WeeklyFeeComponent } from './weekly-fee';
import type { FeeState } from '@/lib/signup-fee';
import { loadWeeklyFee } from './weekly-fee-loader';
import type { OwnNameChoice as OwnNameChoiceComponent } from './own-name-choice';
import { loadOwnNameChoice } from './own-name-loader';
import { STORE_PIN_OUTSIDE, storePinInMarket, type StorePin } from '@/lib/store-pin';
import { TAXI_TWO_LICENCES } from '@/lib/taxi-documents';
import { guyanaPhone } from '@/lib/guyana-phone';
import styles from '../auth-flow.module.css';

/** What a partner step needs from the page: the account's phone, the page's busy/error handling, and where to go next. */
export interface StepShell {
  phone: string;
  busy: boolean;
  wrap: (_fn: () => Promise<void>) => Promise<void>;
  setError: (_error: string | null) => void;
  done: (_path: string) => void;
}

/** The server's rule for a taxi's year (partner.routes vehicle schema): 1980
 *  to next year. Checked here too, so a typo is caught before the round trip. */
function vehicleYearAccepted(year: string): boolean {
  const n = Number(year);
  return Number.isInteger(n) && n >= 1980 && n <= new Date().getFullYear() + 1;
}

/** Until the weekly fee block reports, the partner buttons wait for it. */
const FEE_LOADING: FeeState = { ask: 'Loading your weekly fee…' };

/** [WEB-ONBOARDING] Under a waiting partner button: the first thing missing, or nothing. */
const askLine = (ask: string | null) => (ask ? <p className={styles.smallCopy} aria-live="polite" data-signup-ask>{ask}</p> : null);

/** The partner agreement clickwrap: unticked until the person ticks it. [WEB-ONBOARDING] Named by the document's own
 *  title (the Business Agreement, the Mover Agreement), as the app and the console's legal gate name it. */
function PartnerAgreement({ name, doc, agree, onChange }: {
  name: string;
  doc: 'vendor-agreement' | 'driver-agreement';
  agree: boolean;
  onChange: (_next: boolean) => void;
}) {
  return (
    <label className={styles.legal} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
      <input type="checkbox" checked={agree} onChange={(e) => onChange(e.target.checked)} />
      <span>
        I agree to the{' '}
        <a href={LEGAL_URL(doc)} target="_blank" rel="noreferrer" className={styles.inlineLink}>{name}</a>
      </span>
    </label>
  );
}

/**
 * The weekly fee on a partner step and the agreement tick beside it. [COORD ruling 22 Oct 2026 · row 628] The fee is on
 * screen before a partner signs up: the block reports what the button may do, and a refused tick (the fee changed)
 * remounts it to read the price again. Nobody pays here: the fee starts only after approval. Both start empty on each
 * step (each step is its own component), so a tick never carries from one agreement to the other.
 */
function usePartnerTerms() {
  const [agree, setAgree] = useState(false);
  const [fee, setFee] = useState<FeeState>(FEE_LOADING);
  const [feeEpoch, setFeeEpoch] = useState(0);
  const [WeeklyFee, setWeeklyFee] = useState<typeof WeeklyFeeComponent | null>(null);
  const [feeLoadFailed, setFeeLoadFailed] = useState(false);
  useEffect(() => {
    if (WeeklyFee || feeLoadFailed) return;
    loadWeeklyFee().then((m) => setWeeklyFee(() => m.WeeklyFee), () => setFeeLoadFailed(true));
  }, [WeeklyFee, feeLoadFailed]);
  /** A refused tick (WEEKLY_FEE_*: the fee changed since it was read) reads the price again, with the tick cleared. */
  const feeChecked = (call: Promise<unknown>) => call.catch((e: { code?: unknown }) => {
    if (typeof e?.code === 'string' && e.code.startsWith('WEEKLY_FEE_')) setFeeEpoch((n) => n + 1);
    throw e;
  });
  const feeBlock = (feeRole: 'VENDOR' | 'MOVER', type: string): ReactNode => (WeeklyFee
    ? <WeeklyFee key={feeEpoch} role={feeRole} type={type} onChange={setFee} />
    : feeLoadFailed
      ? <button type="button" className={styles.roleButton} onClick={() => setFeeLoadFailed(false)}>Couldn’t load your weekly fee — try again</button>
      : <p role="status" className={styles.smallCopy}>{FEE_LOADING.ask}</p>);
  // [WEB-ONBOARDING] the agreement is what is missing once the fee block has nothing to ask
  const agreementWait = (name: string) => (fee.ask || agree ? null : agreementAsk(name));
  return { agree, setAgree, fee, feeChecked, feeBlock, agreementWait };
}

/** What a store owner has typed on the business step (kept by the page across Back and forward). */
export interface BusinessDraft {
  biz: { name: string; vendorType: string; addressLine1: string; city: string; region: string };
  /** [ROLE-DOCS · owner 21 Oct 2026] own name (no business registration, BNA s.3) or a business name; the declaration tick */
  nameBasis: 'REGISTERED' | 'OWN_NAME';
  ownNameTick: boolean;
  storePin: StorePin | null;
}
const NEW_BUSINESS: BusinessDraft = { biz: { name: '', vendorType: 'RESTAURANT', addressLine1: '', city: '', region: '' }, nameBasis: 'REGISTERED', ownNameTick: false, storePin: null };

export function BusinessStep({ shell, draft, onDraft }: { shell: StepShell; draft: BusinessDraft | null; onDraft: (_draft: BusinessDraft) => void }) {
  const { phone, busy, wrap, setError, done } = shell;
  const [d, setD] = useState<BusinessDraft>(() => draft ?? NEW_BUSINESS);
  useEffect(() => { onDraft(d); }, [d, onDraft]);
  const { biz, nameBasis, ownNameTick, storePin } = d;
  const setBiz = (next: BusinessDraft['biz']) => setD((cur) => ({ ...cur, biz: next }));
  const setNameBasis = (next: BusinessDraft['nameBasis']) => setD((cur) => ({ ...cur, nameBasis: next }));
  const setOwnNameTick = (next: boolean) => setD((cur) => ({ ...cur, ownNameTick: next }));
  const setStorePin = (next: StorePin | null) => setD((cur) => ({ ...cur, storePin: next }));
  const terms = usePartnerTerms();
  const { agree, setAgree, fee } = terms;
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
  // [PERF] The map picker (with its place search and location code) is needed only to place the store, so its code
  // starts loading as soon as this step shows, before the tap; a failed fetch says so in place and can be tried again,
  // the form kept as typed. Its stylesheet stays in the page, so the picker's code arrives alone.
  const [StoreLocationPicker, setStoreLocationPicker] = useState<typeof StoreLocationPickerComponent | null>(null);
  const [pickerFailed, setPickerFailed] = useState(false);
  const pickerLoading = useRef(false);
  const loadPicker = useCallback(() => {
    if (pickerLoading.current) return;
    pickerLoading.current = true;
    setPickerFailed(false);
    loadStorePicker()
      .then((module) => setStoreLocationPicker(() => module.StoreLocationPicker))
      .catch(() => setPickerFailed(true))
      .finally(() => { pickerLoading.current = false; });
  }, []);
  useEffect(() => { if (!StoreLocationPicker) loadPicker(); }, [StoreLocationPicker, loadPicker]);
  // [ROLE-DOCS · #2046 · perf] The own-name choice and its declaration load for a store type asked for a business
  // registration; until then the store is registered-name (the default), so nothing is lost.
  const [OwnNameChoice, setOwnNameChoice] = useState<typeof OwnNameChoiceComponent | null>(null);
  const [ownNameLoadFailed, setOwnNameLoadFailed] = useState(false);
  const ownNameType = ownNameStoreType(biz.vendorType);
  useEffect(() => {
    if (!ownNameType || OwnNameChoice || ownNameLoadFailed) return;
    loadOwnNameChoice().then((m) => setOwnNameChoice(() => m.OwnNameChoice), () => setOwnNameLoadFailed(true));
  }, [ownNameType, OwnNameChoice, ownNameLoadFailed]);
  // [WEB-ONBOARDING · owner 1 Nov 2026] While the button waits, one line under it names the first thing missing, in the
  // app's words (#947's grammar), held to the server's shortest values. The weekly fee block says its own ask.
  const storeAsk = businessAsk(biz, !!storePin);

  const doBusiness = () => wrap(async () => {
    if (!storePin || placingStore) throw new Error('Place your store on the map');
    if (!storePinInMarket(storePin)) throw new Error(STORE_PIN_OUTSIDE);
    const ownName = nameBasis === 'OWN_NAME' && ownNameType;
    if (ownName && !ownNameTick) throw new Error('Sign the own-name declaration to continue');
    if (fee.ask) throw new Error(fee.ask);
    if (!agree) throw new Error(agreementAsk(AGREEMENT.business));
    await terms.feeChecked(becomePartner({ role: 'VENDOR', acceptAgreement: true, ...(fee.ack && { weeklyFeeAck: fee.ack }), business: { name: biz.name.trim(), vendorType: biz.vendorType, phone: guyanaPhone(phone), addressLine1: biz.addressLine1.trim(), city: biz.city.trim(), region: biz.region.trim(), latitude: storePin.latitude, longitude: storePin.longitude, ...(ownName ? { nameBasis: 'OWN_NAME' } : {}) } }));
    // The store exists: the ticked declaration is signed now (the app's Documents offers it again if this fails).
    if (ownName) await signOwnName().catch(() => undefined);
    done('/dashboard');
  });
  const editBusinessAddress = (patch: Partial<BusinessDraft['biz']>) => {
    setD((cur) => ({ ...cur, biz: { ...cur.biz, ...patch }, storePin: null }));
    setPlacingStore(false);
    setError(null);
  };

  return (
    <div className={styles.stackTight}>
      <h1 id="signup-title" className={styles.heading}>Your business</h1>
      <div className={styles.field}><label htmlFor="business-name" className={styles.label}>Business name</label><input id="business-name" maxLength={LIMIT.business} placeholder={nameBasis === 'OWN_NAME' && ownNameType ? EXAMPLE.ownName : EXAMPLE.business} value={biz.name} onChange={(e) => setBiz({ ...biz, name: e.target.value })} className={styles.input} /></div>
      <div className={styles.field}><label htmlFor="business-type" className={styles.label}>Business type</label><select id="business-type" value={biz.vendorType} onChange={(e) => setBiz({ ...biz, vendorType: e.target.value })} className={styles.input}>
        <option value="RESTAURANT">Restaurant / food</option><option value="SUPERMARKET">Supermarket / grocery</option><option value="STORE">Shop / goods</option><option value="SERVICE">Services</option>
      </select></div>
      {ownNameType ? (OwnNameChoice
        ? <OwnNameChoice storeName={biz.name} nameBasis={nameBasis} onNameBasis={setNameBasis} tick={ownNameTick} onTick={setOwnNameTick} />
        : ownNameLoadFailed
          ? <button type="button" className={styles.roleButton} onClick={() => setOwnNameLoadFailed(false)}>Couldn’t load the store-name choice — try again</button>
          : null) : null}
      <div className={styles.field}><label htmlFor="business-street" className={styles.label}>Street address</label><input id="business-street" autoComplete="street-address" maxLength={LIMIT.street} placeholder={EXAMPLE.street} disabled={busy || placingStore} value={biz.addressLine1} onChange={(e) => editBusinessAddress({ addressLine1: e.target.value })} className={styles.input} /></div>
      <div className={styles.field}><label htmlFor="business-city" className={styles.label}>City or town</label><input id="business-city" autoComplete="address-level2" maxLength={LIMIT.city} placeholder={EXAMPLE.city} disabled={busy || placingStore} value={biz.city} onChange={(e) => editBusinessAddress({ city: e.target.value })} className={styles.input} /></div>
      <div className={styles.field}><label htmlFor="business-region" className={styles.label}>Region (optional)</label><input id="business-region" autoComplete="address-level1" maxLength={LIMIT.region} placeholder={EXAMPLE.region} disabled={busy || placingStore} value={biz.region} onChange={(e) => editBusinessAddress({ region: e.target.value })} className={styles.input} /></div>
      {placingStore ? (
        StoreLocationPicker ? <StoreLocationPicker current={storePin} address={[biz.addressLine1, biz.city, biz.region].filter(Boolean).join(', ')} onConfirm={(pin) => { setStorePin(pin); closeStorePicker(); setError(null); }} onClose={closeStorePicker} />
        : pickerFailed ? (
          <div role="alert" className={styles.stackTight}>
            <p className={styles.bodyCopy}>The map didn’t load. Check your connection; what you typed is kept.</p>
            <button type="button" className={styles.roleButton} onClick={loadPicker}>Try again</button>
            <button type="button" className={styles.roleButton} onClick={closeStorePicker}>Back</button>
          </div>
        ) : <p role="status" className={styles.bodyCopy}>Loading the map…</p>
      ) : (
        <>
          <button ref={storePinButton} type="button" disabled={busy || !biz.addressLine1.trim() || !biz.city.trim()} className={styles.roleButton} onClick={() => { setError(null); setPlacingStore(true); if (!StoreLocationPicker) loadPicker(); }}>{storePin ? 'Move the store pin' : 'Place your store on the map'}</button>
          {storePin && <p role="status" className={styles.bodyCopy}>Store location confirmed: {storePin.address ?? biz.addressLine1}.</p>}
        </>
      )}
      {terms.feeBlock('VENDOR', biz.vendorType)}
      <PartnerAgreement name={AGREEMENT.business} doc="vendor-agreement" agree={agree} onChange={setAgree} />
      {/* [WEB-ONBOARDING] the region is optional, as on the server and in the app (which never asks it) */}
      <button type="button" onClick={() => void doBusiness()} disabled={busy || !!fee.ask || !agree || placingStore || !!storeAsk} className={styles.primaryButton}>{busy ? 'Setting up…' : 'Create business'}</button>
      {askLine(placingStore ? null : storeAsk ?? terms.agreementWait(AGREEMENT.business))}
      <p className={styles.smallCopy}>You’ll finish verification (documents) in your dashboard before going live.</p>
    </div>
  );
}

/** What a rider or taxi driver has typed on the vehicle step (kept by the page across Back and forward). */
export interface VehicleDraft { mover: MoverRole; vehicleType: string; make: string; model: string; color: string; licensePlate: string; year: string }
/** Each mover starts on their own kind of vehicle. */
const newVehicle = (mover: MoverRole): VehicleDraft => ({ mover, vehicleType: MOVER_VEHICLES[mover][0]!.value, make: '', model: '', color: '', licensePlate: '', year: '' });

export function VehicleStep({ shell, mover, draft, onDraft }: { shell: StepShell; mover: MoverRole; draft: VehicleDraft | null; onDraft: (_draft: VehicleDraft) => void }) {
  const { busy, wrap, done } = shell;
  const [veh, setVeh] = useState<VehicleDraft>(() => (draft && draft.mover === mover ? draft : newVehicle(mover)));
  useEffect(() => { onDraft(veh); }, [veh, onDraft]);
  const terms = usePartnerTerms();
  const { agree, setAgree, fee } = terms;
  // A Driver's vehicles are taxis (car / wagon car): their plate starts with H.
  const taxiPlateWrong = !!veh.licensePlate.trim() && MOVER_VEHICLES.DRIVER.some((v) => v.value === veh.vehicleType) && !isHirePlate(veh.licensePlate);
  // [WEB-ONBOARDING] the first missing detail; a non-H taxi plate says why under the plate box (the red line is the ask)
  const vehicleAsk = mover === 'DRIVER'
    ? (taxiPlateWrong ? null : taxiAsk(veh, vehicleYearAccepted(veh.year)) ?? terms.agreementWait(AGREEMENT.mover))
    : terms.agreementWait(AGREEMENT.mover);
  const doVehicle = () => wrap(async () => {
    if (fee.ask) throw new Error(fee.ask);
    if (!agree) throw new Error(agreementAsk(AGREEMENT.mover));
    if (!MOVER_VEHICLES[mover].some((v) => v.value === veh.vehicleType)) throw new Error('Choose your vehicle');
    // A rider's bike needs no make or plate here (the documents step asks for
    // what the vehicle needs); a taxi's details are required by the server.
    const weeklyFee = fee.ack && { weeklyFeeAck: fee.ack };
    await terms.feeChecked(becomePartner(mover === 'DRIVER'
      ? { role: 'MOVER', acceptAgreement: true, ...weeklyFee, vehicleType: veh.vehicleType, vehicle: { make: veh.make.trim(), model: veh.model.trim(), year: Number(veh.year), color: veh.color.trim(), licensePlate: veh.licensePlate.trim() } }
      : { role: 'MOVER', acceptAgreement: true, ...weeklyFee, vehicleType: veh.vehicleType }));
    done('/portal');
  });

  return (
    <div className={styles.stackTight}>
      <h1 id="signup-title" className={styles.heading}>{mover === 'DRIVER' ? 'Your taxi' : 'How you deliver'}</h1>
      <div className={styles.field}><label htmlFor="vehicle-type" className={styles.label}>Vehicle</label><select id="vehicle-type" value={veh.vehicleType} onChange={(e) => setVeh({ ...veh, vehicleType: e.target.value })} className={styles.input}>
        {MOVER_VEHICLES[mover].map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
      </select></div>
      {mover === 'DRIVER' ? (
        <>
          {/* [Owner ruling 11 Oct 2026] what a taxi driver will upload, said at sign-up */}
          <p className={styles.smallCopy}>{TAXI_TWO_LICENCES}</p>
          <div className={styles.field}><label htmlFor="vehicle-make" className={styles.label}>Make</label><input id="vehicle-make" maxLength={LIMIT.make} placeholder={EXAMPLE.make} value={veh.make} onChange={(e) => setVeh({ ...veh, make: e.target.value })} className={styles.input} /></div>
          <div className={styles.field}><label htmlFor="vehicle-model" className={styles.label}>Model</label><input id="vehicle-model" maxLength={LIMIT.model} placeholder={EXAMPLE.model} value={veh.model} onChange={(e) => setVeh({ ...veh, model: e.target.value })} className={styles.input} /></div>
          <div className={styles.field}><label htmlFor="vehicle-year" className={styles.label}>Year</label><input id="vehicle-year" inputMode="numeric" maxLength={LIMIT.year} placeholder={EXAMPLE.year} value={veh.year} onChange={(e) => setVeh({ ...veh, year: e.target.value })} className={styles.input} /></div>
          <div className={styles.field}><label htmlFor="vehicle-color" className={styles.label}>Colour</label><input id="vehicle-color" maxLength={LIMIT.color} placeholder={EXAMPLE.color} value={veh.color} onChange={(e) => setVeh({ ...veh, color: e.target.value })} className={styles.input} /></div>
          <div className={styles.field}><label htmlFor="vehicle-plate" className={styles.label}>Licence plate</label><input id="vehicle-plate" autoCapitalize="characters" maxLength={LIMIT.plate} placeholder={EXAMPLE.plate} value={veh.licensePlate} onChange={(e) => setVeh({ ...veh, licensePlate: e.target.value })} className={styles.input} aria-describedby="vehicle-plate-rule" aria-invalid={taxiPlateWrong || undefined} />
            {/* [Owner ruling 11 Oct 2026 — H-PLATE] said where the plate is typed; the server refuses a non-H taxi plate too */}
            <p id="vehicle-plate-rule" className={taxiPlateWrong ? styles.error : styles.smallCopy} role={taxiPlateWrong ? 'alert' : undefined}>{taxiPlateWrong ? TAXI_PLATE_ERROR : TAXI_PLATE_HINT}</p></div>
        </>
      ) : null}
      {terms.feeBlock('MOVER', veh.vehicleType)}
      <PartnerAgreement name={AGREEMENT.mover} doc="driver-agreement" agree={agree} onChange={setAgree} />
      {mover === 'DRIVER' ? (
        <button type="button" onClick={() => void doVehicle()} disabled={busy || !!fee.ask || !agree || !veh.make.trim() || !veh.model.trim() || !veh.color.trim() || !veh.licensePlate.trim() || taxiPlateWrong || !vehicleYearAccepted(veh.year)} className={styles.primaryButton}>{busy ? 'Setting up…' : 'Create driver account'}</button>
      ) : (
        <button type="button" onClick={() => void doVehicle()} disabled={busy || !!fee.ask || !agree} className={styles.primaryButton}>{busy ? 'Setting up…' : 'Create rider account'}</button>
      )}
      {askLine(vehicleAsk)}
      <p className={styles.smallCopy}>You’ll upload your documents in your earner dashboard before going online.</p>
    </div>
  );
}
