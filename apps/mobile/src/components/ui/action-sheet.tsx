import { Modal, Pressable, View } from 'react-native';
import Animated, { SlideInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text } from './text';

/**
 * Bottom action sheet — a short menu of actions rising over a dimmed
 * backdrop (photo source, destructive menus). One component, data-driven:
 * pass `actions`; a Cancel row is always appended. Destructive actions get
 * the error tone. Backdrop tap and Android back both close.
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
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(10,11,15,0.45)' }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close menu" />
        <Animated.View
          entering={SlideInDown.duration(220)}
          style={{
            backgroundColor: color.surface.base,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingTop: 8,
            paddingBottom: insets.bottom + 8,
          }}
        >
          <View style={{ alignSelf: 'center', width: 44, height: 4, borderRadius: 2, backgroundColor: color.border.strong }} />
          {title ? (
            <Text className="mt-3 text-center text-xs font-semibold uppercase tracking-wider text-text-muted">{title}</Text>
          ) : null}
          <View style={{ marginTop: 6 }}>
            {actions.map((a, i) => (
              <Pressable
                key={a.label}
                onPress={() => {
                  onClose();
                  a.onPress();
                }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 20,
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
                      marginRight: 12,
                    }}
                  >
                    <MaterialCommunityIcons name={a.icon} size={18} color={a.destructive ? color.error : color.text.secondary} />
                  </View>
                ) : null}
                <Text className="text-base font-semibold" style={{ color: a.destructive ? color.error : color.text.primary }}>
                  {a.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => ({
              marginTop: 4,
              marginHorizontal: 16,
              height: 52,
              borderRadius: 26,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? color.border.subtle : color.surface.subtle,
            })}
          >
            <Text className="text-base font-bold text-text-primary">Cancel</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}
