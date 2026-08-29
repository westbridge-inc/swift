import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { color, radius, space, withAlpha } from '@swift/ui';
import { Header, PillButton, Screen, T } from '../../../kit';
import { destinationForUrl } from '../../../lib/deepLinkParse';
import { resolveDestination, type ResolveFailure } from '../../../services/deep-links';

/**
 * Scan a store's QR code to open it in the app.
 *
 * Vendors have been told "Customers scan this to order" since the QR feature
 * shipped, and POST /qr/:code/app-open exists specifically to record an
 * in-app open — but the customer app had no scanner, so that promise was only
 * ever kept by the phone's own camera opening the web menu, and that endpoint
 * had no caller. This is the missing door.
 *
 * IT OWNS NO RULES. Parsing is `destinationForUrl`, the same pure parser a
 * universal link goes through, and resolution is `resolveDestination`, the same
 * call. A retired code has to mean the same thing whether it was tapped or
 * scanned, and the only way to guarantee that is to not have a second opinion
 * here.
 */

const FRAME = 260;

/** Written for someone standing at a counter holding a phone, so each one says
 *  what just happened and what to do — never "invalid code". */
const FAILURE_COPY: Record<ResolveFailure, { title: string; body: string }> = {
  'not-a-swift-code': {
    title: 'Not a Swift code',
    body: 'This QR opens something else. Look for the Swift code on the counter or the menu.',
  },
  replaced: {
    title: 'This code was replaced',
    body: 'The store printed a new one. Ask them for the current code, or search for the store by name.',
  },
  unavailable: {
    // The server deliberately does not say WHY (missing vs not live), so
    // neither does this — guessing on the customer's behalf would be inventing
    // a reason, and repeating it would undo the server's own no-oracle rule.
    title: 'This store is not available',
    body: 'It may be closed to orders right now. Try searching for it by name.',
  },
  offline: {
    title: 'No connection',
    body: 'The code may be fine — we could not reach Swift to check it. Try again.',
  },
};

export function ScanScreen() {
  const navigation = useNavigation<any>();
  const [permission, requestPermission] = useCameraPermissions();
  const [failure, setFailure] = useState<ResolveFailure | null>(null);
  const [busy, setBusy] = useState(false);

  // A QR held in frame fires onBarcodeScanned many times a second. Without this
  // latch every frame would start its own resolve and file its own APP_OPEN
  // event, so one scan would report as dozens.
  const handling = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const onScanned = useCallback(async ({ data }: { data: string }) => {
    if (handling.current) return;
    handling.current = true;
    setBusy(true);
    setFailure(null);

    const dest = destinationForUrl(data);
    if (!dest) {
      if (alive.current) { setFailure('not-a-swift-code'); setBusy(false); }
      return;
    }
    const outcome = await resolveDestination(dest);
    if (!alive.current) return;
    setBusy(false);
    if (outcome.ok) {
      // replace, not push: coming back from the store should return to where
      // the customer was before scanning, not to a live camera.
      navigation.replace('Restaurant', { vendorId: outcome.vendorId });
      return;
    }
    setFailure(outcome.reason);
  }, [navigation]);

  const scanAgain = () => {
    setFailure(null);
    handling.current = false;
  };

  const body = () => {
    if (!permission) return null; // still reading the current grant
    if (!permission.granted) {
      const blocked = permission.canAskAgain === false;
      return (
        <View style={{ alignItems: 'center', paddingHorizontal: space.xl }}>
          <Feather name="camera-off" size={40} color={color.text.muted} />
          <T variant="body" tone="muted" center style={{ marginTop: space.lg }}>
            {blocked
              ? 'Camera access is off. Turn it on in Settings to scan a store code.'
              : 'Swift needs the camera to read a store’s QR code.'}
          </T>
          <PillButton
            label={blocked ? 'Open Settings' : 'Allow camera'}
            style={{ marginTop: space.lg }}
            onPress={() => { if (blocked) { void Linking.openSettings(); } else { void requestPermission(); } }}
          />
        </View>
      );
    }

    if (failure) {
      const copy = FAILURE_COPY[failure];
      return (
        <View style={{ alignItems: 'center', paddingHorizontal: space.xl }}>
          <Feather name="alert-circle" size={40} color={color.text.muted} />
          <T variant="heading" center style={{ marginTop: space.lg }}>{copy.title}</T>
          <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>{copy.body}</T>
          <PillButton label="Scan again" style={{ marginTop: space.lg }} onPress={scanAgain} />
        </View>
      );
    }

    return (
      <View style={{ alignItems: 'center' }}>
        <View
          style={{
            width: FRAME,
            height: FRAME,
            borderRadius: radius.xl,
            overflow: 'hidden',
            backgroundColor: color.text.primary,
            borderWidth: 2,
            borderColor: withAlpha(color.white, 0.25),
          }}
        >
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={busy ? undefined : onScanned}
          />
        </View>
        <T variant="body" tone="muted" center style={{ marginTop: space.lg, paddingHorizontal: space.xl }}>
          {busy ? 'Opening the store…' : 'Point the camera at a store’s Swift code.'}
        </T>
      </View>
    );
  };

  return (
    <Screen>
      <Header title="Scan" />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: space['3xl'] }}>
        {body()}
      </View>
    </Screen>
  );
}
