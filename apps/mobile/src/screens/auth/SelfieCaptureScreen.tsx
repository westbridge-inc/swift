import { useEffect, useRef, useState } from 'react';
import { View, Linking, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { withAlpha } from '../../modules/mover/surface';
import { SwiftMark } from '../../components/SwiftLogo';
import { authApi } from '../../services/api';
import { toast } from '../../kit/toast';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
  useAuthStore,
} from '../../stores/authStore';
import { PillButton, T } from '../../kit';
import { PressableScale } from '../../kit/pressable-scale';

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
  const captureAttemptRef = useRef(0);
  const [permission, requestPermission] = useCameraPermissions();
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setUserIfCurrent, logout } = useAuthStore();
  const sessionGeneration = useAuthStore((state) => state.sessionGeneration);

  // The navigator can keep this same screen instance mounted when account A
  // signs out and account B also needs a selfie. Never carry A's captured
  // image or pending UI state across that authentication boundary.
  useEffect(() => {
    captureAttemptRef.current += 1;
    setPhotoUri(null);
    setCapturing(false);
    setUploading(false);
    setError(null);
  }, [sessionGeneration]);

  const capture = async () => {
    if (!cameraRef.current || capturing) return;
    const attempt = ++captureAttemptRef.current;
    setCapturing(true);
    setError(null);
    try {
      const owner = requireAuthSessionSnapshot();
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7 });
      if (captureAttemptRef.current !== attempt) return;
      requireAuthSessionForPrincipal(owner);
      if (photo?.uri) setPhotoUri(photo.uri);
    } catch (captureError) {
      if (
        captureAttemptRef.current !== attempt
        || captureError instanceof AuthSessionBoundaryError
      ) return;
      setError('Couldn’t take the photo. Try again.');
    } finally {
      if (captureAttemptRef.current === attempt) setCapturing(false);
    }
  };

  const upload = async () => {
    if (!photoUri) return;
    setUploading(true);
    setError(null);
    try {
      const owner = requireAuthSessionSnapshot();
      const operationUser = useAuthStore.getState().user;
      if (!operationUser || operationUser.id !== owner.userId) {
        throw new AuthSessionBoundaryError();
      }
      const form = new FormData();
      form.append('file', { uri: photoUri, name: 'selfie.jpg', type: 'image/jpeg' } as never);
      const { data } = await authApi.uploadSelfie(form, owner);
      requireAuthSessionForPrincipal(owner);
      const updated = data.data.user;
      // Merge — the endpoint returns the core identity fields; anything extra
      // already in the store (e.g. wallet) must survive.
      if (!setUserIfCurrent(owner, { ...operationUser, ...updated } as never)) {
        throw new AuthSessionBoundaryError();
      }
    } catch (uploadError) {
      if (uploadError instanceof AuthSessionBoundaryError) return;
      setError('Upload failed. Check your connection and try again.');
      setUploading(false);
    }
  };

  const frame = (
    <View
      style={{
        alignSelf: 'center',
        overflow: 'hidden',
        borderRadius: radius.full,
        borderWidth: 4,
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
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.subtle }}>
          <Feather name="camera-off" size={40} color={color.text.muted} />
        </View>
      )}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.surface.base }} edges={['top', 'bottom']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: space.lg, paddingTop: space.md }}>
        <PressableScale onPress={logout} hitSlop={12}>
          <T variant="label" tone="muted">Sign out</T>
        </PressableScale>
      </View>

      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: space.lg }}>
        <View style={{ marginBottom: space.sm, alignItems: 'center' }}><SwiftMark size={34} /></View>
        <T variant="title" center>Add your photo</T>
        <T variant="body" tone="muted" center style={{ marginTop: space.xs, marginBottom: space.xl }}>
          Take a quick selfie — it becomes your profile photo so people know
          exactly who they’re meeting. Camera only, no gallery uploads.
        </T>

        {frame}

        {error ? <T variant="label" tone="error" center style={{ marginTop: space.md }}>{error}</T> : null}

        <View style={{ marginTop: space.xl }}>
          {photoUri ? (
            <>
              <PillButton label="Use this photo" loading={uploading} onPress={upload} />
              <PillButton
                label="Retake"
                variant="outline"
                style={{ marginTop: space.sm }}
                disabled={uploading}
                onPress={() => setPhotoUri(null)}
              />
            </>
          ) : permission?.granted ? (
            <PillButton label={capturing ? 'Hold still…' : 'Take selfie'} loading={capturing} onPress={capture} />
          ) : permission?.canAskAgain === false ? (
            <>
              <T variant="label" tone="muted" center style={{ marginBottom: space.sm }}>
                Camera access is off. Enable it in Settings to continue.
              </T>
              <PillButton label="Open Settings" onPress={() => void Linking.openSettings().catch(() => toast.show("Couldn't open Settings — enable the camera for Swift there."))} />
            </>
          ) : (
            <PillButton label="Allow camera" onPress={requestPermission} />
          )}
        </View>
      </View>

      <T variant="micro" tone="muted" center style={{ marginBottom: space.md, paddingHorizontal: space.lg }}>
        Your photo is shown with your orders and rides. You can retake it any time.
      </T>
    </SafeAreaView>
  );
}
