import { useMemo, useState } from 'react';
import { View, ScrollView, TextInput, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Button, Image, PressableScale, Scrim } from '../../../components/ui';
import { useAddToCart } from '../../../hooks';
import { useAuthStore } from '../../../stores/authStore';
import { money } from '../../../lib/money';
import { fallbackImage, type ImageKind } from '../../../lib/images';

type Option = { id: string; name: string; additionalPrice?: number | string; isDefault?: boolean; isAvailable?: boolean };
type Group = { id: string; name: string; isRequired?: boolean; minSelect?: number; maxSelect?: number; options: Option[] };

const SHADOW = { shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4 } as const;

// Uber Eats-style item customization: choose options (single = radio, multi =
// checkbox with min/max), add a note, set quantity, and the CTA shows the live
// total. Produces selectedOptions as { [groupId]: optionId[] } — the exact shape
// the cart/checkout price.
export function ItemDetailScreen({ navigation, route }: any) {
  const insets = useSafeAreaInsets();
  const vendorId: string = route?.params?.vendorId;
  const item: any = route?.params?.item ?? {};
  const kind: ImageKind = route?.params?.vendorKind ?? 'food';
  const groups: Group[] = useMemo(() => item.optionGroups ?? [], [item.optionGroups]);
  const basePrice = Number(item.customerPrice ?? item.basePrice ?? 0);

  const addToCart = useAddToCart();
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const [selected, setSelected] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const g of groups) {
      const defaults = (g.options ?? []).filter((o) => o.isDefault).map((o) => o.id);
      if (defaults.length) init[g.id] = (g.maxSelect ?? 1) === 1 ? [defaults[0]!] : defaults.slice(0, g.maxSelect ?? 1);
    }
    return init;
  });

  const toggle = (g: Group, optId: string) => {
    setSelected((prev) => {
      const cur = prev[g.id] ?? [];
      const max = g.maxSelect ?? 1;
      if (max === 1) return { ...prev, [g.id]: [optId] };
      if (cur.includes(optId)) return { ...prev, [g.id]: cur.filter((x) => x !== optId) };
      if (cur.length >= max) return prev;
      return { ...prev, [g.id]: [...cur, optId] };
    });
  };

  const optionsUnit = useMemo(() => {
    let sum = 0;
    for (const g of groups) {
      for (const id of selected[g.id] ?? []) {
        const o = g.options.find((x) => x.id === id);
        if (o) sum += Number(o.additionalPrice ?? 0);
      }
    }
    return sum;
  }, [groups, selected]);

  const total = (basePrice + optionsUnit) * qty;
  const missing = groups.filter((g) => g.isRequired && (selected[g.id]?.length ?? 0) < Math.max(1, g.minSelect ?? 1));
  const canAdd = missing.length === 0 && item.isAvailable !== false;

  const onAdd = () => {
    if (!canAdd) return;
    // Browsing is open; ordering needs an account.
    if (!useAuthStore.getState().isAuthenticated) {
      useAuthStore.getState().promptLogin();
      return;
    }
    addToCart.mutate(
      {
        vendorId,
        itemId: item.id,
        quantity: qty,
        selectedOptions: selected,
        specialInstructions: notes.trim() || undefined,
      },
      { onSuccess: () => navigation?.goBack?.() },
    );
  };

  return (
    <View style={{ flex: 1 }} className="bg-surface-base">
      <ScrollView contentContainerStyle={{ paddingBottom: 168 }} showsVerticalScrollIndicator={false}>
        <View>
          <Image source={{ uri: item.imageUrl || fallbackImage(item.id, kind) }} style={{ width: '100%', height: 240 }} />
          <Scrim height={96} />
          <PressableScale
            onPress={() => navigation?.goBack?.()}
            hitSlop={10}
            style={[{ position: 'absolute', top: insets.top + 8, left: 16, width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.base }, SHADOW]}
          >
            <Feather name="chevron-left" size={24} color={color.text.primary} />
          </PressableScale>
        </View>

        <View className="px-lg pt-lg">
          <Heading size="2xl">{item.name}</Heading>
          {item.description ? <Text className="mt-xs text-base text-text-secondary">{item.description}</Text> : null}
          <Text className="mt-sm text-xl font-extrabold text-brand-600">{money(basePrice)}</Text>
        </View>

        {groups.map((g) => {
          const single = (g.maxSelect ?? 1) === 1;
          return (
            <View key={g.id} className="mt-lg">
              <View className="flex-row items-center justify-between px-lg">
                <Heading size="lg">{g.name}</Heading>
                <View className="rounded-full bg-surface-subtle px-2.5 py-1">
                  <Text className="text-xs font-semibold text-text-secondary">
                    {g.isRequired ? 'Required' : !single ? `Up to ${g.maxSelect}` : 'Optional'}
                  </Text>
                </View>
              </View>
              <View className="mt-sm">
                {g.options.map((o) => {
                  const on = (selected[g.id] ?? []).includes(o.id);
                  const icon = single
                    ? on ? 'radiobox-marked' : 'radiobox-blank'
                    : on ? 'checkbox-marked' : 'checkbox-blank-outline';
                  return (
                    <Pressable
                      key={o.id}
                      onPress={() => toggle(g, o.id)}
                      className="flex-row items-center border-b border-border-subtle px-lg py-md"
                    >
                      <MaterialCommunityIcons name={icon as any} size={22} color={on ? color.brand[500] : color.text.muted} />
                      <Text className="ml-md flex-1 text-base text-text-primary">{o.name}</Text>
                      {Number(o.additionalPrice ?? 0) > 0 ? (
                        <Text className="text-sm text-text-secondary">+{money(Number(o.additionalPrice))}</Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}

        <View className="mt-lg px-lg">
          <Heading size="lg" className="mb-sm">Add a note</Heading>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="e.g. no onions, extra napkins…"
            placeholderTextColor={color.text.muted}
            multiline
            className="rounded-2xl border border-border-subtle bg-surface-base px-lg py-md font-body text-base text-text-primary"
            style={{ minHeight: 64 }}
          />
        </View>

        <View className="mx-lg mt-lg flex-row items-center rounded-2xl bg-brand-50 px-lg py-md">
          <MaterialCommunityIcons name="tag-heart-outline" size={18} color={color.brand[600]} />
          <Text className="ml-sm flex-1 text-sm font-medium text-brand-700">
            No platform fees — this is the vendor’s price, end to end.
          </Text>
        </View>
      </ScrollView>

      <View
        className="absolute inset-x-0 bottom-0 flex-row items-center border-t border-border-subtle bg-surface-base px-lg pt-md"
        style={{ paddingBottom: insets.bottom + 12, gap: 12 }}
      >
        <View className="flex-row items-center rounded-full border border-border-strong">
          <PressableScale onPress={() => setQty((q) => Math.max(1, q - 1))} className="h-11 w-11 items-center justify-center">
            <Feather name="minus" size={18} color={color.text.primary} />
          </PressableScale>
          <Text className="w-7 text-center text-base font-bold text-text-primary">{qty}</Text>
          <PressableScale onPress={() => setQty((q) => q + 1)} className="h-11 w-11 items-center justify-center">
            <Feather name="plus" size={18} color={color.text.primary} />
          </PressableScale>
        </View>
        <View className="flex-1">
          <Button loading={addToCart.isPending} disabled={!canAdd} onPress={onAdd}>
            <View className="w-full flex-row items-center justify-between">
              <Text className="font-body font-semibold text-white" numberOfLines={1}>
                {item.isAvailable === false ? 'Unavailable' : missing.length ? `Choose ${missing[0]!.name}` : 'Add to cart'}
              </Text>
              <Text className="font-body font-semibold text-white">{money(total)}</Text>
            </View>
          </Button>
        </View>
      </View>
    </View>
  );
}
