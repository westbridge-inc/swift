import type { PushProvider, SubmissionGuard } from './channels';
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
  /** True when `stillWanted` answered no before some request went out. */
  withdrawn: boolean;
}

/** What a stored device reported. Anything that is not a whole number reads
 *  as 0, today's builds: a channel is named only to a device that positively
 *  said it has the channels, and no device is ever left out of both groups
 *  (the column is NOT NULL DEFAULT 0, but a partial select or a test double
 *  can hand over a row without it). */
function alertsVersionOf(device: PushDevice): number {
  return Number.isInteger(device.alertsVersion) ? device.alertsVersion : 0;
}

/**
 * Send one push to `devices`. `stillWanted`, when given, travels with the
 * options to the provider, which asks it right before EVERY request it makes:
 * each chunk, and each retry after a failure (channels.ts, AX291 F04). A push
 * that stops meaning anything while it goes out (the store answered the
 * order) is withdrawn rather than delivered late, and no later group is
 * tried. A provider failure in one group does not stop the other group; the
 * first failure is rethrown once both were tried, so a caller that retries
 * or counts failures still sees it.
 */
export async function pushToDevices(
  push: PushProvider,
  devices: readonly PushDevice[],
  title: string,
  body: string,
  data: Record<string, unknown> | undefined,
  opts: { stillWanted?: () => Promise<boolean>; submit?: SubmissionGuard } = {},
): Promise<DevicePushResult> {
  const groups = [
    devices.filter((device) => alertsVersionOf(device) < CHANNELS_ALERTS_VERSION),
    devices.filter((device) => alertsVersionOf(device) >= CHANNELS_ALERTS_VERSION),
  ];
  const result: DevicePushResult = { sent: 0, invalidTokens: [], withdrawn: false };
  let failure: { err: unknown } | undefined;
  for (const group of groups) {
    if (group.length === 0) continue;
    try {
      const sent = await push.sendPush(
        group.map((device) => device.token),
        title,
        body,
        data,
        {
          ...pushOptionsForDevice(data, alertsVersionOf(group[0]!)),
          ...(opts.stillWanted ? { stillWanted: opts.stillWanted } : {}),
          ...(opts.submit ? { submit: opts.submit } : {}),
        },
      );
      result.sent += sent.sent;
      if (sent.invalidTokens?.length) result.invalidTokens.push(...sent.invalidTokens);
      if (sent.withdrawn) {
        result.withdrawn = true;
        break;
      }
    } catch (err) {
      failure ??= { err };
    }
  }
  if (failure) throw failure.err;
  return result;
}
