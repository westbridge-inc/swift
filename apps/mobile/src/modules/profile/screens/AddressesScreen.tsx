/** @jsxImportSource react */
import React from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { useAddresses, useSetCartAddress } from '../../../hooks/customer';
import { Card, EmptyState, ErrorState, Header, IconChip, LoadingBlock, PillButton, Screen, T } from '../../../kit';

// Address book, in kit row-card language. With route.params.selectFor==='cart'
// a tap binds the address to the server-side cart and returns to it.
export function AddressesScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const selectForCart = route.params?.selectFor === 'cart';

  const addresses = useAddresses<any>();
  const setCartAddress = useSetCartAddress();

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
                    {selectForCart ? <Feather name="chevron-right" size={18} color={color.text.muted} /> : null}
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
