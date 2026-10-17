import { Linking, Platform } from 'react-native';
import { toast } from '../kit/toast';
import { directionsLinks, type DirectionsTarget } from './directions';
import { openExternal } from './openExternal';

const FAIL = "Couldn't open maps on this phone.";

/** [row 363] Open directions in this phone's own maps (lib/directions.ts picks
 *  the link). A link that will not open falls back once, then says so. */
export async function openDirections(target: DirectionsTarget): Promise<boolean> {
  const links = directionsLinks(target, Platform.OS);
  if (!links) {
    toast.show(FAIL);
    return false;
  }
  if (!links.fallback) return openExternal(links.primary, FAIL);
  try {
    await Linking.openURL(links.primary);
    return true;
  } catch {
    return openExternal(links.fallback, FAIL);
  }
}
