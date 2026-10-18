import type { NotificationHandoff, PushOptions, PushProvider } from './channels';
import { pushOptionsFor, pushOptionsForDevice, ringsOnDevice } from './alert-class';

// ---------------------------------------------------------------------------
// [RINGER · loud alerts 3/4; continues #1367's device-push.ts] ONE push to a
// set of stored devices, each told only what the app installed on it can
// ring with:
//
//  - a device whose app reported no job ring (DeviceToken.alertsVersion 0:
//    builds 9-11, and anything that reported nothing) gets exactly the
//    message every push got before, pushOptionsFor;
//  - a device on the ring build gets the job ring too ('job_offers' channel,
//    bundled tone, iOS time-sensitive), but only for a push that rings
//    (ring_order, ring_offer).
//
// The two groups go out as separate provider requests, so one message never
// mixes them. A push that does not ring is ONE request with today's options,
// exactly as before this file existed.
// ---------------------------------------------------------------------------

export interface PushDevice {
  token: string;
  /** DeviceToken.alertsVersion; a missing or malformed value reads 0. */
  alertsVersion?: unknown;
}

/** The DeviceToken columns a fan-out reads. */
export const PUSH_DEVICE_SELECT = { token: true, alertsVersion: true } as const;

export interface DevicePushResult {
  sent: number;
  /** Tokens the provider reported dead: the caller deactivates them. */
  invalidTokens: string[];
}

/**
 * Send one push to `devices`. `handoff`, when given, travels with the options
 * as it always did; the ring group's parts are prefixed `ring:` so its chunks
 * are never mistaken for the first group's. A provider failure in one group
 * does not stop the other; the first failure is rethrown once both were
 * tried, so a caller that logs or counts failures still sees it.
 */
export async function pushToDevices(
  push: PushProvider,
  devices: readonly PushDevice[],
  title: string,
  body: string,
  data: Record<string, unknown> | undefined,
  extra: { handoff?: NotificationHandoff } = {},
): Promise<DevicePushResult> {
  const today = devices.filter((device) => !ringsOnDevice(data, device.alertsVersion));
  const ringing = devices.filter((device) => ringsOnDevice(data, device.alertsVersion));
  const { handoff } = extra;
  const groups: Array<{ tokens: string[]; options: PushOptions }> = [];
  if (today.length > 0) {
    groups.push({
      tokens: today.map((device) => device.token),
      options: { ...pushOptionsFor(data), ...(handoff ? { handoff } : {}) },
    });
  }
  if (ringing.length > 0) {
    groups.push({
      tokens: ringing.map((device) => device.token),
      options: {
        ...pushOptionsForDevice(data, ringing[0]!.alertsVersion),
        ...(handoff ? { handoff: <T>(part: string, effect: () => Promise<T>) => handoff(`ring:${part}`, effect) } : {}),
      },
    });
  }

  const result: DevicePushResult = { sent: 0, invalidTokens: [] };
  let failure: { err: unknown } | undefined;
  for (const group of groups) {
    try {
      const sent = await push.sendPush(group.tokens, title, body, data, group.options);
      result.sent += sent.sent;
      if (sent.invalidTokens?.length) result.invalidTokens.push(...sent.invalidTokens);
    } catch (err) {
      failure ??= { err };
    }
  }
  if (failure) throw failure.err;
  return result;
}
