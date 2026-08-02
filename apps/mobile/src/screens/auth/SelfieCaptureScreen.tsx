import { useRef, useState } from 'react';
import { View, Linking, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { withAlpha } from '../../modules/mover/dark';
import { SwiftMark } from '../../components/SwiftLogo';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { Text, Heading, Button, PressableScale } from '../../components/ui';

const FRAME = 260;

/**
 * Mandatory signup selfie (master plan §3) — camera capture ONLY, no gallery.
 * Rendered by RootNavigator for any signed-in account without a selfie, so it
 * covers new registrations, existing accounts, and every role the same way.
 * The photo becomes the user's public profile picture: drivers see who they
 * pick up, customers see who's coming.
 */
export function SelfieCaptureScreen() {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { user, setUser, logout } = useAuthStore();

  const capture = async () => {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    setError(null);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7 });
      if (photo?.uri) setPhotoUri(photo.uri);
    } catch {
      setError('Couldn’t take the photo. Try again.');
    } finally {
      setCapturing(false);
    }
  };

  const upload = async () => {
    if (!photoUri) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', { uri: photoUri, name: 'selfie.jpg', type: 'image/jpeg' } as never);
      const { data } = await authApi.uploadSelfie(form);
      const updated = data.data.user;
      // Merge — the endpoint returns the core identity fields; anything extra
      // already in the store (e.g. wallet) must survive.
      setUser({ ...(user as object), ...updated } as never);
    } catch {
      setError('Upload failed. Check your connection and try again.');
      setUploading(false);
    }
  };

  const frame = (
    <View
      className="self-center overflow-hidden rounded-full border-4"
      style={{
        width: FRAME,
        height: FRAME,
        borderColor: color.brand[500],
        // the ring glows brand-red — this is a Swift moment, not a form field
        boxShadow: `0px 8px 24px ${withAlpha(color.brand[500], 0.35)}`,
        elevation: 8,
      }}
    >
      {photoUri ? (
        <Image source={{ uri: photoUri }} style={{ width: FRAME, height: FRAME }} />
      ) : permission?.granted ? (
        <CameraView ref={cameraRef} facing="front" style={{ width: FRAME, height: FRAME }} />
      ) : (
        <View className="flex-1 items-center justify-center bg-surface-subtle">
          <Feather name="camera-off" size={40} color={color.text.muted} />
        </View>
      )}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-base">
      <View className="flex-row items-center justify-end px-lg pt-md">
        <PressableScale onPress={logout} hitSlop={12}>
          <Text className="text-sm text-text-muted">Sign out</Text>
        </PressableScale>
      </View>

      <View className="flex-1 justify-center px-lg">
        <View className="mb-sm items-center"><SwiftMark size={34} /></View>
        <Heading size="xl" className="text-center">Add your photo</Heading>
        <Text className="mt-xs mb-xl text-center text-text-secondary">
          Take a quick selfie — it becomes your profile photo so people know
          exactly who they’re meeting. Camera only, no gallery uploads.
        </Text>

        {frame}

        {error ? <Text className="mt-md text-center text-sm text-error">{error}</Text> : null}

        <View className="mt-xl">
          {photoUri ? (
            <>
              <Button label="Use this photo" loading={uploading} onPress={upload} />
              <Button
                label="Retake"
                variant="outline"
                className="mt-sm"
                disabled={uploading}
                onPress={() => setPhotoUri(null)}
              />
            </>
          ) : permission?.granted ? (
            <Button label={capturing ? 'Hold still…' : 'Take selfie'} loading={capturing} onPress={capture} />
          ) : permission?.canAskAgain === false ? (
            <>
              <Text className="mb-sm text-center text-sm text-text-secondary">
                Camera access is off. Enable it in Settings to continue.
              </Text>
              <Button label="Open Settings" onPress={() => Linking.openSettings()} />
            </>
          ) : (
            <Button label="Allow camera" onPress={requestPermission} />
          )}
        </View>
      </View>

      <Text className="mb-md px-lg text-center text-xs text-text-muted">
        Your photo is shown with your orders and rides. You can retake it any time.
      </Text>
    </SafeAreaView>
  );
}
