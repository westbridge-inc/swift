import { useState } from 'react';
import { View, ScrollView, ActivityIndicator, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { BrandCheckbox, Card, PillButton, T } from '../../../kit';
import { CUSTOMER_ID_CONSENT_TEXT } from '../../../lib/uploadConsentCopy';
import { Badge } from '../../../kit/badge';
import { PressableScale } from '../../../kit/pressable-scale';
import { touchTarget } from '../../../kit/touch-target';
import { useUploadFile, useSubmitIdentity } from '../../../hooks/verification';
import { idCheckOf, submittedCopy, type CustomerIdCheck } from '../../../lib/customerIdCopy';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
} from '../../../stores/authStore';

function UploadRow({
  title,
  done,
  busy,
  onPress,
}: {
  title: string;
  done: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale disabled={busy} onPress={onPress}>
      <Card style={[{ marginBottom: space.sm }, done ? { borderWidth: 1, borderColor: color.brand[500] } : null]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1, paddingRight: space.md }}>
            <T variant="micro" tone="muted">{done ? 'Uploaded' : 'Get started'}</T>
            <T variant="body" weight="semibold">{title}</T>
          </View>
          {busy ? <ActivityIndicator /> : done ? <Badge label="Done" tone="success" /> : <Feather name="chevron-right" size={20} color={color.text.muted} />}
        </View>
      </Card>
    </PressableScale>
  );
}

// [Owner ruling 8 Oct 2026 — CUSTOMER ID] The ID alone: no selfie, no face match (16 Oct: a
// customer takes no photos at all). The ID goes on file at once unless the server's
// automatic checks hold it for a person — the result screen says which, never "verified".
// [Owner ruling 24 Oct 2026 — NO CUSTOMER ID GATE] Optional: taxi rides and bigger orders no
// longer need it; the server asks only after repeated failed deliveries/payments or for a big promo.
export function IdentityVerificationScreen({ navigation }: any) {
  const upload = useUploadFile();
  const submit = useSubmitIdentity();
  const [idUrl, setIdUrl] = useState<string | undefined>(undefined);
  const [picking, setPicking] = useState<'id' | null>(null);
  const [submitted, setSubmitted] = useState(false);
  // [R17 · in-app ¶15] starts unticked; Send stays off until the person agrees
  const [agreed, setAgreed] = useState(false);
  const [lastUploadKind, setLastUploadKind] = useState<'id' | null>(null);
  const [outcome, setOutcome] = useState<CustomerIdCheck | null>(null);
  const [permErr, setPermErr] = useState<string | null>(null);

  const pick = async (kind: 'id') => {
    try {
      const saved = upload.isError && lastUploadKind === kind ? upload.variables : undefined;
      const owner = saved?.authSession ?? requireAuthSessionSnapshot();
      requireAuthSessionForPrincipal(owner);
      let file = saved;
      if (!file) {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        requireAuthSessionForPrincipal(owner);
        if (!perm.granted) {
          setPermErr('Photo access needed — allow it in Settings to upload your documents.');
          return;
        }
        setPermErr(null);
        const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
        requireAuthSessionForPrincipal(owner);
        if (res.canceled || !res.assets?.[0]) return;
        const a = res.assets[0];
        file = { uri: a.uri, name: a.fileName ?? `${kind}.jpg`, type: a.mimeType ?? 'image/jpeg', authSession: owner };
      }
      setPicking(kind);
      setLastUploadKind(kind);
      const url = await upload.mutateAsync(file);
      requireAuthSessionForPrincipal(owner);
      setIdUrl(url);
    } catch (pickError) {
      if (pickError instanceof AuthSessionBoundaryError) return;
      // surfaced below
    } finally {
      setPicking(null);
    }
  };

  if (submitted) {
    const copy = submittedCopy(outcome);
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: color.surface.base }} edges={['top']}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space['2xl'] }}>
          <Feather name={outcome === 'NOT_ACCEPTED' ? 'alert-circle' : outcome === 'WAITING' ? 'clock' : 'check-circle'} size={48} color={outcome === 'NOT_ACCEPTED' ? color.text.muted : color.success} />
          <T variant="heading" center style={{ marginTop: space.md }}>
            {copy.title}
          </T>
          <T variant="body" tone="muted" center style={{ marginTop: space.xs }}>
            {copy.body}
          </T>
          <PillButton label="Done" style={{ marginTop: space.xl, paddingHorizontal: space['2xl'] }} onPress={() => navigation?.goBack?.()} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.surface.base }} edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.sm }}>
        {/* [UI-SWEEP U-P2 census] Back is 44pt on its own, not only through hitSlop. */}
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back" style={touchTarget(24)}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <T variant="body" weight="bold" style={{ marginLeft: space.md }}>Add your ID</T>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <T variant="label" tone="muted" style={{ marginBottom: space.md }}>
          Optional — you don’t need an ID to order or to take a taxi. The app asks for one only after repeated failed deliveries or payments, or for a high-value promo code. Upload a clear photo of your government ID — no selfie needed. It goes on file right away; sometimes a person checks it first.
        </T>
        <UploadRow title="Government ID" done={!!idUrl} busy={picking === 'id'} onPress={() => pick('id')} />

        {/* [WR-027] The catch above says "surfaced below" — this is that
            surface. Only the submit error rendered; a failed photo UPLOAD was
            silent and the row simply stayed empty. */}
        {permErr ? <T variant="label" tone="error" center style={{ marginTop: space.sm }}>{permErr}</T> : null}
        {upload.isPending ? <T variant="label" tone="muted" center>Still uploading — keep this screen open.</T> : null}
        {upload.isError ? <T variant="label" tone="error" center style={{ marginTop: space.sm }}>That photo didn&apos;t upload — tap the same card to retry the saved photo.</T> : null}
        {submit.isError ? <T variant="label" tone="error" center style={{ marginTop: space.sm }}>Couldn&apos;t submit. Please try again.</T> : null}

        {/* [R17 · in-app ¶15] the customer agrees to Swift keeping the ID photo — an unticked tick, recorded */}
        <Pressable
          onPress={() => setAgreed((a) => !a)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: agreed }}
          accessibilityLabel={CUSTOMER_ID_CONSENT_TEXT}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.lg }}
        >
          <BrandCheckbox checked={agreed} onToggle={() => setAgreed((a) => !a)} />
          <T variant="label" tone="muted" style={{ flex: 1 }}>{CUSTOMER_ID_CONSENT_TEXT}</T>
        </Pressable>

        {/* [#947's grammar] Disabled says the ask. */}
        <PillButton
          label={!idUrl ? 'Upload your ID first' : !agreed ? 'Tick the box to send' : 'Send my ID'}
          loading={submit.isPending}
          style={{ marginTop: space.lg }}
          disabled={!idUrl || !agreed}
          onPress={() =>
            submit.mutate({ idDocumentUrl: idUrl as string }, { onSuccess: (result) => { setOutcome(idCheckOf(result as never)); setSubmitted(true); } })
          }
        />
        <T variant="micro" tone="muted" center style={{ marginTop: space.md }}>
          Your ID picture is stored encrypted. Our Privacy Policy says how long we keep it.
        </T>
      </ScrollView>
    </SafeAreaView>
  );
}
