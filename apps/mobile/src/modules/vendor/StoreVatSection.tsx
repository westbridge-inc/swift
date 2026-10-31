import { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { BrandCheckbox, Card, ChoiceChip, ErrorState, LabeledInput, PillButton, T } from '../../kit';
import { space } from '@swift/ui';
import { DOCUMENT_CONSENT_TEXT } from '../../lib/uploadConsentCopy';
import {
  MODE_CHANGE_REVIEW_NOTE, VAT_MODE_CHOICES, modeRequestedLine, storeVatStatusLine, turnOffAddedPricesLine, vatModeHelp, type StoreVatMode,
} from '../../lib/storeVat';
import { errorMessage } from '../../lib/apiError';
import { useStoreVat, useUpdateStoreVat } from '../../hooks/storeVat';
import { useSendVatCertificate } from '../../hooks/storeVatCertificate';

/** Where the owner reads the GRA's own words on VAT. */
const GRA_VAT_URL = 'https://www.gra.gov.gy/vat-invoices/';

/**
 * [STORE-VAT · owner O-5] "Is your business VAT-registered with the GRA?" on the store's Account screen (OWNER only).
 * No keeps (or takes) VAT off at once. Yes needs the VAT number exactly as the certificate shows it, how the store's
 * prices relate to VAT, and a photo of the certificate; a PERSON at Swift checks it, and only then do the store's prices
 * say "incl. VAT". [VAT-DOCS · owner 30 Oct 2026] A store that has not said yes yet sends all three in ONE submission
 * (the certificate route takes the number and the mode with it), so no store waits for a person without a mode.
 * "My prices do not include VAT": once approved, the VAT goes into each standard-rated price customers see.
 * [owner ruling 31 Oct 2026] An APPROVED store that changes its choice is told a person checks the change first; until
 * then its prices stay as they are (the server keeps the change waiting, `modeRequested`).
 * Hidden while Swift's VAT switch is off, unless the store already has a VAT record to show. The same words as the web
 * dashboard. Also opened from the Documents list's optional "VAT certificate" row (DocumentChecklist).
 */
/** `style`: the screen's section gap (VendorAccountScreen stacks its cards with marginBottom), on the card itself, so a
 *  hidden section leaves no gap behind. */
export function StoreVatSection({ style }: { style?: StyleProp<ViewStyle> } = {}) {
  const vat = useStoreVat(true);
  const update = useUpdateStoreVat();
  const send = useSendVatCertificate();
  const v = vat.data;
  const [registered, setRegistered] = useState(false);
  const [number, setNumber] = useState('');
  const [mode, setMode] = useState<StoreVatMode | null>(null);
  const [consented, setConsented] = useState(false);
  useEffect(() => {
    if (!v) return;
    setRegistered(v.status !== 'NONE');
    setNumber(v.vatRegistrationNumber ?? '');
    // A change waiting for a person shows as the store's choice (saving the choice in force withdraws it).
    setMode(v.modeRequested ?? v.mode ?? null);
  }, [v?.status, v?.vatRegistrationNumber, v?.mode, v?.modeRequested]); // eslint-disable-line react-hooks/exhaustive-deps

  if (vat.isError) {
    return (
      <Card style={style}>
        <T variant="heading">VAT</T>
        <ErrorState message="Your VAT settings did not load." onRetry={() => void vat.refetch()} />
      </Card>
    );
  }
  if (!v || (!v.available && v.status === 'NONE')) return null;

  const claimed = v.status !== 'NONE';
  const numberChanged = number.trim() !== (v.vatRegistrationNumber ?? '');
  const modeChanged = mode !== (v.modeRequested ?? v.mode ?? null);
  // [owner ruling 31 Oct 2026] An approved store picking the other choice: a person checks it before anything changes.
  const changeNeedsPerson = v.status === 'APPROVED' && mode !== null && mode !== v.mode;
  const waitingLine = modeRequestedLine(v.modeRequested);
  // A store that already said yes saves a new number or mode here; a new claim goes with its certificate (below).
  const canSave = registered ? claimed && number.trim().length > 0 && mode !== null && (numberChanged || modeChanged) : claimed;
  // [VAT-DOCS] One submission: number + mode + certificate, for a store that has not said yes yet.
  const firstClaim = v.available && !claimed && registered;
  const needsCertificate = firstClaim || (v.available && (v.status === 'PENDING' || v.status === 'REJECTED' || v.status === 'REVOKED')
    && (!v.certificate || v.certificate.status !== 'PENDING'));
  const claimReady = !firstClaim || (number.trim().length > 0 && mode !== null);

  const sendAsset = (a: ImagePicker.ImagePickerAsset) => {
    if (send.isPending) return;
    send.mutate({
      uri: a.uri, name: a.fileName ?? 'vat_certificate.jpg', type: a.mimeType ?? 'image/jpeg',
      ...(firstClaim && mode ? { claim: { vatRegistrationNumber: number.trim(), mode } } : {}),
    }, { onSuccess: () => setConsented(false) });
  };
  const fromCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      if (!perm.canAskAgain) Alert.alert('Camera is turned off for Swift', 'Turn it on in Settings, or choose the photo from your library.', [{ text: 'Open Settings', onPress: () => void Linking.openSettings() }, { text: 'Cancel', style: 'cancel' }]);
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (!res.canceled && res.assets?.[0]) sendAsset(res.assets[0]);
  };
  const fromLibrary = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      if (!perm.canAskAgain) Alert.alert('Photo access is turned off for Swift', 'Turn it on in Settings, or take a photo instead.', [{ text: 'Open Settings', onPress: () => void Linking.openSettings() }, { text: 'Cancel', style: 'cancel' }]);
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
    if (!res.canceled && res.assets?.[0]) sendAsset(res.assets[0]);
  };
  // [REVIEW-F #2087 S4] Turning off an APPROVED store's VAT ends the approval (a person must check again): ask once.
  const turnOff = () => {
    if (update.isPending) return;
    if (v.status !== 'APPROVED') { update.mutate({ registered: false }); return; }
    // [VAT-DOCS] A store whose VAT is added to its prices gets the prices it typed back.
    const prices = v.addsVatToPrices ? turnOffAddedPricesLine : '';
    Alert.alert('Turn VAT off?', `Your prices stop saying “incl. VAT” at once, and a person at Swift must check your certificate again before VAT can come back.${prices}`, [
      { text: 'Keep VAT', style: 'cancel' },
      { text: 'Turn VAT off', style: 'destructive', onPress: () => update.mutate({ registered: false }) },
    ]);
  };
  const pick = () => {
    if (!consented || !claimReady || send.isPending) return;
    Alert.alert('Your GRA VAT certificate', 'A clear photo of the whole certificate: the name, the VAT number and the date it starts must be readable.', [
      { text: 'Take photo', onPress: () => void fromCamera() },
      { text: 'Choose from library', onPress: () => void fromLibrary() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  return (
    <Card style={[{ gap: space.sm }, style]}>
      <T variant="heading">VAT</T>
      <T variant="label" tone="muted">
        Only a business registered for VAT with the GRA may charge VAT. If yours is not, keep this at No: your prices stay
        exactly as you type them.
      </T>
      <Pressable onPress={() => void Linking.openURL(GRA_VAT_URL)} accessibilityRole="link">
        <T variant="label" tone="brand" weight="semibold">VAT at the GRA</T>
      </Pressable>
      <T variant="label" weight="semibold" accessibilityRole="text" testID="store-vat-status">{storeVatStatusLine(v)}</T>
      {waitingLine ? <T variant="label" tone="muted" accessibilityRole="text" testID="store-vat-mode-waiting">{waitingLine}</T> : null}

      {v.available ? (
        <View style={{ gap: space.sm, marginTop: space.sm }}>
          <T variant="label" weight="semibold">Is your business VAT-registered with the GRA?</T>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <ChoiceChip label="No" active={!registered} onPress={() => setRegistered(false)} full />
            <ChoiceChip label="Yes" active={registered} onPress={() => setRegistered(true)} full />
          </View>
          {registered ? (
            <>
              <LabeledInput
                label="VAT registration number (exactly as on your GRA certificate)"
                value={number}
                onChangeText={setNumber}
                keyboardType="number-pad"
                maxLength={40}
              />
              <T variant="label" weight="semibold">Your prices</T>
              <View style={{ gap: space.sm }} accessibilityRole="radiogroup">
                {VAT_MODE_CHOICES.map((c) => (
                  <ChoiceChip key={c.value} label={c.label} active={mode === c.value} onPress={() => setMode(c.value)} full />
                ))}
              </View>
              {mode ? <T variant="label" tone="muted" testID="store-vat-mode-help">{vatModeHelp(mode, v.ratePercent)}</T> : null}
              {changeNeedsPerson ? <T variant="label" tone="muted" testID="store-vat-mode-review">{MODE_CHANGE_REVIEW_NOTE}</T> : null}
            </>
          ) : null}
          {registered && !claimed ? null : (
            <PillButton
              label={registered ? 'Save and send for checking' : 'Turn VAT off'}
              variant={registered ? 'primary' : 'outline'}
              loading={update.isPending}
              disabled={!canSave}
              onPress={() => {
                if (update.isPending) return;
                if (!registered) { turnOff(); return; }
                if (mode) update.mutate({ registered: true, vatRegistrationNumber: number.trim(), mode });
              }}
            />
          )}
          {update.isError ? <T variant="label" tone="error" accessibilityRole="alert">{errorMessage(update.error)}</T> : null}
        </View>
      ) : claimed ? (
        <View style={{ gap: space.sm, marginTop: space.sm }}>
          <T variant="label" tone="muted">VAT settings are not available on Swift right now. Your prices stay exactly as you typed them.</T>
          <PillButton
            label="Turn VAT off"
            variant="outline"
            loading={update.isPending}
            onPress={turnOff}
          />
          {update.isError ? <T variant="label" tone="error" accessibilityRole="alert">{errorMessage(update.error)}</T> : null}
        </View>
      ) : null}

      {needsCertificate && !update.isPending ? (
        <View style={{ gap: space.sm, marginTop: space.md }}>
          <T variant="label" weight="semibold">Your GRA VAT registration certificate</T>
          <T variant="label" tone="muted">A person at Swift checks the name, the VAT number and the date it starts.</T>
          {firstClaim && !claimReady ? (
            <T variant="label" tone="muted">Type your VAT number and choose how your prices relate to VAT first.</T>
          ) : null}
          <Pressable
            onPress={() => setConsented((c) => !c)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: consented }}
            accessibilityLabel={DOCUMENT_CONSENT_TEXT}
            testID="vat-certificate-consent"
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}
          >
            <BrandCheckbox checked={consented} onToggle={() => setConsented((c) => !c)} />
            <T variant="label" tone="muted" style={{ flex: 1 }}>{DOCUMENT_CONSENT_TEXT}</T>
          </Pressable>
          <PillButton
            label={firstClaim ? 'Add the certificate photo and send' : 'Add the certificate photo'}
            loading={send.isPending}
            disabled={!consented || !claimReady}
            onPress={pick}
          />
          {send.isError ? <T variant="label" tone="error" accessibilityRole="alert">{errorMessage(send.error)}</T> : null}
        </View>
      ) : null}
    </Card>
  );
}
