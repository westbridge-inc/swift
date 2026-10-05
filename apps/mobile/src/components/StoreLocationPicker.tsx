/** @jsxImportSource react */
import { useEffect, useRef, useState } from 'react';
import { Modal, View, useColorScheme } from 'react-native';
import MapView, { PROVIDER_DEFAULT, type MapPressEvent, type Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, motion, space } from '@swift/ui';
import { CircleChip, LoadingBlock, PillButton, PinGlyph, T } from '../kit';
import { rideMapProps } from '../kit/map-style';
import {
  STORE_PIN_COPY,
  geocodeStoreAddress,
  reverseGeocodeStorePin,
  storePinConfirmable,
  storePinMoved,
  storePinStart,
  storePinStartLine,
  type LatLng,
  type StorePin,
  type StorePinGeocoder,
  type StorePinStart,
} from '../lib/storePin';

/** A street's worth of map: one entrance can be told from the shop next door. */
const STREET_DELTA = 0.004;
/** A town's worth: enough to find your own street in. */
const TOWN_DELTA = 0.05;
/** Wait for the map to rest before naming the spot under the pin. */
const ADDRESS_SETTLE_MS = 350;

/** The phone's own geocoder: part of expo-location, already in the app, no key. */
const phoneGeocoder: StorePinGeocoder = {
  geocodeAsync: Location.geocodeAsync,
  reverseGeocodeAsync: Location.reverseGeocodeAsync,
};

/**
 * [Q8] Put the store on the map. A full-screen map with a fixed pin at its
 * centre: the owner drags the map, or taps a spot, until the pin sits on the
 * store's entrance, sees the address under it, and confirms. Nothing is a pin
 * until "Confirm store location". Where the map opens is decided once per open
 * (lib/storePin storePinStart): the pin already placed, else the typed address,
 * else the phone's position as a suggestion, else the market centre.
 *
 * Used by List-your-business (the pin goes into the draft) and by the vendor
 * Account tab (the pin is saved at once: `saving` and `error` are that save's).
 */
export function StoreLocationPicker({
  visible,
  current,
  address,
  device,
  saving = false,
  error = null,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  /** The pin already placed, if any: the map opens on it. */
  current: LatLng | null;
  /** What the owner typed, looked up to open the map there. */
  address: { line: string; city: string };
  /** Where the phone is (a live grant only). A place to START, never a pin. */
  device: LatLng | null;
  saving?: boolean;
  error?: string | null;
  onConfirm: (pin: StorePin) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {/* Mounted per open, so every open decides its own start afresh. */}
      {visible ? (
        <PickerBody
          current={current}
          address={address}
          device={device}
          saving={saving}
          error={error}
          onConfirm={onConfirm}
          onClose={onClose}
        />
      ) : null}
    </Modal>
  );
}

function PickerBody({
  current,
  address,
  device,
  saving,
  error,
  onConfirm,
  onClose,
}: {
  current: LatLng | null;
  address: { line: string; city: string };
  device: LatLng | null;
  saving: boolean;
  error: string | null;
  onConfirm: (pin: StorePin) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const mapRef = useRef<MapView>(null);
  const [opening, setOpening] = useState<{ start: StorePinStart; addressNotFound: boolean } | null>(null);
  const [centre, setCentre] = useState<LatLng | null>(null);
  const [span, setSpan] = useState({ latitudeDelta: STREET_DELTA, longitudeDelta: STREET_DELTA });
  // The address line belongs to one exact centre; a moved map shows "Finding…" until its own arrives.
  const [named, setNamed] = useState<{ at: LatLng; line: string | null } | null>(null);
  const lookup = useRef(0);

  // Where the map opens: decided once, when the picker opens. Later edits to
  // the form never move the map out from under the owner's finger.
  useEffect(() => {
    let live = true;
    void (async () => {
      const typed = address.line.trim().length >= 3;
      const geocoded = current ? null : await geocodeStoreAddress(phoneGeocoder, address.line, address.city);
      if (!live) return;
      const start = storePinStart({ current, geocoded, device });
      const delta = start.basis === 'market' ? TOWN_DELTA : STREET_DELTA;
      setOpening({ start, addressNotFound: typed && !current && geocoded === null });
      setSpan({ latitudeDelta: delta, longitudeDelta: delta });
      setCentre({ latitude: start.latitude, longitude: start.longitude });
    })();
    return () => {
      live = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Name the spot under the pin once the map has rested. Latest wins: a slow
  // answer for an earlier spot never labels a later one.
  useEffect(() => {
    if (!centre) return;
    const ticket = ++lookup.current;
    const timer = setTimeout(() => {
      void reverseGeocodeStorePin(phoneGeocoder, centre).then((line) => {
        if (ticket === lookup.current) setNamed({ at: centre, line });
      });
    }, ADDRESS_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [centre]);

  const onSettle = (region: Region) => {
    setSpan({ latitudeDelta: region.latitudeDelta, longitudeDelta: region.longitudeDelta });
    setCentre({ latitude: region.latitude, longitude: region.longitude });
  };
  // A tap is the other way to place the pin: the map glides so the tapped spot sits under it.
  const goTo = (point: LatLng) => mapRef.current?.animateToRegion({ ...point, ...span }, motion.duration.gentle);
  const onTap = (event: MapPressEvent) => goTo(event.nativeEvent.coordinate);

  const moved = opening != null && centre != null && storePinMoved(opening.start, centre);
  const confirmable = opening != null && centre != null && storePinConfirmable(opening.start.basis, moved);
  const line = centre && named?.at === centre ? named.line : null;
  const addressLine = !centre || named?.at !== centre
    ? STORE_PIN_COPY.findingAddress
    : line ?? `${centre.latitude.toFixed(5)}, ${centre.longitude.toFixed(5)}`;

  const confirm = () => {
    if (!confirmable || !centre || saving) return;
    onConfirm({ latitude: centre.latitude, longitude: centre.longitude, address: line });
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      {opening ? (
        <MapView
          ref={mapRef}
          provider={PROVIDER_DEFAULT}
          style={{ flex: 1 }}
          initialRegion={{ latitude: opening.start.latitude, longitude: opening.start.longitude, ...span }}
          onRegionChangeComplete={onSettle}
          onPress={onTap}
          showsUserLocation={device != null}
          {...rideMapProps(scheme)}
        />
      ) : (
        <LoadingBlock />
      )}

      {/* Fixed centre pin: the map slides underneath it, its tip marks the spot. */}
      {opening ? (
        <View style={{ pointerEvents: 'none', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ marginBottom: 46 }}>
            <PinGlyph size={46} color={color.brand[500]} />
          </View>
        </View>
      ) : null}

      <View
        style={{
          position: 'absolute',
          top: insets.top + space.sm,
          left: space['2xl'],
          right: space['2xl'],
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <CircleChip icon="x" label="Close without placing the pin" onPress={onClose} />
        {/* Offered, never applied: the phone's position is one tap away for an owner standing in the shop. */}
        {opening && device ? <CircleChip icon="crosshair" label="Go to where my phone is" onPress={() => goTo(device)} /> : null}
      </View>

      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: color.surface.base,
          borderTopWidth: 1,
          borderTopColor: color.border.subtle,
          paddingHorizontal: space['2xl'],
          paddingTop: space.lg,
          paddingBottom: insets.bottom + space.lg,
          gap: space.sm,
        }}
      >
        <T variant="bodyStrong">{STORE_PIN_COPY.instruction}</T>
        <T variant="caption" tone="muted">
          {STORE_PIN_COPY.consequence}
        </T>
        {opening ? (
          <>
            {/* [two-reds law] A start in the town centre is a caution, not a failure. */}
            <T variant="caption" tone={opening.start.basis === 'market' ? 'warning' : 'muted'}>
              {storePinStartLine(opening.start.basis, opening.addressNotFound)}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <MaterialCommunityIcons name="map-marker-outline" size={18} color={color.text.muted} />
              <T variant="label" weight="semibold" numberOfLines={2} style={{ flex: 1 }} accessibilityLiveRegion="polite">
                {addressLine}
              </T>
            </View>
          </>
        ) : null}
        {error ? (
          <T variant="caption" tone="error" accessibilityLiveRegion="assertive">
            {error}
          </T>
        ) : null}
        <PillButton
          label={confirmable || !opening ? STORE_PIN_COPY.confirm : STORE_PIN_COPY.moveFirst}
          loading={saving}
          disabled={!confirmable}
          onPress={confirm}
          style={{ marginTop: space.xs }}
        />
      </View>
    </View>
  );
}
