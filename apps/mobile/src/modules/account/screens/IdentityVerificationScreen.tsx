import { useState } from 'react';
import { View, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { Card, PillButton, T } from '../../../kit';
import { Badge } from '../../../kit/badge';
import { PressableScale } from '../../../kit/pressable-scale';
import { useUploadFile, useSubmitIdentity, useVerificationCapabilities } from '../../../hooks/verification';
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

export function IdentityVerificationScreen({ navigation }: any) {
  const upload = useUploadFile();
  const submit = useSubmitIdentity();
  const capabilities = useVerificationCapabilities();
  const selfieRequired = capabilities.data?.identitySelfieRequired === true;
  const [idUploadId, setIdUploadId] = useState<string | undefined>(undefined);
  const [selfieUploadId, setSelfieUploadId] = useState<string | undefined>(undefined);
  const [picking, setPicking] = useState<'id' | 'selfie' | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [permErr, setPermErr] = useState<string | null>(null);

  const pick = async (kind: 'id' | 'selfie') => {
    try {
      const owner = requireAuthSessionSnapshot();
      const liveCapture = kind === 'selfie';
      const perm = liveCapture
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      requireAuthSessionForPrincipal(owner);
      if (!perm.granted) {
        // [G9 · #917's law] A denied permission explains itself — this was
        // the LAST silent library denial in the app.
        setPermErr(liveCapture
          ? 'Camera access is needed for secure live-selfie capture. Allow it in Settings and try again.'
          : 'Photo access is needed to upload your ID. Allow it in Settings and try again.');
        return;
      }
      setPermErr(null);
      const res = liveCapture
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            cameraType: ImagePicker.CameraType.front,
            quality: 0.8,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 0.8,
          });
      requireAuthSessionForPrincipal(owner);
      if (res.canceled || !res.assets?.[0]) return;
      const a = res.assets[0];
      setPicking(kind);
      const uploadId = await upload.mutateAsync({
        uri: a.uri,
        name: a.fileName ?? `${kind}.jpg`,
        type: a.mimeType ?? 'image/jpeg',
        purpose: kind === 'id' ? 'IDENTITY_DOCUMENT' : 'IDENTITY_SELFIE',
        role: 'CUSTOMER',
        ...(kind === 'id' ? { docType: 'identity_l2' } : {}),
        authSession: owner,
      });
      requireAuthSessionForPrincipal(owner);
      if (kind === 'id') setIdUploadId(uploadId);
      else setSelfieUploadId(uploadId);
    } catch (pickError) {
      if (pickError instanceof AuthSessionBoundaryError) return;
      // surfaced below
    } finally {
      setPicking(null);
    }
  };

  if (submitted) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: color.surface.base }} edges={['top']}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space['2xl'] }}>
          <Feather name="check-circle" size={48} color={color.success} />
          <T variant="heading" center style={{ marginTop: space.md }}>
            ID submitted for review
          </T>
          <T variant="body" tone="muted" center style={{ marginTop: space.xs }}>
            We verify within 24 hours. Once approved, the order limit is lifted for good.
          </T>
          <PillButton label="Done" style={{ marginTop: space.xl, paddingHorizontal: space['2xl'] }} onPress={() => navigation?.goBack?.()} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.surface.base }} edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.sm }}>
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <T variant="body" weight="bold" style={{ marginLeft: space.md }}>Verify your identity</T>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <T variant="label" tone="muted" style={{ marginBottom: space.md }}>
          {selfieRequired
            ? 'A one-time check, required for larger cash orders and rides. Upload a government ID and a fresh selfie.'
            : 'A one-time document check, required for larger cash orders and rides. Upload a government ID to continue.'}
        </T>
        <UploadRow title="Government ID" done={!!idUploadId} busy={picking === 'id'} onPress={() => pick('id')} />
        {selfieRequired ? (
          <UploadRow title="Selfie" done={!!selfieUploadId} busy={picking === 'selfie'} onPress={() => pick('selfie')} />
        ) : null}

        {/* [WR-027] The catch above says "surfaced below" — this is that
            surface. Only the submit error rendered; a failed photo UPLOAD was
            silent and the row simply stayed empty. */}
        {permErr ? <T variant="label" tone="error" center style={{ marginTop: space.sm }}>{permErr}</T> : null}
        {upload.isError ? <T variant="label" tone="error" center style={{ marginTop: space.sm }}>That photo didn&apos;t upload — tap the card and try again.</T> : null}
        {submit.isError ? <T variant="label" tone="error" center style={{ marginTop: space.sm }}>Couldn&apos;t submit. Please try again.</T> : null}
        {capabilities.isError ? <T variant="label" tone="error" center style={{ marginTop: space.sm }}>Couldn&apos;t load the verification privacy settings. Try again before uploading.</T> : null}

        {/* [#947's grammar] Disabled says the ask. */}
        <PillButton
          label={!capabilities.isSuccess
            ? 'Loading verification settings…'
            : !idUploadId
              ? 'Upload your ID first'
              : selfieRequired && !selfieUploadId
                ? 'Add your selfie'
                : 'Submit for verification'}
          loading={submit.isPending}
          style={{ marginTop: space.lg }}
          disabled={!capabilities.isSuccess || !idUploadId || (selfieRequired && !selfieUploadId)}
          onPress={() =>
            submit.mutate({
              idUploadId: idUploadId as string,
              ...(selfieRequired ? { selfieUploadId: selfieUploadId as string } : {}),
            }, { onSuccess: () => setSubmitted(true) })
          }
        />
        <T variant="micro" tone="muted" center style={{ marginTop: space.md }}>
          Your documents are encrypted and only used for verification (DPA 2023).
        </T>
      </ScrollView>
    </SafeAreaView>
  );
}
