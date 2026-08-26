import { Linking } from 'react-native';
import { toast } from '../kit/toast';

/** [WR-037] One honest opener for OS-level actions (tel:, mailto:, maps).
 *  Rejections were swallowed at ~a dozen call sites — a tap that did nothing,
 *  silently. No server effect is expected; the honesty is the toast. */
export async function openExternal(url: string, failMessage = "Couldn't open that on this phone."): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    toast.show(failMessage);
    return false;
  }
}
