import React, { useRef, useState } from 'react';
import { Dimensions, FlatList, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { DARK_BLURHASH } from '../../lib/images';
import { PillButton, T } from '../../kit';
import { useAppStore } from '../../stores/appStore';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Kit onboarding (frames 2–4): full-bleed hero photo on white, two-line display
// headline with an accented second line, muted body, pill dots, Skip/Next —
// final slide swaps the footer for a full-width Get Started.
const SLIDES = [
  {
    image: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=1200&q=80',
    title: 'Your favorites,',
    accent: 'delivered.',
    body: 'Restaurants, groceries and shops across Guyana, brought to your door.',
  },
  {
    image: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=1200&q=80',
    title: 'Follow every order,',
    accent: 'live.',
    body: 'Watch your rider move in real time, from the kitchen to your gate.',
  },
  {
    image: 'https://images.unsplash.com/photo-1547592180-85f173990554?w=1200&q=80',
    title: 'You can order',
    accent: 'from anywhere.',
    body: 'Pay cash on delivery. No hidden fees, no markups — just Swift.',
  },
] as const;

export function OnboardingScreen() {
  const setOnboarded = useAppStore((s) => s.setOnboarded);
  const listRef = useRef<FlatList<(typeof SLIDES)[number]>>(null);
  const [page, setPage] = useState(0);
  const last = page === SLIDES.length - 1;

  const next = () => {
    if (last) {
      setOnboarded();
      return;
    }
    listRef.current?.scrollToIndex({ index: page + 1, animated: true });
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.base }}>
      <FlatList
        ref={listRef}
        data={SLIDES as unknown as (typeof SLIDES)[number][]}
        keyExtractor={(s) => s.accent}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / SCREEN_W))}
        renderItem={({ item }) => (
          <View style={{ width: SCREEN_W }}>
            <Image
              source={{ uri: item.image }}
              placeholder={{ blurhash: DARK_BLURHASH }}
              transition={200}
              style={{ width: SCREEN_W, height: SCREEN_H * 0.52 }}
              contentFit="cover"
            />
            <View
              style={{ flex: 1, alignItems: 'center', paddingHorizontal: space['2xl'], paddingTop: space['4xl'] }}
            >
              <T variant="display" center>
                {item.title}
              </T>
              <T variant="display" center tone="deep">
                {item.accent}
              </T>
              <T variant="body" tone="muted" center style={{ marginTop: space.lg, maxWidth: 300 }}>
                {item.body}
              </T>
            </View>
          </View>
        )}
      />

      {/* Page indicator — elongated brand pill marks the active page. */}
      <View
        style={{
          position: 'absolute',
          bottom: SCREEN_H * 0.155,
          alignSelf: 'center',
          flexDirection: 'row',
          gap: space.sm,
        }}
      >
        {SLIDES.map((s, i) => (
          <View
            key={s.accent}
            style={{
              width: 32,
              height: 6,
              borderRadius: 3,
              backgroundColor: i === page ? color.brand[500] : color.border.subtle,
            }}
          />
        ))}
      </View>

      <SafeAreaView edges={['bottom']} style={{ paddingHorizontal: space['2xl'], paddingBottom: space.lg }}>
        {last ? (
          <PillButton label="Get Started" onPress={next} />
        ) : (
          <View
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 56 }}
          >
            <Pressable onPress={setOnboarded} hitSlop={12}>
              {({ pressed }) => (
                <T variant="body" weight="semibold" style={{ opacity: pressed ? 0.6 : 1 }}>
                  Skip
                </T>
              )}
            </Pressable>
            <Pressable onPress={next} hitSlop={12}>
              {({ pressed }) => (
                <View
                  style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, opacity: pressed ? 0.6 : 1 }}
                >
                  <T variant="body" weight="semibold">
                    Next
                  </T>
                  <Feather name="arrow-right" size={20} color={color.text.primary} />
                </View>
              )}
            </Pressable>
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}
