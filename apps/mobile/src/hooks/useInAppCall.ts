import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { toast } from '../kit/toast';
import type { CallTarget } from '../lib/callBridge';
import { INAPP_WORDS, inAppErrorText, offerInApp, type InAppConfig } from '../lib/inAppCalls';
import {
  endInAppCall,
  ensureMicrophone,
  inAppCallActive,
  inAppVoiceAvailable,
  placeInAppCall,
  registerForInAppCalls,
} from '../services/inAppVoice';

// [INAPP-CALLS] One answer per app run for a few minutes (as the bridge's config); a failed read means
// "not on" (the "Call via Swift" control beside it is unaffected), and is asked again next time.
const CONFIG_TTL_MS = 5 * 60_000;
let cached: { at: number; value: InAppConfig } | null = null;
let inflight: Promise<InAppConfig | null> | null = null;
/** Loaded on first use: screens with a Call button do not pull the API client in at import. */
const calls = async () => (await import('../services/api')).callsApi;

export async function loadInAppConfig(now = Date.now()): Promise<InAppConfig | null> {
  if (cached && now - cached.at < CONFIG_TTL_MS) return cached.value;
  inflight ??= calls().then((api) => api.appConfig())
    .then((res) => { const d = res.data?.data; return d && typeof d.enabled === 'boolean' ? { enabled: d.enabled } : null; })
    .catch(() => null)
    .then((value) => { cached = value ? { at: Date.now(), value } : null; inflight = null; return value; });
  return inflight;
}

/** Tests only. */
export function resetInAppConfigForTests(): void { cached = null; inflight = null; }

/** Swift's own words before Android's bare microphone prompt. Resolves true on "Continue". */
function explainMicrophone(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(INAPP_WORDS.micTitle, INAPP_WORDS.micWhy, [
      { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Continue', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

const errorCode = (e: unknown): string | null =>
  (e as { response?: { data?: { error?: { code?: string } } } })?.response?.data?.error?.code
  ?? (e as { code?: string })?.code
  ?? null;

/**
 * "Call in app" for one person on one order. Each screen keeps its own look: it shows the control when
 * `visible`, labels it with `label`, and calls `onPress`. While visible it also keeps this phone able to be
 * rung in the app (registration with a short server token; only people on a live order get one).
 */
export function useInAppCall(input: { orderId?: string | null; target: CallTarget }) {
  const [config, setConfig] = useState<InAppConfig | null>(cached?.value ?? null);
  const [busy, setBusy] = useState(false);
  const [onCall, setOnCall] = useState(inAppCallActive());
  const busyRef = useRef(false);
  const available = inAppVoiceAvailable();
  const { orderId, target } = input;
  const visible = offerInApp(config, available, orderId, target);

  useEffect(() => {
    let live = true;
    void loadInAppConfig().then((c) => { if (live) setConfig(c); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!visible) return;
    void registerForInAppCalls(async (platform, purpose) => (await (await calls()).appToken(platform, purpose)).data.data.token);
  }, [visible]);

  const onPress = useCallback(async () => {
    if (!visible || !orderId || busyRef.current) return;
    if (inAppCallActive()) { await endInAppCall(); setOnCall(false); return; }
    busyRef.current = true;
    setBusy(true);
    try {
      if (!(await ensureMicrophone(explainMicrophone))) {
        toast.error(INAPP_WORDS.micTitle, inAppErrorText('MIC_REFUSED'));
        return;
      }
      const api = await calls();
      await placeInAppCall(orderId, target, {
        start: async (o, t, platform) => (await api.appStart(o, t, platform)).data.data,
        cancel: (callId) => api.appCancel(callId),
        onEnded: () => setOnCall(false),
      });
      setOnCall(true);
      toast.success(INAPP_WORDS.calling, INAPP_WORDS.callingHow);
    } catch (e) {
      toast.error(INAPP_WORDS.failedTitle, inAppErrorText(errorCode(e)));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [visible, orderId, target]);

  return {
    visible,
    label: onCall ? INAPP_WORDS.endLabel : INAPP_WORDS.label,
    hint: INAPP_WORDS.hint,
    a11y: onCall ? INAPP_WORDS.endLabel : INAPP_WORDS.a11y,
    busy,
    onPress: () => { void onPress(); },
  };
}
