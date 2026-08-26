/** @jsxImportSource react */
import React from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { useAddresses, useDeleteAddress, useSetCartAddress, useSetDefaultAddress } from '../../../hooks/customer';
import { Card, EmptyState, ErrorState, Header, IconChip, LoadingBlock, PillButton, Screen, T } from '../../../kit';

// Address book, in kit row-card language. With route.params.selectFor==='cart'
// a tap binds the address to the server-side cart and returns to it.
//
// [S14] This screen used to offer exactly one action: "Add New Address". The
// API has had PUT /addresses/:id, DELETE /addresses/:id and
// PUT /addresses/:id/default the whole time — owner-scoped, tested, and with
// no caller anywhere in the app. So the address book was APPEND-ONLY: a
// mistyped street stayed on the list forever, sitting next to the correct one
// at checkout, and the flat you moved out of two years ago could never be
// removed. Whichever address happened to be saved first stayed the default
// for good. Nothing needed building; it needed connecting.
export function AddressesScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const selectForCart = route.params?.selectFor === 'cart';

  const addresses = useAddresses<any>();
  const setCartAddress = useSetCartAddress();
  const setDefault = useSetDefaultAddress();
  const remove = useDeleteAddress();

  // One id at a time, so only the row being changed shows the pending state
  // rather than the whole list greying out.
  const busyId = setDefault.isPending
    ? (setDefault.variables as string | undefined)
    : remove.isPending
      ? (remove.variables as string | undefined)
      : undefined;

  // Destructive and irreversible — the row carries the street, so removing it
  // is the customer exercising a deletion right, not a UI tidy-up. It is named
  // in the prompt so nobody deletes the wrong one from a list of four.
  const confirmRemove = (a: any) => {
    Alert.alert(
      `Remove ${a.label ?? 'this address'}?`,
      [a.addressLine1, a.city].filter(Boolean).join(', '),
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () =>
            remove.mutate(a.id, {
              onError: () => Alert.alert('Could not remove it', 'Check your connection and try again.'),
            }),
        },
      ],
    );
  };

  const rows: any[] = Array.isArray(addresses.data) ? addresses.data : (addresses.data?.addresses ?? []);

  const pick = (a: any) => {
    if (!selectForCart) return;
    setCartAddress.mutate(a.id, { onSuccess: () => navigation.goBack() });
  };

  return (
    <Screen>
      <Header title={selectForCart ? 'Deliver To' : 'My Addresses'} />
      {addresses.isLoading ? (
        <LoadingBlock />
      ) : addresses.isError ? (
        <ErrorState onRetry={() => addresses.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="map-pin"
          title="No addresses yet"
          body="Add where deliveries should go — home, work, anywhere."
          actionLabel="Add Address"
          onAction={() => navigation.navigate('AddAddress')}
        />
      ) : (
        <>
          <FlatList
            data={rows}
            keyExtractor={(a) => a.id}
            contentContainerStyle={{ padding: space['2xl'], gap: space.md }}
            renderItem={({ item: a }) => (
              <Pressable onPress={() => pick(a)} disabled={!selectForCart}>
                {({ pressed }) => (
                  <Card
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.md,
                      padding: space.md,
                      opacity: pressed ? 0.8 : 1,
                      borderWidth: selectForCart ? 1 : 0,
                      borderColor: color.border.subtle,
                    }}
                  >
                    <IconChip icon={a.label?.toLowerCase().includes('work') ? 'briefcase' : 'home'} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                        <T variant="body" weight="semibold">
                          {a.label ?? 'Address'}
                        </T>
                        {a.isDefault ? (
                          <View
                            style={{
                              paddingHorizontal: space.sm,
                              paddingVertical: 2,
                              borderRadius: 9999,
                              backgroundColor: color.brand[50],
                            }}
                          >
                            <T variant="caption" weight="semibold" tone="deep">
                              Default
                            </T>
                          </View>
                        ) : null}
                      </View>
                      <T variant="caption" tone="muted" numberOfLines={2}>
                        {[a.addressLine1, a.addressLine2, a.city].filter(Boolean).join(', ')}
                      </T>
                    </View>
                    {selectForCart ? (
                      <Feather name="chevron-right" size={18} color={color.text.muted} />
                    ) : (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
                        {a.isDefault ? null : (
                          <RowAction
                            icon="check-circle"
                            label={`Make ${a.label ?? 'this address'} the default`}
                            busy={busyId === a.id}
                            onPress={() => setDefault.mutate(a.id)}
                          />
                        )}
                        <RowAction
                          icon="edit-2"
                          label={`Edit ${a.label ?? 'this address'}`}
                          onPress={() => navigation.navigate('AddAddress', { address: a })}
                        />
                        <RowAction
                          icon="trash-2"
                          tone="danger"
                          label={`Remove ${a.label ?? 'this address'}`}
                          busy={busyId === a.id}
                          onPress={() => confirmRemove(a)}
                        />
                      </View>
                    )}
                  </Card>
                )}
              </Pressable>
            )}
          />
          <View style={{ paddingHorizontal: space['2xl'], paddingBottom: space['2xl'] }}>
            <PillButton label="Add New Address" icon="plus" onPress={() => navigation.navigate('AddAddress')} />
          </View>
        </>
      )}
    </Screen>
  );
}

/**
 * A compact icon action inside an address row.
 *
 * Icon-only on purpose — three labelled buttons per row would out-shout the
 * address itself, which is the thing being read. The label is not lost: it
 * goes to `accessibilityLabel` naming the specific address, so a screen reader
 * says "Remove Home", never "button". Touch target stays at 44 via padding
 * even though the glyph is 16.
 */
function RowAction({
  icon,
  label,
  onPress,
  tone,
  busy,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  tone?: 'danger';
  busy?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={space.sm}
      style={{ padding: space.sm, opacity: busy ? 0.4 : 1 }}
    >
      <Feather name={icon} size={16} color={tone === 'danger' ? color.error : color.text.muted} />
    </Pressable>
  );
}
