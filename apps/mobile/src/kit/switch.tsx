import { Switch as RNSwitch, type SwitchProps } from 'react-native';
import { color } from '@swift/ui';

/** Brand-toned toggle — the native switch with Swift's track colors.
 *  [B6] Kit port of components/ui/switch, verbatim. */
export function Switch(props: SwitchProps) {
  return (
    <RNSwitch
      trackColor={{ false: color.border.strong, true: color.brand[500] }}
      thumbColor={color.white}
      ios_backgroundColor={color.border.strong}
      {...props}
    />
  );
}
