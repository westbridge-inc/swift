import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuthStore } from '../stores/authStore';
import {
  parseServedPolicy,
  policyFor,
  recordEmergencyDial,
  resolveEmergencyDial,
  type EmergencyDial,
  type EmergencyPolicy,
  type EmergencyService,
} from '../lib/emergencyPolicy';

// The served market emergency policy [MOB-018]: fetched in the background,
// cached for the process, NEVER waited for at press time. The decision of what
// to dial is synchronous (lib/emergencyPolicy.ts) over whatever policy this
// process holds — the server's, or the bundled fallback.

let served: EmergencyPolicy | null = null;

export async function fetchEmergencyPolicy(country: string): Promise<EmergencyPolicy | null> {
  try {
    const res = await api.get('/public/emergency-policy', { params: { country }, timeout: 5_000 });
    const policy = parseServedPolicy(res.data?.data);
    if (policy) served = policy;
    return policy;
  } catch {
    return null;
  }
}

/** What an SOS surface would do right now, for the copy it renders. Does not count. */
export function previewEmergencyDial(country: string | null | undefined, service: EmergencyService = 'police'): EmergencyDial {
  return resolveEmergencyDial(policyFor(country, served), service);
}

/** The decision at press time — synchronous, and counted (emergency_dial_market). */
export function emergencyDialFor(country: string | null | undefined, service: EmergencyService = 'police'): EmergencyDial {
  const dial = previewEmergencyDial(country, service);
  recordEmergencyDial(dial);
  return dial;
}

/** The current market's decision, for screens that keep their own popup. */
export function currentMarketDial(service: EmergencyService = 'police'): EmergencyDial {
  return emergencyDialFor(useAuthStore.getState().countryCode, service);
}

/** The words a surface shows BEFORE the person taps — honest about what the tap does. */
export function emergencyDialCopy(dial: EmergencyDial): string {
  if (dial.kind === 'auto') return `This dials ${dial.number} — your market’s emergency services — right away.`;
  if (dial.kind === 'confirm') return `This dials ${dial.number}, the emergency number Swift has for your market (not yet verified by Swift on a device).`;
  return 'Swift has no verified emergency number for your market yet — dial your local emergency services first.';
}

/** Keep the served policy fresh for the signed-in market; the decision itself never waits for this. */
export function useEmergencyPolicy(): { country: string | null; dial: EmergencyDial } {
  const country = useAuthStore((s) => s.countryCode);
  useQuery({
    queryKey: ['emergency-policy', country],
    queryFn: () => fetchEmergencyPolicy(country as string),
    enabled: !!country,
    staleTime: 60 * 60_000,
    retry: 1,
  });
  return { country, dial: previewEmergencyDial(country) };
}

export function resetEmergencyPolicyForTests(): void {
  served = null;
}
