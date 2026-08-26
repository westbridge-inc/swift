import { Modal, Pressable, View } from 'react-native';
import Animated, { SlideInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { T } from './text';

/**
 * Bottom action sheet — a short menu of actions rising over a dimmed
 * backdrop (photo source, destructive menus). One component, data-driven:
 * pass `actions`; a Cancel row is always appended. Destructive actions get
 * the error tone. Backdrop tap and Android back both close.
 *
 * [DRIFT-09] Kit port of components/ui/action-sheet, same API. Structural
 * literals (24pt top radius, 56pt rows, the 44×4 grab handle) are the shipped
 * sheet geometry, kept until the Sheet primitive (Design Standard: 28pt,
 * maroon-header option) supersedes this at the screen-rebuild wave.
 */
export type SheetAction = {
  label: string;
  icon?: keyof typeof MaterialCommunityIcons.glyphMap;
  destructive?: boolean;
  onPress: () => void;
};

export function ActionSheet({
  open,
  onClose,
  title,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  actions: SheetAction[];
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: color.scrim }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close menu" />
        <Animated.View
          entering={SlideInDown.duration(220)}
          style={{
            backgroundColor: color.surface.base,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingTop: space.sm,
            paddingBottom: insets.bottom + space.sm,
          }}
        >
          <View style={{ alignSelf: 'center', width: 44, height: 4, borderRadius: 2, backgroundColor: color.border.strong }} />
          {title ? (
            <T
              variant="micro"
              weight="semibold"
              tone="muted"
              center
              style={{ marginTop: space.md, textTransform: 'uppercase', letterSpacing: 1 }}
            >
              {title}
            </T>
          ) : null}
          <View style={{ marginTop: 6 }}>
            {actions.map((a, i) => (
              <Pressable
                key={a.label}
                onPress={() => {
                  onClose();
                  a.onPress();
                }}
                accessibilityRole="button"
                accessibilityLabel={a.label}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: space.xl,
                  height: 56,
                  borderBottomWidth: i < actions.length - 1 ? 1 : 0,
                  borderBottomColor: color.border.subtle,
                  backgroundColor: pressed ? color.surface.subtle : 'transparent',
                })}
              >
                {a.icon ? (
                  <View
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 17,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: color.surface.subtle,
                      marginRight: space.md,
                    }}
                  >
                    <MaterialCommunityIcons name={a.icon} size={18} color={a.destructive ? color.error : color.text.secondary} />
                  </View>
                ) : null}
                <T variant="body" weight="semibold" style={{ color: a.destructive ? color.error : color.text.primary }}>
                  {a.label}
                </T>
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            style={({ pressed }) => ({
              marginTop: 4,
              marginHorizontal: space.lg,
              height: 52,
              borderRadius: 26,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? color.border.subtle : color.surface.subtle,
            })}
          >
            <T variant="body" weight="bold">Cancel</T>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}
