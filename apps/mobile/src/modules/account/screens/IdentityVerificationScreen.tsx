import { useState } from 'react';
import { View, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, Button, Badge, PressableScale } from '../../../components/ui';
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
      <Card style={done ? { borderColor: color.brand[500] } : undefined} className="mb-sm">
        <View className="flex-row items-center justify-between">
          <View className="flex-1 pr-md">
            <Text className="text-xs text-text-secondary">{done ? 'Uploaded' : 'Get started'}</Text>
            <Text className="text-base font-semibold">{title}</Text>
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
          <Heading size="lg" className="mt-md text-center">
            ID submitted for review
          </Heading>
          <Text className="mt-xs text-center text-text-secondary">
            We verify within 24 hours. Once approved, the order limit is lifted for good.
          </Text>
          <Button label="Done" className="mt-xl px-2xl" onPress={() => navigation?.goBack?.()} />
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
        <Text className="ml-md text-base font-bold">Verify your identity</Text>
      </View>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <Text className="mb-md text-sm text-text-secondary">
          A one-time check, required for larger cash orders and rides. Upload a government ID and a selfie — verify once and the limit is gone.
        </Text>
        <UploadRow title="Government ID" done={!!idUrl} busy={picking === 'id'} onPress={() => pick('id')} />
        <UploadRow title="Selfie" done={!!selfieUrl} busy={picking === 'selfie'} onPress={() => pick('selfie')} />

        {/* [WR-027] The catch above says "surfaced below" — this is that
            surface. Only the submit error rendered; a failed photo UPLOAD was
            silent and the row simply stayed empty. */}
        {upload.isError ? <Text className="mt-sm text-center text-sm text-error">That photo didn&apos;t upload — tap the card and try again.</Text> : null}
        {submit.isError ? <Text className="mt-sm text-center text-sm text-error">Couldn&apos;t submit. Please try again.</Text> : null}

        <Button
          label="Submit for verification"
          loading={submit.isPending}
          className="mt-lg"
          disabled={!idUrl || !selfieUrl}
          onPress={() =>
            submit.mutate({ idDocumentUrl: idUrl as string, selfieUrl: selfieUrl as string }, { onSuccess: () => setSubmitted(true) })
          }
        />
        <Text className="mt-md text-center text-xs text-text-muted">
          Your documents are encrypted and only used for verification (DPA 2023).
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
