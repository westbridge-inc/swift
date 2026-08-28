/** @jsxImportSource react */
import React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, elevation, radius, space } from '@swift/ui';
import { T, type TP } from './text';

/**
 * Soft card shadow — separation on paper comes from shadow, not borders.
 *
 * [D1 — decided] This was the THIRD author of the card shadow: the token layer
 * had `shadow.card` (1/3, pure black) and `elevation.card` (6/14, cold black)
 * while every card in the app actually rendered this one (4/12, warm). Now it
 * IS `elevation.card` — imported, not restated — so web and native cannot drift
 * apart again and there is one place to change a card's depth.
 */
export const cardShadow: ViewStyle = elevation.card as ViewStyle;

/** White rounded-16 card. `pad={false}` for image-bleed cards (clips children). */
export function Card({ children, style, pad = true, ...rest }: ViewProps & { pad?: boolean }) {
  return (
    <View
      style={[
        {
          backgroundColor: color.surface.base,
          borderRadius: radius.lg,
          padding: pad ? space.lg : 0,
          overflow: pad ? 'visible' : 'hidden',
        },
        cardShadow,
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

/** Semantic heading for popup/dialog titles. Visual typography stays caller-
 *  controlled while VoiceOver/TalkBack gain a reliable heading landmark. */
export function PopupTitle({ variant = 'title', ...rest }: Omit<TP, 'accessibilityRole'>) {
  return <T {...rest} variant={variant} accessibilityRole="header" />;
}

/** Kit centered popup (voucher applied / delivered / logout confirm):
 *  dim scrim, white rounded-20 sheet, caller supplies content + actions. */
export function PopupCard({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={onClose}
          // A labelled Pressable becomes one accessibility element and swallows
          // every heading/button beneath it. Keep the backdrop touchable but out
          // of the accessibility tree; VoiceOver/TalkBack use the modal actions
          // or the escape gesture instead.
          accessible={false}
          focusable={false}
          importantForAccessibility="no"
          style={{
            flex: 1,
            alignItems: 'center',
            backgroundColor: 'rgba(33,26,26,0.45)',
            justifyContent: 'center',
            paddingTop: Math.max(space.lg, insets.top),
            paddingRight: Math.max(space.lg, insets.right),
            paddingBottom: Math.max(space.lg, insets.bottom),
            paddingLeft: Math.max(space.lg, insets.left),
          }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            accessible={false}
            accessibilityViewIsModal
            focusable={false}
            onAccessibilityEscape={onClose}
            style={[
              {
                width: '100%',
                maxWidth: 560,
                maxHeight: '100%',
                flexShrink: 1,
                backgroundColor: color.surface.base,
                borderRadius: radius.xl,
                overflow: 'hidden',
              },
              cardShadow,
            ]}
          >
            <ScrollView
              bounces={false}
              contentContainerStyle={{
                alignItems: 'center',
                padding: space['2xl'],
              }}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator
              style={{ width: '100%', flexShrink: 1 }}
            >
              {children}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
