import type { PushProvider } from './channels';
import { CHANNELS_ALERTS_VERSION, pushOptionsForDevice } from './alert-class';

// ---------------------------------------------------------------------------
// [Q10 loud alerts 2/4] ONE push to a set of stored devices, each told only
// what the app installed on it can show. Every push the API sends to a
// DeviceToken row goes through here, so the channel gate cannot be forgotten
// at a call site:
//
//  - a device reporting alertsVersion < CHANNELS_ALERTS_VERSION (every build
//    in people's hands today) gets exactly the message it got before: no
//    channelId, because Android never shows a push naming a channel the app
//    did not create;
//  - a device on the channel build gets the channel of the push's class.
//
// The two groups go out as separate provider requests, so one message never
// mixes them.
// ---------------------------------------------------------------------------

export interface PushDevice {
  token: string;
  alertsVersion: number;
}

/** The DeviceToken columns a fan-out reads. */
export const PUSH_DEVICE_SELECT = { token: true, alertsVersion: true } as const;

export interface DevicePushResult {
  /** Devices the provider accepted the push for. */
  sent: number;
  /** Tokens the provider reported dead: the caller deactivates them. */
  invalidTokens: string[];
  /** True when `stillWanted` answered no before every group was sent. */
  withdrawn: boolean;
}

/**
 * Send one push to `devices`. `stillWanted`, when given, is asked before
 * EACH provider request, as the last thing before it: a push that stops
 * meaning anything while the fan-out runs (the store answered the order) is
 * withdrawn rather than delivered late. A provider failure in one group does
 * not stop the other group; the first failure is rethrown once both were
 * tried, so a caller that retries or counts failures still sees it.
 */
export async function pushToDevices(
  push: PushProvider,
  devices: readonly PushDevice[],
  title: string,
  body: string,
  data: Record<string, unknown> | undefined,
  opts: { stillWanted?: () => Promise<boolean> } = {},
): Promise<DevicePushResult> {
  const groups = [
    devices.filter((device) => device.alertsVersion < CHANNELS_ALERTS_VERSION),
    devices.filter((device) => device.alertsVersion >= CHANNELS_ALERTS_VERSION),
  ];
  const result: DevicePushResult = { sent: 0, invalidTokens: [], withdrawn: false };
  let failure: { err: unknown } | undefined;
  for (const group of groups) {
    if (group.length === 0) continue;
    if (opts.stillWanted && !(await opts.stillWanted())) {
      result.withdrawn = true;
      break;
    }
    try {
      const sent = await push.sendPush(
        group.map((device) => device.token),
        title,
        body,
        data,
        pushOptionsForDevice(data, group[0]!.alertsVersion),
      );
      result.sent += sent.sent;
      if (sent.invalidTokens?.length) result.invalidTokens.push(...sent.invalidTokens);
    } catch (err) {
      failure ??= { err };
    }
  }
  if (failure) throw failure.err;
  return result;
}
