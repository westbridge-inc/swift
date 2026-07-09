/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { color, radius, space } from '@swift/ui';
import { useAddAddress } from '../../../hooks/customer';
import { useLocationStore } from '../../../stores/locationStore';
import { BrandSwitch, Header, LabeledInput, PillButton, Screen, T } from '../../../kit';

const GUTTER = space['2xl'];

// Composed from kit input language (no kit frame). Coordinates come from the
// device fix or the map picker — an address without a pin can't be delivered.
export function AddAddressScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { latitude: devLat, longitude: devLng } = useLocationStore();
  const addAddress = useAddAddress();

  const [label, setLabel] = useState('Home');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('Georgetown');
  const [instructions, setInstructions] = useState('');
  const [isDefault, setIsDefault] = useState(true);
  const [pin, setPin] = useState<{ latitude: number; longitude: number } | null>(
    devLat != null && devLng != null ? { latitude: devLat, longitude: devLng } : null,
  );

  // Map picker returns via merged params.
  useEffect(() => {
    if (route.params?.picked) setPin(route.params.picked);
  }, [route.params?.picked]);

  const valid = label.trim().length >= 2 && line1.trim().length >= 3 && city.trim().length >= 2 && !!pin;

  const err = addAddress.isError
    ? ((addAddress.error as any)?.response?.data?.error?.message ?? 'Could not save the address.')
    : undefined;

  const save = () => {
    if (!pin) return;
    addAddress.mutate(
      {
        label: label.trim(),
        addressLine1: line1.trim(),
        ...(line2.trim() ? { addressLine2: line2.trim() } : {}),
        city: city.trim(),
        latitude: pin.latitude,
        longitude: pin.longitude,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        isDefault,
      },
      { onSuccess: () => navigation.goBack() },
    );
  };

  return (
    <Screen>
      <Header title="Add Address" />
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

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <T variant="body" weight="medium">
              Set as default address
            </T>
            <BrandSwitch value={isDefault} onChange={setIsDefault} />
          </View>

          <PillButton label="Save Address" loading={addAddress.isPending} disabled={!valid} onPress={save} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
