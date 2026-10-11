import { Linking, Pressable } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { T } from '../kit';
import { toast } from '../kit/toast';

/** OSRM routing uses OSM data; the native basemap keeps its own credit. */
export function RouteAttribution({ top }: { top: number }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel="Routing data: OpenStreetMap contributors. Open data licence."
      onPress={() => void Linking.openURL('https://www.openstreetmap.org/copyright').catch(() => toast.show('Couldn’t open the data licence. Try again.'))}
      style={{
        position: 'absolute',
        top,
        right: space.sm,
        minHeight: 44,
        maxWidth: 240,
        justifyContent: 'center',
        paddingHorizontal: space.sm,
        paddingVertical: space.xs,
        borderRadius: radius.sm,
        backgroundColor: color.surface.base,
      }}
    >
      <T variant="caption" style={{ color: color.text.primary }}>
        Routing: © OpenStreetMap contributors
      </T>
    </Pressable>
  );
}
