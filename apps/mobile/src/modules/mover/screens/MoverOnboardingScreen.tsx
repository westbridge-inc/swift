/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Card, LabeledInput, LinkText, PillButton, Screen, T } from '../../../kit';
import { SwiftMark } from '../../../components/SwiftLogo';
import { DocumentChecklist } from '../../../components/onboarding/DocumentChecklist';
import { PricingCard } from '../../../components/onboarding/PricingCard';
import { useVerificationStatus, useBecomePartner, useChangeVehicle } from '../../../hooks';
import { useStepUp, type MutationGuard } from '../../../hooks/useStepUp';
import { StepUpDismissed } from '../../../lib/stepUp';
import { VEHICLE_COPY, vehicleOffered } from '../../../lib/vehicleOffer';
import { usePartnerPricing } from '../../../hooks/partnerPricing';
import { moverQuote, quoteGate, QUOTE_GATE_COPY } from '../../../lib/partnerPricing';
import { API_URL, DRIVER_VEHICLE_KINDS, type VehicleKind } from '../../../services/api';
import { openPayLink } from '../../../lib/payLink';
import { useAuthStore } from '../../../stores/authStore';
import { RoleSwitcherSheet } from '../../../components/RoleSwitcherSheet';
import { GUTTER } from '../shared';

// The full Guyana fleet, small → large. Order matches the vehicle-class
// taxonomy on the server (config/vehicle-classes). Cars, wagon cars and buses
// provision a taxi Driver (and collect vehicle details below); bicycles,
// motorbikes, canters and box trucks register a delivery/courier Rider —
// details and commercial docs follow in the Documents step. [Launch vehicle
// list] The picker shows only the vehicles Swift takes on today
// (lib/vehicleOffer): canters and box trucks stay listed here for the day they
// are offered.
export const VTYPES: { key: VehicleKind; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap; hint: string }[] = [
  { key: 'BICYCLE', label: 'Bicycle', icon: 'bike', hint: 'Small deliveries' },
  { key: 'MOTORCYCLE', label: 'Motorbike', icon: 'moped', hint: 'Deliveries' },
  { key: 'CAR', label: 'Car', icon: 'car', hint: 'Taxi + delivery' },
  { key: 'WAGON_CAR', label: 'Wagon Car', icon: 'car-estate', hint: 'Taxi + larger loads' },
  { key: 'BUS_9', label: 'Bus (9-seater)', icon: 'van-passenger', hint: 'Groups & tours' },
  { key: 'BUS_15', label: 'Bus (15-seater)', icon: 'bus', hint: 'Groups & airport runs' },
  { key: 'CANTER_SHORT', label: 'Short-Base Canter (Open Back)', icon: 'truck-flatbed', hint: 'Open cargo' },
  { key: 'CANTER_LONG', label: 'Long-Base Canter (Open Back)', icon: 'truck-flatbed', hint: 'Large open cargo' },
  { key: 'BOX_TRUCK_SHORT', label: 'Short-Base Box Truck', icon: 'truck', hint: 'Enclosed cargo' },
  { key: 'BOX_TRUCK_LONG', label: 'Long-Base Box Truck', icon: 'truck-delivery', hint: 'Large enclosed cargo' },
];

function ValuePill({ icon, label }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 9999, paddingHorizontal: space.md, paddingVertical: 6, backgroundColor: color.brand[50] }}>
      <MaterialCommunityIcons name={icon} size={14} color={color.brand[600]} />
      <T variant="caption" weight="bold" tone="deep">
        {label}
      </T>
    </View>
  );
}

function VehicleRow({ v, active, onPress }: { v: (typeof VTYPES)[number]; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
      {({ pressed }) => (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            borderRadius: radius.lg,
            borderWidth: 1,
            padding: space.md,
            borderColor: active ? color.brand[500] : color.border.subtle,
            backgroundColor: active ? color.brand[50] : color.surface.base,
            opacity: pressed ? 0.85 : 1,
          }}
        >
          <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? color.brand[500] : color.surface.subtle }}>
            <MaterialCommunityIcons name={v.icon} size={22} color={active ? color.white : color.text.secondary} />
          </View>
          <View style={{ flex: 1 }}>
            <T variant="label" weight="bold" tone={active ? 'deep' : 'ink'}>
              {v.label}
            </T>
            <T variant="caption" tone="muted">
              {v.hint}
            </T>
          </View>
          <MaterialCommunityIcons
            name={active ? 'check-circle' : 'circle-outline'}
            size={22}
            color={active ? color.brand[500] : color.border.subtle}
          />
        </View>
      )}
    </Pressable>
  );
}

/**
 * The vehicle picker. `join` saves the first vehicle (/become, with the Mover
 * Agreement); `change` replaces the saved one (PUT /partner/vehicle), which
 * takes the mover offline and retires the old vehicle's papers. A verified
 * mover steps up first (`guard`).
 */
export function VehicleSetup({
  vt, setVt, onDone, mode = 'join', current = null, guard,
}: {
  vt: VehicleKind;
  setVt: (v: VehicleKind) => void;
  /** `changed` is false when the server found this was already the saved vehicle. */
  onDone: (changed?: boolean) => void;
  mode?: 'join' | 'change';
  current?: VehicleKind | null;
  guard?: MutationGuard;
}) {
  const become = useBecomePartner();
  const changeVehicle = useChangeVehicle(guard);
  const saving = mode === 'change' ? changeVehicle : become;
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [colr, setColr] = useState('');
  const [plate, setPlate] = useState('');
  // [DCR-1] The Mover Agreement consent — recorded in the ledger with the
  // exact version at provisioning, the same way signup records the Terms.
  const [agree, setAgree] = useState(false);
  const needsDetails = DRIVER_VEHICLE_KINDS.includes(vt);
  const valid = !needsDetails || (!!make && !!model && !!year && !!colr && !!plate);
  // The agreement was recorded when the first vehicle was saved; a change does not re-ask.
  const needsAgreement = mode === 'join';
  const sameAsSaved = mode === 'change' && vt === current && !needsDetails;
  // [PR1270-S2-04] The price on the door is a condition of the door: the
  // vehicle is saved only against a weekly fee that was fetched successfully,
  // is the one the card above shows for THIS vehicle, and is current. The list
  // is read fresh here, never from an hour-old cache. Loading, a failed fetch,
  // no quote for the vehicle, or a stale quote disables the button and says so.
  const user = useAuthStore((s) => s.user) as { countryCode?: string } | null;
  const pricing = usePartnerPricing(user?.countryCode, true, { fresh: true });
  const gate = quoteGate(pricing, (p) => moverQuote(p, vt));
  const stale = !gate.ok && gate.why === 'stale';
  const { refetch: refetchPricing } = pricing;
  useEffect(() => {
    if (stale) void refetchPricing();
  }, [stale, refetchPricing]);
  // Only the vehicles Swift takes on today (the price list's `offered`, else the launch list).
  const offered = VTYPES.filter((v) => vehicleOffered(v.key, pricing.data));
  useEffect(() => {
    // A saved vehicle that is no longer offered (a canter) starts the picker on the first offered one.
    if (!vehicleOffered(vt, pricing.data) && offered[0]) setVt(offered[0].key);
  }, [vt, pricing.data, offered, setVt]);
  const saveError = saving.error instanceof StepUpDismissed
    ? null
    : ((saving.error as any)?.response?.data?.error?.message as string | undefined) ?? (saving.isError ? 'Couldn’t save. Try again.' : null);

  const submit = () => {
    if (!gate.ok) return; // guarded by the button, restated so no call site can bypass it
    if (!vehicleOffered(vt, pricing.data)) return; // the picker lists only offered vehicles; restated for the same reason
    const vehicle = needsDetails ? { make, model, year: Number(year) || 0, color: colr, licensePlate: plate } : undefined;
    if (mode === 'change') {
      changeVehicle.mutate({ vehicleType: vt, vehicle }, { onSuccess: (r) => onDone(r?.changed !== false) });
      return;
    }
    become.mutate({ role: 'MOVER', vehicleType: vt, vehicle, acceptAgreement: agree }, { onSuccess: () => onDone(true) });
  };

  return (
    <Card>
      <T variant="heading">{mode === 'change' ? 'Your new vehicle' : 'Your vehicle'}</T>
      <T variant="label" tone="muted" style={{ marginTop: 4 }}>
        {mode === 'change' ? VEHICLE_COPY.changeWarning : 'How will you earn?'}
      </T>
      <View style={{ gap: space.sm, marginTop: space.md }}>
        {offered.map((v) => (
          <VehicleRow key={v.key} v={v} active={v.key === vt} onPress={() => setVt(v.key)} />
        ))}
      </View>
      {needsDetails ? (
        <View style={{ gap: space.md, marginTop: space.md }}>
          <LabeledInput value={make} onChangeText={setMake} placeholder="Make (e.g. Toyota)" />
          <LabeledInput value={model} onChangeText={setModel} placeholder="Model (e.g. Allion)" />
          <View style={{ flexDirection: 'row', gap: space.md }}>
            <LabeledInput containerStyle={{ flex: 1 }} value={year} onChangeText={setYear} placeholder="Year" keyboardType="number-pad" />
            <LabeledInput containerStyle={{ flex: 1 }} value={colr} onChangeText={setColr} placeholder="Colour" />
          </View>
          <LabeledInput value={plate} onChangeText={setPlate} placeholder="Licence plate" autoCapitalize="characters" />
        </View>
      ) : null}
      {needsAgreement ? (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: agree }}
        accessibilityLabel="I agree to the Mover Agreement"
        onPress={() => setAgree((v) => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md }}
      >
        <MaterialCommunityIcons
          name={agree ? 'checkbox-marked' : 'checkbox-blank-outline'}
          size={22}
          color={agree ? color.brand[500] : color.text.muted}
        />
        <T variant="label" style={{ flexShrink: 1 }}>
          I agree to the{' '}
          <T variant="label" tone="brand" onPress={() => void openPayLink(`${API_URL}/legal/driver-agreement`)}>
            Mover Agreement
          </T>
        </T>
      </Pressable>
      ) : null}
      {/* The server's own words for a refused save: a vehicle not offered, a job in
          progress, a weekly plan to move with support. */}
      {saveError ? (
        <T variant="label" tone="error" style={{ marginTop: space.md }}>
          {saveError}
        </T>
      ) : null}
      {/* [#947's grammar] Disabled says the ask — the fee first, because
          without a fee on the door there is nothing to agree to. */}
      <PillButton
        label={!gate.ok
          ? QUOTE_GATE_COPY[gate.why]
          : !valid
            ? 'Fill in the vehicle details'
            : needsAgreement && !agree
              ? 'Agree to the Mover Agreement first'
              : mode === 'change' ? VEHICLE_COPY.saveNew : 'Save vehicle'}
        loading={saving.isPending}
        disabled={!gate.ok || !valid || (needsAgreement && !agree) || sameAsSaved}
        style={{ marginTop: space.md }}
        onPress={submit}
      />
    </Card>
  );
}

export function MoverOnboardingScreen({ status }: { status: any }) {
  const { logout, moverPreset } = useAuthStore();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const savedVehicle: VehicleKind | null = status?.vehicleType ?? null;
  // Default the vehicle from what they picked on the entry screen: a taxi
  // driver starts on Car, a rider on Motorcycle. A saved vehicle always wins.
  const presetVehicle: VehicleKind = moverPreset === 'taxi' ? 'CAR' : 'MOTORCYCLE';
  const [vt, setVt] = useState<VehicleKind>(savedVehicle ?? presetVehicle);
  const [vehicleSaved, setVehicleSaved] = useState(!!savedVehicle);
  // [VEHICLES] "after you save vehicle you cant switch it at all": a saved vehicle has a
  // Change action. A change retires the old vehicle's papers, so the checklist below
  // follows the NEW vehicle; a verified mover steps up first (the server decides).
  const [changing, setChanging] = useState(false);
  const stepUp = useStepUp();
  const countryCode = (useAuthStore((s) => s.user) as { countryCode?: string } | null)?.countryCode;
  const pricing = usePartnerPricing(countryCode);
  const savedOffered = !savedVehicle || vehicleOffered(savedVehicle, pricing.data);
  const savedLabel = VTYPES.find((v) => v.key === (savedVehicle ?? vt))?.label ?? 'Your vehicle';
  const { data: preview, isLoading: statusLoading, isError: statusError, refetch: refetchStatus } = useVerificationStatus<any>('MOVER', vt);
  const checklistStatus = preview ?? status;

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: GUTTER, height: 56 }}>
        <SwiftMark size={28} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
          <LinkText label="Switch app" onPress={() => setSwitcherOpen(true)} />
          <LinkText label="Log out" tone="muted" onPress={logout} />
        </View>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        <T variant="title" style={{ marginTop: space.sm }}>
          Start earning with Swift
        </T>
        <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
          Set up your vehicle and documents — we verify within 24 hours, then you go online and start earning.
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.lg }}>
          <ValuePill icon="check-decagram" label="Keep 100%" />
          {/* "Cash in hand", never "Cash payouts". A payout is money Swift
              sends you, and Swift never sends a mover money — the customer
              hands it over and the mover keeps it. The word promised a
              transfer that does not exist, on the screen where someone
              decides whether to work here, and it implied Swift moves money
              on their behalf. It sat directly beside "Keep 100%", which is
              the true version of the same claim. */}
          <ValuePill icon="cash" label="Cash in hand" />
          <ValuePill icon="calendar-check" label="Flat weekly fee" />
        </View>

        {/* The price on the door — what "flat weekly fee" actually costs for
            the vehicle picked below: a taxi driver, a delivery rider and a
            heavy-delivery rider each read their own rate. */}
        <View style={{ marginTop: space.lg }}>
          <PricingCard kind="mover" vehicleType={vt} />
        </View>

        <View style={{ marginTop: space.xl }}>
          {!vehicleSaved ? (
            <VehicleSetup vt={vt} setVt={setVt} onDone={() => setVehicleSaved(true)} />
          ) : changing ? (
            <VehicleSetup
              mode="change"
              current={savedVehicle}
              vt={vt}
              setVt={setVt}
              guard={stepUp.withStepUp}
              onDone={() => {
                setChanging(false);
                void refetchStatus();
              }}
            />
          ) : (
            <Card style={{ gap: space.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: savedOffered ? color.soft.success : color.soft.warning }}>
                  <MaterialCommunityIcons name={savedOffered ? 'check' : 'alert'} size={20} color={savedOffered ? color.success : color.warning} />
                </View>
                <View style={{ flex: 1 }}>
                  <T variant="body" weight="bold">{VEHICLE_COPY.saved}</T>
                  <T variant="caption" tone="muted">{savedLabel}</T>
                </View>
                <LinkText label={VEHICLE_COPY.change} onPress={() => setChanging(true)} />
              </View>
              {!savedOffered ? (
                <T variant="caption" tone="warning">{VEHICLE_COPY.notOffered}</T>
              ) : null}
            </Card>
          )}
        </View>

        <View style={{ marginTop: space.xl }}>
          <DocumentChecklist
            role="MOVER"
            status={checklistStatus}
            isLoading={!checklistStatus && statusLoading}
            isError={!checklistStatus && statusError}
            onRetry={refetchStatus}
          />
        </View>
      </ScrollView>

      <RoleSwitcherSheet visible={switcherOpen} current="mover" onClose={() => setSwitcherOpen(false)} />
      {stepUp.sheet}
    </Screen>
  );
}
