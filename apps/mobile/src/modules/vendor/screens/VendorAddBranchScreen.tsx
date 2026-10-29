/** @jsxImportSource react */
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Card, Chip, ErrorState, Header, LabeledInput, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { WeeklyFeeTerms } from '../../../components/onboarding/WeeklyFeeTerms';
import { StoreLocationPicker } from '../../../components/StoreLocationPicker';
import { useStepUp } from '../../../hooks/useStepUp';
import { useAddBranch, useBranchTerms } from '../../../hooks/vendorops';
import { isStepUpDismissed } from '../../../lib/stepUp';
import { FEE_TICK_COPY, feeTickError } from '../../../lib/partnerPricing';
import { STORE_PIN_COPY, businessSetupBlocker, vendorBusinessPayload, type BusinessSetupFields } from '../../../lib/storePin';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { useLocationStore } from '../../../stores/locationStore';
import { moneyIn } from '../../../lib/money';
import { BRANCH_COPY, branchDealLine, branchFeeTick, branchTrialLine, refusalWords } from '../../../lib/branches';
import { TYPES } from '../shared';

type StorePin = BusinessSetupFields['pin'];

/**
 * [CHAINS PR2 · owner 29 Oct 2026] Add a branch: one more store under the same business (owner only). It reuses the
 * owner's documents Swift already checked; the branch's own details (address and pin, phone) are asked here, and its
 * hours, delivery area, published phone, food handlers tick and MMG details on its own screens once it exists.
 * Before anything is sent the screen says, in the server's numbers: this branch's own weekly fee (ticked for this
 * branch), whether the business's free trial covers it and only if Swift approves it before that trial ends, that a
 * branch closed during the trial still uses it up, and that a person at Swift checks every new branch first.
 */
export function VendorAddBranchScreen({ navigation }: { navigation?: { goBack?: () => void } }) {
  const stepUp = useStepUp();
  const add = useAddBranch(stepUp.withStepUp);
  const [type, setType] = useState<BusinessSetupFields['type']>('RESTAURANT');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [addr, setAddr] = useState('');
  const [city, setCity] = useState('');
  const [pin, setPin] = useState<StorePin>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const { latitude, longitude, status: locationStatus } = useLocationStore();
  const termsQ = useBranchTerms(type);
  const t = termsQ.data;
  const fee = branchFeeTick(t);
  const [tickedFor, setTickedFor] = useState<string | null>(null);
  const ticked = fee.kind === 'tick' && tickedFor === fee.key;

  // The owner agreed to the Business Agreement when the business joined; a branch is not a new agreement. A branch is
  // added under a business name (a chain), never the own-name declaration.
  const form: BusinessSetupFields = { name, type, phone, addr, city, agree: true, pin };
  const blocker = businessSetupBlocker(form);
  const atLimit = !!t && t.stores >= t.limit;
  const feeAsk = fee.kind === 'invalid' ? FEE_TICK_COPY.invalid : fee.kind === 'tick' && !ticked ? FEE_TICK_COPY.ask : fee.kind === 'none' ? 'Reading the weekly fee…' : null;
  const ask = atLimit ? `You run ${t!.stores} stores, the most one account can` : blocker ?? feeAsk;
  const feeLabel = t ? moneyIn(t.weeklyFee.amount, t.weeklyFee.currencyCode) : '';

  const submit = () => {
    if (ask || fee.kind !== 'tick') return;
    const business = vendorBusinessPayload(form);
    if (!business) return;
    add.mutate({ business, weeklyFeeAck: fee.ack }, {
      onSuccess: () => navigation?.goBack?.(),
      onError: (e) => { if (feeTickError(e)) void termsQ.refetch(); },
    });
  };
  const error = add.isError && !isStepUpDismissed(add.error)
    ? feeTickError(add.error) ?? refusalWords(add.error, 'Couldn’t add the branch. Try again.')
    : null;

  return (
    <Screen>
      <Header title="Add a branch" />
      <StoreLocationPicker
        visible={pinOpen}
        current={pin}
        address={{ line: addr, city }}
        device={grantedLocationFix(latitude, longitude, locationStatus)}
        onClose={() => setPinOpen(false)}
        onConfirm={(confirmed) => { setPin(confirmed); setPinOpen(false); }}
      />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space['3xl'] }}>
        <T variant="body" tone="muted">{BRANCH_COPY.checkFirst}</T>

        <T variant="heading">Business type</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {TYPES.map((x) => <Chip key={x.key} label={x.label} selected={type === x.key} onPress={() => setType(x.key)} />)}
        </View>

        <Card style={{ gap: space.md }}>
          <LabeledInput value={name} onChangeText={setName} placeholder="Branch name (for example, Royal Castle Camp Street)" />
          <LabeledInput value={phone} onChangeText={setPhone} placeholder="Branch phone" keyboardType="phone-pad" />
          <LabeledInput value={addr} onChangeText={setAddr} placeholder="Street address" />
          <LabeledInput value={city} onChangeText={setCity} placeholder="City" />
          <Pressable accessibilityRole="button" accessibilityLabel={pin ? 'Move the branch pin' : 'Place the branch on the map'} onPress={() => setPinOpen(true)}>
            {({ pressed }) => (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: pin ? color.border.subtle : color.brand[500], opacity: pressed ? 0.75 : 1 }}>
                <MaterialCommunityIcons name={pin ? 'map-marker-check' : 'map-marker-plus'} size={22} color={pin ? color.success : color.brand[500]} />
                <View style={{ flex: 1 }}>
                  <T variant="label" weight="semibold">{pin ? 'Branch pin placed' : 'Place the branch on the map'}</T>
                  <T variant="caption" tone="muted" numberOfLines={2}>
                    {pin ? pin.address ?? `${pin.latitude.toFixed(5)}, ${pin.longitude.toFixed(5)}` : STORE_PIN_COPY.instruction}
                  </T>
                </View>
              </View>
            )}
          </Pressable>
        </Card>

        {termsQ.isLoading ? <LoadingBlock /> : null}
        {termsQ.isError ? <ErrorState onRetry={() => void termsQ.refetch()} message={refusalWords(termsQ.error, 'Couldn’t load this branch’s weekly fee.')} /> : null}
        {t ? (
          <Card style={{ gap: space.sm }}>
            <T variant="heading">This branch’s weekly fee</T>
            <T variant="body">{branchTrialLine(t.sharedTrialEndsAt, feeLabel)}</T>
            {branchDealLine(t.dealWeeklyRate, (n) => moneyIn(n, t.dealCurrencyCode ?? t.weeklyFee.currencyCode)) ? (
              <T variant="caption">{branchDealLine(t.dealWeeklyRate, (n) => moneyIn(n, t.dealCurrencyCode ?? t.weeklyFee.currencyCode))}</T>
            ) : null}
            <T variant="caption" tone="muted">{BRANCH_COPY.trialBelongsToBusiness}</T>
            <T variant="caption" tone="muted">{BRANCH_COPY.ownFee}</T>
          </Card>
        ) : null}
        <WeeklyFeeTerms fee={fee} ticked={ticked} onToggle={() => fee.kind === 'tick' && setTickedFor(ticked ? null : fee.key)} />

        {error ? <T variant="label" tone="error">{error}</T> : null}
        <PillButton label={ask ?? 'Add this branch'} disabled={ask !== null} loading={add.isPending} onPress={submit} />
      </ScrollView>
      {stepUp.sheet}
    </Screen>
  );
}
