import { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { BrandCheckbox, Card, ChoiceChip, ErrorState, LabeledInput, PillButton, T } from '../../kit';
import { space } from '@swift/ui';
import { DOCUMENT_CONSENT_TEXT } from '../../lib/uploadConsentCopy';
import { storeVatStatusLine } from '../../lib/storeVat';
import { errorMessage } from '../../lib/apiError';
import { useSendVatCertificate, useStoreVat, useUpdateStoreVat } from '../../hooks/storeVat';

/** Where the owner reads the GRA's own words on VAT. */
const GRA_VAT_URL = 'https://www.gra.gov.gy/vat-invoices/';

/**
 * [STORE-VAT · owner O-5] "Is your business VAT-registered with the GRA?" on the store's Account screen (OWNER only).
 * No keeps (or takes) VAT off at once. Yes needs the VAT number exactly as the certificate shows it, and a photo of
 * the certificate; a PERSON at Swift checks it, and only then do the store's prices say "incl. VAT". Prices are never
 * changed here: they already include VAT ("add VAT at checkout" is not offered yet). Hidden while Swift's VAT switch
 * is off, unless the store already has a VAT record to show. The same words as the web dashboard.
 */
export function StoreVatSection() {
  const vat = useStoreVat(true);
  const update = useUpdateStoreVat();
  const send = useSendVatCertificate();
  const v = vat.data;
  const [registered, setRegistered] = useState(false);
  const [number, setNumber] = useState('');
  const [consented, setConsented] = useState(false);
  useEffect(() => {
    if (!v) return;
    setRegistered(v.status !== 'NONE');
    setNumber(v.vatRegistrationNumber ?? '');
  }, [v?.status, v?.vatRegistrationNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  if (vat.isError) {
    return (
      <Card style={{ marginBottom: space.lg }}>
        <T variant="heading">VAT</T>
        <ErrorState message="Your VAT settings did not load." onRetry={() => void vat.refetch()} />
      </Card>
    );
  }
  if (!v || (!v.available && v.status === 'NONE')) return null;

  const claimed = v.status !== 'NONE';
  const numberChanged = number.trim() !== (v.vatRegistrationNumber ?? '');
  const canSave = registered ? number.trim().length > 0 && (!claimed || numberChanged) : claimed;
  const needsCertificate = v.available && (v.status === 'PENDING' || v.status === 'REJECTED' || v.status === 'REVOKED')
    && (!v.certificate || v.certificate.status !== 'PENDING');

  const sendAsset = (a: ImagePicker.ImagePickerAsset) => {
    if (send.isPending) return;
    send.mutate({ uri: a.uri, name: a.fileName ?? 'vat_certificate.jpg', type: a.mimeType ?? 'image/jpeg' }, { onSuccess: () => setConsented(false) });
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
  const pick = () => {
    if (!consented || send.isPending) return;
    Alert.alert('Your GRA VAT certificate', 'A clear photo of the whole certificate: the name, the VAT number and the date it starts must be readable.', [
      { text: 'Take photo', onPress: () => void fromCamera() },
      { text: 'Choose from library', onPress: () => void fromLibrary() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  return (
    <Card style={{ marginBottom: space.lg, gap: space.sm }}>
      <T variant="heading">VAT</T>
      <T variant="label" tone="muted">
        Only a business registered for VAT with the GRA may charge VAT. If yours is not, keep this at No: your prices stay
        exactly as you type them.
      </T>
      <Pressable onPress={() => void Linking.openURL(GRA_VAT_URL)} accessibilityRole="link">
        <T variant="label" tone="brand" weight="semibold">VAT at the GRA</T>
      </Pressable>
      <T variant="label" weight="semibold" accessibilityRole="text" testID="store-vat-status">{storeVatStatusLine(v)}</T>

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
              <T variant="label">
                Your prices: my prices already include VAT ({v.ratePercent}%). Customers pay the prices you type; receipts
                show the VAT inside them. Adding VAT at checkout is not available yet.
              </T>
            </>
          ) : null}
          <PillButton
            label={registered ? 'Save and send for checking' : 'Turn VAT off'}
            variant={registered ? 'primary' : 'outline'}
            loading={update.isPending}
            disabled={!canSave}
            onPress={() => {
              if (update.isPending) return;
              update.mutate({ registered, vatRegistrationNumber: number.trim() });
            }}
          />
          {update.isError ? <T variant="label" tone="error" accessibilityRole="alert">{errorMessage(update.error)}</T> : null}
        </View>
      ) : claimed ? (
        <View style={{ gap: space.sm, marginTop: space.sm }}>
          <T variant="label" tone="muted">VAT settings are not available on Swift right now. Your prices stay exactly as you typed them.</T>
          <PillButton
            label="Turn VAT off"
            variant="outline"
            loading={update.isPending}
            onPress={() => {
              if (update.isPending) return;
              update.mutate({ registered: false });
            }}
          />
          {update.isError ? <T variant="label" tone="error" accessibilityRole="alert">{errorMessage(update.error)}</T> : null}
        </View>
      ) : null}

      {needsCertificate && !update.isPending ? (
        <View style={{ gap: space.sm, marginTop: space.md }}>
          <T variant="label" weight="semibold">Your GRA VAT registration certificate</T>
          <T variant="label" tone="muted">A person at Swift checks the name, the VAT number and the date it starts.</T>
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
          <PillButton label="Add the certificate photo" loading={send.isPending} disabled={!consented} onPress={pick} />
          {send.isError ? <T variant="label" tone="error" accessibilityRole="alert">{errorMessage(send.error)}</T> : null}
        </View>
      ) : null}
    </Card>
  );
}
