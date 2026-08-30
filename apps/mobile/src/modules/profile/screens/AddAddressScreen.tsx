/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { color, radius, space } from '@swift/ui';
import { useAddAddress, useUpdateAddress } from '../../../hooks/customer';
import { useLocationStore } from '../../../stores/locationStore';
import { BrandSwitch, Header, LabeledInput, PillButton, Screen, T } from '../../../kit';

const GUTTER = space['2xl'];

// Composed from kit input language (no kit frame). Coordinates come from the
// device fix or the map picker — an address without a pin can't be delivered.
//
// [S14] Doubles as the EDIT screen. `route.params.address` switches it: the
// fields start from the saved row instead of blank, and Save sends
// PUT /addresses/:id. A separate edit screen would have been a second copy of
// the same six inputs and the same pin picker, and the two would drift.
export function AddAddressScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const editing = route.params?.address as
    | { id: string; label?: string; addressLine1?: string; addressLine2?: string; city?: string; instructions?: string; isDefault?: boolean; latitude?: number; longitude?: number }
    | undefined;
  const { latitude: devLat, longitude: devLng } = useLocationStore();
  const addAddress = useAddAddress();
  const updateAddress = useUpdateAddress();
  const saving = editing ? updateAddress : addAddress;

  const [label, setLabel] = useState(editing?.label ?? 'Home');
  const [line1, setLine1] = useState(editing?.addressLine1 ?? '');
  const [line2, setLine2] = useState(editing?.addressLine2 ?? '');
  const [city, setCity] = useState(editing?.city ?? 'Georgetown');
  const [instructions, setInstructions] = useState(editing?.instructions ?? '');
  const [isDefault, setIsDefault] = useState(editing ? editing.isDefault === true : true);
  const [pin, setPin] = useState<{ latitude: number; longitude: number } | null>(
    editing?.latitude != null && editing?.longitude != null
      ? { latitude: editing.latitude, longitude: editing.longitude }
      // A new address starts on the device fix; an edited one keeps ITS pin,
      // never the phone's current position — editing the gate code from work
      // must not silently move home across town.
      : devLat != null && devLng != null
        ? { latitude: devLat, longitude: devLng }
        : null,
  );

  // Map picker returns via merged params.
  useEffect(() => {
    if (route.params?.picked) setPin(route.params.picked);
  }, [route.params?.picked]);

  const valid = label.trim().length >= 2 && line1.trim().length >= 3 && city.trim().length >= 2 && !!pin;

  const err = saving.isError
    ? ((saving.error as any)?.response?.data?.error?.message ?? 'Could not save the address.')
    : undefined;

  const save = () => {
    if (!pin) return;
    const body = {
      label: label.trim(),
      addressLine1: line1.trim(),
      // Cleared, not omitted: an edit that empties the flat number has to
      // REMOVE it. Sending undefined would leave the old value standing,
      // because the route only writes the keys it is given.
      addressLine2: line2.trim(),
      city: city.trim(),
      latitude: pin.latitude,
      longitude: pin.longitude,
      instructions: instructions.trim(),
    };
    const done = { onSuccess: () => navigation.goBack() };
    if (editing) {
      updateAddress.mutate({ id: editing.id, data: body }, done);
      return;
    }
    addAddress.mutate({ ...body, isDefault }, done);
  };

  return (
    <Screen>
      <Header title={editing ? 'Edit Address' : 'Add Address'} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: GUTTER, paddingTop: space.md, paddingBottom: space['2xl'], gap: space.xl }}
          keyboardShouldPersistTaps="handled"
        >
          <LabeledInput label="Label" icon="bookmark" placeholder="Home, Work…" value={label} onChangeText={setLabel} />
          <LabeledInput label="Street Address" icon="map-pin" placeholder="Street + number" value={line1} onChangeText={setLine1} />
          <LabeledInput label="Apt / landmark (optional)" icon="map" placeholder="Near…" value={line2} onChangeText={setLine2} />
          <LabeledInput label="City / Town" icon="map" value={city} onChangeText={setCity} />
          <LabeledInput
            label="Delivery instructions (optional)"
            icon="message-square"
            placeholder="Gate code, dog, etc."
            value={instructions}
            onChangeText={setInstructions}
            error={err}
          />

          {/* Pin on map */}
          <Pressable
            onPress={() => navigation.navigate('LocationPicker', { returnTo: 'AddAddress', initial: pin })}
          >
            {({ pressed }) => (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                padding: space.lg,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: pin ? color.border.subtle : color.brand[500],
                backgroundColor: color.surface.base,
                opacity: pressed ? 0.75 : 1,
              }}
            >
              <Feather name="crosshair" size={18} color={pin ? color.success : color.brand[500]} />
              <View style={{ flex: 1 }}>
                <T variant="body" weight="medium">
                  {pin ? 'Pin set on the map' : 'Drop the pin on the map'}
                </T>
                <T variant="caption" tone="muted">
                  {pin ? `${pin.latitude.toFixed(5)}, ${pin.longitude.toFixed(5)} — tap to adjust` : 'Required so riders find you'}
                </T>
              </View>
              <Feather name="chevron-right" size={18} color={color.text.muted} />
            </View>
            )}
          </Pressable>

          {/* Default is owned by the list's own action when editing — PUT
              /addresses/:id does not touch isDefault, so a switch here would
              be a control that silently does nothing. */}
          {editing ? null : (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <T variant="body" weight="medium">
                Set as default address
              </T>
              <BrandSwitch value={isDefault} onChange={setIsDefault} />
            </View>
          )}

          {/* [#947's grammar] Disabled names the first missing thing. */}
          <PillButton
            label={
              label.trim().length < 2
                ? 'Give it a label'
                : line1.trim().length < 3
                  ? 'Add the street address'
                  : city.trim().length < 2
                    ? 'Add the city'
                    : !pin
                      ? 'Drop the pin on the map'
                      : editing
                        ? 'Save Changes'
                        : 'Save Address'
            }
            loading={saving.isPending}
            disabled={!valid}
            onPress={save}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
