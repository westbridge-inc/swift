import { useState } from 'react';
import { View, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { Card, PillButton, T } from '../../../kit';
import { Badge } from '../../../kit/badge';
import { PressableScale } from '../../../kit/pressable-scale';
import { useUploadFile, useSubmitIdentity } from '../../../hooks/verification';
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
        <View className="flex-row items-center justify-between">
          <View className="flex-1 pr-md">
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
  const [idUrl, setIdUrl] = useState<string | undefined>(undefined);
  const [selfieUrl, setSelfieUrl] = useState<string | undefined>(undefined);
  const [picking, setPicking] = useState<'id' | 'selfie' | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const pick = async (kind: 'id' | 'selfie') => {
    try {
      const owner = requireAuthSessionSnapshot();
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      requireAuthSessionForPrincipal(owner);
      if (!perm.granted) return;
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
      requireAuthSessionForPrincipal(owner);
      if (res.canceled || !res.assets?.[0]) return;
      const a = res.assets[0];
      setPicking(kind);
      const url = await upload.mutateAsync({
        uri: a.uri,
        name: a.fileName ?? `${kind}.jpg`,
        type: a.mimeType ?? 'image/jpeg',
        authSession: owner,
      });
      requireAuthSessionForPrincipal(owner);
      if (kind === 'id') setIdUrl(url);
      else setSelfieUrl(url);
    } catch (pickError) {
      if (pickError instanceof AuthSessionBoundaryError) return;
      // surfaced below
    } finally {
      setPicking(null);
    }
  };

  if (submitted) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center px-2xl">
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
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <T variant="body" weight="bold" style={{ marginLeft: space.md }}>Verify your identity</T>
      </View>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <T variant="label" tone="muted" style={{ marginBottom: space.md }}>
          A one-time check, required for larger cash orders and rides. Upload a government ID and a selfie — verify once and the limit is gone.
        </T>
        <UploadRow title="Government ID" done={!!idUrl} busy={picking === 'id'} onPress={() => pick('id')} />
        <UploadRow title="Selfie" done={!!selfieUrl} busy={picking === 'selfie'} onPress={() => pick('selfie')} />

        {/* [WR-027] The catch above says "surfaced below" — this is that
            surface. Only the submit error rendered; a failed photo UPLOAD was
            silent and the row simply stayed empty. */}
        {upload.isError ? <T variant="label" tone="error" center style={{ marginTop: space.sm }}>That photo didn&apos;t upload — tap the card and try again.</T> : null}
        {submit.isError ? <T variant="label" tone="error" center style={{ marginTop: space.sm }}>Couldn&apos;t submit. Please try again.</T> : null}

        <PillButton
          label="Submit for verification"
          loading={submit.isPending}
          style={{ marginTop: space.lg }}
          disabled={!idUrl || !selfieUrl}
          onPress={() =>
            submit.mutate({ idDocumentUrl: idUrl as string, selfieUrl: selfieUrl as string }, { onSuccess: () => setSubmitted(true) })
          }
        />
        <T variant="micro" tone="muted" center style={{ marginTop: space.md }}>
          Your documents are encrypted and only used for verification (DPA 2023).
        </T>
      </ScrollView>
    </SafeAreaView>
  );
}
