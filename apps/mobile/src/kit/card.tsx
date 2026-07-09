import React from 'react';
import { Modal, Pressable, View, type ViewProps, type ViewStyle } from 'react-native';
import { color, radius, space } from '@swift/ui';

/** Soft card shadow — separation on paper comes from shadow, not borders. */
export const cardShadow: ViewStyle = {
  shadowColor: '#211A1A',
  shadowOpacity: 0.06,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
  elevation: 3,
};

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
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: 'rgba(33,26,26,0.45)',
          justifyContent: 'center',
          paddingHorizontal: space['2xl'],
        }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={[
            {
              backgroundColor: color.surface.base,
              borderRadius: radius.xl,
              padding: space['2xl'],
              alignItems: 'center',
            },
            cardShadow,
          ]}
        >
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
