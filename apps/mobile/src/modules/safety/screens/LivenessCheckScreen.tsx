import { useEffect, useRef, useState } from 'react';
import { Image, Linking, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { color, radius, space, withAlpha } from '@swift/ui';
import { Header, PillButton, Screen, T } from '../../../kit';
import { toast } from '../../../kit/toast';
import { useLivenessCheck } from '../../../hooks/safety';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
  useAuthStore,
} from '../../../stores/authStore';

const FRAME = 240;

/**
 * §7.1 shift identity check (Identity Assurance) — "is the person driving the
 * account's approved human?" A fresh selfie is face-matched server-side
 * against the signup selfie. Three doors lead here:
 *   - go-online refused with 428 LIVENESS_CHECK_REQUIRED (MoverHome's gate
 *     band navigates here with the profile),
 *   - a §7.2 mid-shift push (`liveness_midshift_prompt`, carrying the
 *     server's respondBy deadline),
 *   - a missed-check push after being forced offline.
 * Camera only, no gallery — a gallery upload defeats the point of liveness.
 * Every state on this screen is a server fact: the outcome ladder, the
 * attempts left, and the deadline are all returned or pushed, never invented.
 */
export function LivenessCheckScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const profile: 'DRIVER' | 'RIDER' = route.params?.profile === 'RIDER' ? 'RIDER' : 'DRIVER';
  const respondBy: string | undefined = typeof route.params?.respondBy === 'string' ? route.params.respondBy : undefined;

  const cameraRef = useRef<CameraView>(null);
  const captureAttemptRef = useRef(0);
  const [permission, requestPermission] = useCameraPermissions();
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const sessionGeneration = useAuthStore((state) => state.sessionGeneration);
  const check = useLivenessCheck();

  // Same boundary discipline as the signup selfie: never carry one account's
  // captured image or pending state across a sign-out/sign-in underneath us.
  useEffect(() => {
    captureAttemptRef.current += 1;
    setPhotoUri(null);
    setCapturing(false);
    setCaptureError(null);
    check.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionGeneration]);

  const capture = async () => {
    if (!cameraRef.current || capturing) return;
    const attempt = ++captureAttemptRef.current;
    setCapturing(true);
    setCaptureError(null);
    try {
      const owner = requireAuthSessionSnapshot();
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7 });
      if (captureAttemptRef.current !== attempt) return;
      requireAuthSessionForPrincipal(owner);
      if (photo?.uri) setPhotoUri(photo.uri);
    } catch (err) {
      if (captureAttemptRef.current !== attempt || err instanceof AuthSessionBoundaryError) return;
      setCaptureError('Couldn’t take the photo. Try again.');
    } finally {
      if (captureAttemptRef.current === attempt) setCapturing(false);
    }
  };

  const submit = () => {
    if (!photoUri || check.isPending) return;
    check.mutate({ photoUri, profile });
  };

  const result = check.data;
  const errStatus = (check.error as any)?.response?.status as number | undefined;
  const errCode = (check.error as any)?.response?.data?.error?.code as string | undefined;
  const locked = errStatus === 423 || errCode === 'LIVENESS_LOCKED';
  const failed = result?.outcome === 'FAIL' || result?.outcome === 'ERROR_FAIL_CLOSED';
  const passed = result?.allowedOnline === true;

  const deadline = respondBy ? new Date(respondBy) : null;
  const deadlineValid = deadline != null && Number.isFinite(deadline.getTime());
  const deadlinePassed = deadlineValid && deadline!.getTime() <= Date.now();

  const contactSupport = () =>
    navigation.navigate('GetHelp', {
      category: 'ACCOUNT',
      subject: 'Identity check locked my account',
      message:
        'My account was locked after identity checks. I believe I am the account holder — please review my checks and restore my access.',
    });

  const frame = (
    <View
      style={{
        alignSelf: 'center',
        width: FRAME,
        height: FRAME,
        borderRadius: FRAME / 2,
        overflow: 'hidden',
        borderWidth: 4,
        borderColor: passed ? color.success : color.brand[500],
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
    <Screen>
      <Header title="Identity check" />
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space['2xl'] }}>
        <T variant="body" tone="muted" center style={{ marginBottom: space.md }}>
          Take a quick selfie — it’s matched against your profile photo so riders
          and customers always meet the person on the account.
        </T>

        {deadlineValid && !passed ? (
          <T variant="label" tone={deadlinePassed ? 'warning' : 'muted'} center style={{ marginBottom: space.md }}>
            {deadlinePassed
              ? 'The response window closed — you may have been taken offline. A passing check puts you back.'
              : `Respond by ${deadline!.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} to stay online.`}
          </T>
        ) : null}

        {locked ? (
          <View style={{ borderRadius: radius.lg, backgroundColor: withAlpha(color.error, 0.1), borderWidth: 1, borderColor: withAlpha(color.error, 0.35), padding: space.lg }}>
            <T variant="bodyStrong" tone="error">Your account is locked</T>
            <T variant="label" tone="muted" style={{ marginTop: space.xs }}>
              Identity checks failed repeatedly or your identity was disputed.
              Only our support team can restore access — retaking the selfie
              won’t unlock it.
            </T>
            <PillButton label="Contact support" style={{ marginTop: space.md }} onPress={contactSupport} />
          </View>
        ) : passed ? (
          <>
            {frame}
            <View style={{ alignItems: 'center', marginTop: space.lg }}>
              <Feather name="check-circle" size={28} color={color.success} />
              <T variant="title" center style={{ marginTop: space.sm }}>
                You’re confirmed
              </T>
              <T variant="label" tone="muted" center style={{ marginTop: space.xs }}>
                {result?.outcome === 'PASS'
                  ? 'This check covers your current shift.'
                  : 'Confirmed for now — a specialist will double-check this one, and we’ll contact you only if something’s wrong.'}
              </T>
            </View>
            <PillButton label="Done" style={{ marginTop: space.xl }} onPress={() => navigation.goBack()} />
          </>
        ) : (
          <>
            {frame}

            {failed ? (
              <View style={{ borderRadius: radius.lg, backgroundColor: withAlpha(color.warning, 0.12), borderWidth: 1, borderColor: withAlpha(color.warning, 0.4), padding: space.md, marginTop: space.lg }}>
                <T variant="label">
                  That selfie didn’t match your profile photo.
                  {typeof result?.attemptsLeft === 'number'
                    ? result.attemptsLeft > 0
                      ? ` You have ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left before the account locks.`
                      : ' The account is now locked — contact support.'
                    : ''}
                </T>
                <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                  Find even lighting, remove hats or dark glasses, and hold the
                  phone at eye level.
                </T>
              </View>
            ) : null}

            {check.isError && !locked && !failed ? (
              <T variant="label" tone="error" center style={{ marginTop: space.md }}>
                The check couldn’t be submitted. Check your connection and try again.
              </T>
            ) : null}
            {captureError ? (
              <T variant="label" tone="error" center style={{ marginTop: space.md }}>
                {captureError}
              </T>
            ) : null}

            <View style={{ marginTop: space.xl }}>
              {photoUri ? (
                <>
                  <PillButton label="Use this photo" loading={check.isPending} onPress={submit} />
                  <PillButton
                    label="Retake"
                    variant="outline"
                    style={{ marginTop: space.sm }}
                    disabled={check.isPending}
                    onPress={() => {
                      setPhotoUri(null);
                      check.reset();
                    }}
                  />
                </>
              ) : permission?.granted ? (
                <PillButton label={capturing ? 'Hold still…' : 'Take selfie'} loading={capturing} onPress={capture} />
              ) : permission?.canAskAgain === false ? (
                <>
                  <T variant="label" tone="muted" center style={{ marginBottom: space.sm }}>
                    Camera access is off. Enable it in Settings to continue.
                  </T>
                  <PillButton
                    label="Open Settings"
                    onPress={() => void Linking.openSettings().catch(() => toast.show("Couldn't open Settings — enable the camera for Swift there."))}
                  />
                </>
              ) : (
                <PillButton label="Allow camera" onPress={requestPermission} />
              )}
            </View>

            <T variant="micro" tone="muted" center style={{ marginTop: space.lg }}>
              Camera only — gallery photos can’t prove it’s you, so there’s no
              upload option. Every check is logged for your protection.
            </T>
          </>
        )}
      </View>
    </Screen>
  );
}
