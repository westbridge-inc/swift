import { useCallback, useEffect, useState } from 'react';
import { openExternal } from '../lib/openExternal';
import { toast } from '../kit/toast';
import { CALL_WORDS, bridgeErrorText, callChoice, saveNumberTip, type CallConfig, type CallTarget } from '../lib/callBridge';

// [O-1] One answer per app run for a few minutes: the switch changes rarely, and a failed read means
// "behave as today" (dial the number the server sent, if any) — never a dead Call button.
const CONFIG_TTL_MS = 5 * 60_000;
let cached: { at: number; value: CallConfig | null } | null = null;
let inflight: Promise<CallConfig | null> | null = null;
/** Loaded on first use, like the notification router does: screens that show a Call button do not pull the API client in at import. */
const calls = async () => (await import('../services/api')).callsApi;

export async function loadCallConfig(now = Date.now()): Promise<CallConfig | null> {
  if (cached && now - cached.at < CONFIG_TTL_MS) return cached.value;
  inflight ??= calls().then((api) => api.config())
    .then((res) => { const d = res.data?.data; return d && typeof d.enabled === 'boolean' ? { enabled: d.enabled, callerId: d.callerId ?? null } : null; })
    .catch(() => null)
    .then((value) => { cached = { at: Date.now(), value }; inflight = null; return value; });
  return inflight;
}

/** Tests only. */
export function resetCallConfigForTests(): void { cached = null; inflight = null; }

export function useCallConfig(): CallConfig | null {
  const [config, setConfig] = useState<CallConfig | null>(cached?.value ?? null);
  useEffect(() => {
    let live = true;
    void loadCallConfig().then((c) => { if (live) setConfig(c); });
    return () => { live = false; };
  }, []);
  return config;
}

/**
 * The Call control for one person on one order. Each screen keeps its own look: it shows the control
 * when `visible`, labels it with `label`, and calls `onPress`.
 */
export function useCallParty(input: { orderId?: string | null; target: CallTarget; phone?: string | null; dialFailText: string }) {
  const config = useCallConfig();
  const choice = callChoice(config, input.phone, input.orderId);
  const [busy, setBusy] = useState(false);
  const { orderId, target, dialFailText } = input;
  const onPress = useCallback(async () => {
    if (choice.mode === 'dial') { await openExternal(`tel:${choice.phone}`, dialFailText); return; }
    if (choice.mode !== 'bridge' || !orderId || busy) return;
    setBusy(true);
    try {
      await (await calls()).bridge(orderId, target);
      toast.success(CALL_WORDS.started, [CALL_WORDS.startedHow, saveNumberTip(config?.callerId)].filter(Boolean).join(' '));
    } catch (e) {
      const code = (e as { response?: { data?: { error?: { code?: string } } } })?.response?.data?.error?.code;
      toast.error(CALL_WORDS.failedTitle, bridgeErrorText(code));
    } finally {
      setBusy(false);
    }
  }, [choice, orderId, target, dialFailText, busy, config?.callerId]);
  return {
    visible: choice.mode !== 'none',
    viaSwift: choice.mode === 'bridge',
    label: choice.mode === 'bridge' ? CALL_WORDS.viaSwift : 'Call',
    hint: choice.mode === 'bridge' ? 'Swift rings your phone first, then connects you' : 'Opens the phone dialer',
    busy,
    onPress: () => { void onPress(); },
  };
}
