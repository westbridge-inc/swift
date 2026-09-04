/** @jsxImportSource react */
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Card, LabeledInput, PillButton, Screen, T } from '../../../kit';
import { GUTTER } from '../shared';
import { API_URL } from '../../../services/api';
import { openPayLink } from '../../../lib/payLink';
import { DocumentChecklist } from '../../../components/onboarding/DocumentChecklist';
import { PricingCard } from '../../../components/onboarding/PricingCard';
import { useBecomePartner, useVerificationStatus } from '../../../hooks/verification';
import { useLocationStore } from '../../../stores/locationStore';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { RoleSwitcherSheet } from '../../../components/RoleSwitcherSheet';
import { TYPES, TabHeader } from '../shared';

function BizValuePill({ icon, label }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; label: string }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: 9999,
        paddingHorizontal: space.md,
        paddingVertical: 6,
        backgroundColor: color.brand[50],
      }}
    >
      <MaterialCommunityIcons name={icon} size={14} color={color.brand[600]} />
      <T variant="caption" weight="bold" tone="deep">
        {label}
      </T>
    </View>
  );
}

function BizTypeTile({ t, active, onPress }: { t: (typeof TYPES)[number]; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ flex: 1 }}>
      {({ pressed }) => (
        <View
          style={{
            alignItems: 'center',
            borderRadius: radius.lg,
            borderWidth: 1,
            paddingVertical: space.md,
            borderColor: active ? color.brand[500] : color.border.subtle,
            backgroundColor: active ? color.brand[50] : color.surface.base,
            opacity: pressed ? 0.85 : 1,
          }}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 4,
              backgroundColor: active ? color.brand[500] : color.brand[50],
            }}
          >
            <MaterialCommunityIcons name={t.icon} size={20} color={active ? color.white : color.brand[600]} />
          </View>
          <T variant="caption" weight="bold" tone={active ? 'deep' : 'ink'} numberOfLines={1}>
            {t.label}
          </T>
        </View>
      )}
    </Pressable>
  );
}

export function BusinessSetup() {
  const become = useBecomePartner();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const { latitude, longitude, status: locationStatus } = useLocationStore();
  const [name, setName] = useState('');
  const [type, setType] = useState<'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE'>('RESTAURANT');
  const [phone, setPhone] = useState('');
  const [addr, setAddr] = useState('');
  const [city, setCity] = useState('Georgetown');
  // [F-027-02] A store's coordinates are where customers are sent and where
  // dispatch measures from. This used to submit `latitude ?? 6.8013` — pinning
  // the shop at the Georgetown city centre whenever the device location was
  // unknown, while the caption below told the owner we had used their current
  // location. A fabricated pin AND a false statement about it. No location
  // now means no submission, said out loud.
  // [F-028-08] Persisted numbers are only a last-known map centre; they are a
  // STORE PIN — where customers are sent, where dispatch measures from — only
  // when the grant is live. The old existence check submitted a pin while
  // status was resolving/denied/unavailable, so a revoked permission could
  // register a business at wherever the phone last was.
  const pinFix = grantedLocationFix(latitude, longitude, locationStatus);
  const hasPin = pinFix !== null;
  // [DCR-1] The Business Agreement consent — recorded in the ledger with the
  // exact version at store creation, the same way signup records the Terms.
  const [agree, setAgree] = useState(false);
  const valid = hasPin && name.trim().length >= 2 && phone.trim().length >= 5 && addr.trim().length >= 3 && city.trim().length >= 2;

  const submit = () => {
    if (!hasPin) return; // guarded by `valid`, restated so the call site cannot fabricate
    become.mutate({
      role: 'VENDOR',
      business: {
        name: name.trim(),
        vendorType: type,
        phone: phone.trim(),
        addressLine1: addr.trim(),
        city: city.trim(),
        latitude: pinFix!.latitude,
        longitude: pinFix!.longitude,
      },
      acceptAgreement: agree,
    });
  };

  return (
    <Screen>
      <TabHeader title="Sell on Swift" onSwitch={() => setSwitcherOpen(true)} />
      <RoleSwitcherSheet visible={switcherOpen} current="vendor" onClose={() => setSwitcherOpen(false)} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        <T variant="title">List your business</T>
        <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
          Reach customers across town and keep 100% of every sale — Swift charges a flat weekly fee, never commission.
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.lg, marginBottom: space.md }}>
          <BizValuePill icon="check-decagram" label="Keep 100%" />
          <BizValuePill icon="cash-remove" label="No commission" />
          <BizValuePill icon="calendar-check" label="Flat weekly fee" />
        </View>

        {/* The price on the door — what the flat weekly fee actually is. */}
        <PricingCard kind="vendor" />

        <T variant="heading" style={{ marginBottom: space.md }}>
          Business type
        </T>
        <View style={{ flexDirection: 'row', gap: space.md }}>
          {TYPES.map((t) => (
            <BizTypeTile key={t.key} t={t} active={t.key === type} onPress={() => setType(t.key)} />
          ))}
        </View>

        <Card style={{ marginTop: space.xl, gap: space.md }}>
          <LabeledInput value={name} onChangeText={setName} placeholder="Business name" />
          <LabeledInput value={phone} onChangeText={setPhone} placeholder="Business phone" keyboardType="phone-pad" />
          <LabeledInput value={addr} onChangeText={setAddr} placeholder="Street address" />
          <LabeledInput value={city} onChangeText={setCity} placeholder="City" />
          {/* [two-reds law] `error` is reserved for genuine failure — the palette
              says so, and brand is already red, so a second red must mean
              something. Nothing has failed here: the app is asking for a
              permission it has not been given yet. That is `warning` (burnt
              amber, "cautions"), and the sentence carries the meaning anyway,
              which is the other half of the law — colour never carries it alone. */}
          <T variant="caption" tone={hasPin ? 'muted' : 'warning'}>
            {hasPin
              ? 'We\u2019ll use your current location as the store pin.'
              : 'We need your location to pin your store on the map \u2014 turn location on for Swift, then come back. Customers are sent to this pin.'}
          </T>
        </Card>

        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: agree }}
          accessibilityLabel="I agree to the Business Agreement"
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
            <T variant="label" tone="brand" onPress={() => void openPayLink(`${API_URL}/legal/vendor-agreement`)}>
              Business Agreement
            </T>
          </T>
        </Pressable>
        {become.isError ? (
          <T variant="label" tone="error" style={{ marginTop: space.md }}>
            Couldn&apos;t create your store. Try again.
          </T>
        ) : null}
        {/* [#947's grammar] Disabled names the first missing thing, in the
            order the form asks for them — the pin first, because without it
            nothing else matters. */}
        <PillButton
          label={
            !hasPin
              ? 'Turn location on first'
              : name.trim().length < 2
                ? 'Name your business'
                : phone.trim().length < 5
                  ? 'Add the business phone'
                  : addr.trim().length < 3
                    ? 'Add the street address'
                    : city.trim().length < 2
                      ? 'Add the city'
                      : !agree
                        ? 'Agree to the Business Agreement first'
                        : 'Create store'
          }
          loading={become.isPending}
          disabled={!valid || !agree}
          style={{ marginTop: space.lg }}
          onPress={submit}
        />
        {/* The model line lives BELOW the work — the queue is the job. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, borderRadius: radius.lg, backgroundColor: color.brand[50], paddingHorizontal: space.md, paddingVertical: space.sm, marginTop: space.md }}>
          <MaterialCommunityIcons name="check-decagram" size={15} color={color.success} />
          <T variant="caption" weight="semibold" tone="deep" style={{ flex: 1 }}>
            You keep 100% of every sale — Swift charges a flat weekly fee, never commission.
          </T>
        </View>
      </ScrollView>
    </Screen>
  );
}

export function VendorOnboarding({ store, onPreview }: { store: any; onPreview: () => void }) {
  // Poll while onboarding so an approval reflects within seconds.
  const { data: status, isLoading, isError, refetch } = useVerificationStatus<any>(store.vendorType, undefined, { poll: true });
  return (
    <Screen>
      <TabHeader title={store.name} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        <PricingCard kind="vendor" />
        <DocumentChecklist role={store.vendorType} status={status} isLoading={isLoading} isError={isError} onRetry={refetch} />
        {/* Gated-trials spec §B: waiting shouldn't mean staring at a checklist.
            The dashboard is browsable in preview; selling stays locked. */}
        <PillButton label="Preview your dashboard" variant="soft" style={{ marginTop: space.lg }} onPress={onPreview} />
        <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
          Look around while you wait — selling unlocks the moment you&apos;re approved.
        </T>
      </ScrollView>
    </Screen>
  );
}
