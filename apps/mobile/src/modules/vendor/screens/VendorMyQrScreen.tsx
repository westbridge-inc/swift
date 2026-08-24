/** @jsxImportSource react */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Modal, Pressable, ScrollView, Share, View, useWindowDimensions } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { SvgXml } from 'react-native-svg';
import { Card, Chip, ErrorState, LoadingBlock, PillButton, PopupCard, PopupTitle, Screen, SettingsRow, T, TonePill } from '../../../kit';
import { useVendorProfile, type QrAnalytics, type VendorQrPayload } from '../../../hooks/vendorops';
import { GUTTER, SubHeader } from '../shared';
import { toast } from '../../../components/ui/toast';
import { copyText } from '../../../lib/clipboard';
import { api } from '../../../services/api';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';

// ---------------------------------------------------------------------------
// My Swift QR — the vendor's acquisition artifact (qr spec Part 5, copy Part
// 14). Hero = the LIVE code (never a static image); tap for a full-screen
// white display so a customer can scan straight off the vendor's phone — the
// zero-print day-one path. Performance numbers are server truth (reconciled
// to rows by a merge-gated test). The server has print assets, but the mobile
// client has no authenticated file/share transport in this lane, so the screen
// names that limitation rather than shipping a dead download button.
// ---------------------------------------------------------------------------

const RANGES: { label: string; value: QrAnalytics['range'] }[] = [
  { label: '7 days', value: '7d' },
  { label: '30 days', value: '30d' },
  { label: '90 days', value: '90d' },
];

/** Placement tips — exactly these six, shop-owner voice (Part 14). */
const TIPS = [
  'On the counter by the till',
  'On your front door or window',
  'Inside every delivery bag',
  'On your WhatsApp status each week',
  'Pinned to your Facebook page',
  'On your menu or price list',
];

const STEPS: { icon: React.ComponentProps<typeof Feather>['name']; label: string }[] = [
  { icon: 'maximize', label: 'Customer scans' },
  { icon: 'shopping-bag', label: 'Your store opens' },
  { icon: 'check-circle', label: 'They order' },
];

function HowItWorks({ compact }: { compact: boolean }) {
  return (
    <Card style={{ marginBottom: space.lg, flexDirection: compact ? 'column' : 'row', alignItems: 'center', justifyContent: 'space-between', gap: compact ? space.md : 0 }}>
      {STEPS.map((step, i) => (
        <React.Fragment key={step.label}>
          {i > 0 ? <Feather name={compact ? 'chevron-down' : 'chevron-right'} size={16} color={color.text.muted} /> : null}
          <View style={{ alignItems: 'center', flex: 1 }}>
            <Feather name={step.icon} size={18} color={color.brand[500]} />
            <T variant="caption" tone="muted" center style={{ marginTop: space.xs }}>
              {step.label}
            </T>
          </View>
        </React.Fragment>
      ))}
    </Card>
  );
}

function Stat({ label, value, approx }: { label: string; value: number; approx?: boolean }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <T variant="title" weight="bold">
        {value}
      </T>
      <T variant="caption" tone="muted" center>
        {label}
        {approx ? ' (approx.)' : ''}
      </T>
    </View>
  );
}

export function VendorMyQrScreen({ navigation }: any) {
  const { width, height, fontScale } = useWindowDimensions();
  const profile = useVendorProfile();
  const selectedStoreId = useStoreSwitcher((state) => state.selectedStoreId);
  const currentStoreId = profile.store?.id ?? selectedStoreId;
  const [range, setRange] = useState<QrAnalytics['range']>('30d');
  const [fullScreen, setFullScreen] = useState(false);
  const [confirming, setConfirming] = useState<null | 'regenerate' | 'deactivate'>(null);
  const [qr, setQr] = useState<VendorQrPayload | null>(null);
  const [qrStoreId, setQrStoreId] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(true);
  const [qrError, setQrError] = useState(false);
  const [publicState, setPublicState] = useState<'checking' | 'live' | 'unavailable' | 'error'>('checking');
  const [analytics, setAnalytics] = useState<QrAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState(false);
  const [lifecyclePending, setLifecyclePending] = useState<null | 'regenerate' | 'deactivate'>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const qrRequest = useRef(0);
  const analyticsRequest = useRef(0);
  const currentStoreRef = useRef<string | null>(currentStoreId ?? null);
  currentStoreRef.current = currentStoreId ?? null;

  // The shared vendor QR queries pre-date multi-store switching and are not
  // keyed by store. Bind reads here to the exact selected store, then confirm
  // the short code against the public resolver before calling it orderable.
  const loadQr = useCallback(async (
    storeId: string,
    options?: { previousCode?: string; successMessage?: string; background?: boolean },
  ) => {
    const request = ++qrRequest.current;
    if (!options?.background) {
      setQr(null);
      setQrStoreId(null);
      setQrLoading(true);
    }
    setQrError(false);
    setPublicState('checking');
    try {
      const response = await api.get('/vendor/qr', { headers: { 'x-vendor-id': storeId } });
      const fresh = response.data?.data as VendorQrPayload | undefined;
      if (!fresh?.shortCode || !fresh.shortUrl || !fresh.svg) throw new Error('Incomplete QR response');
      if (options?.previousCode && fresh.shortCode === options.previousCode) throw new Error('QR did not rotate');
      if (request !== qrRequest.current || currentStoreRef.current !== storeId) return;
      setQr(fresh);
      setQrStoreId(storeId);
      setQrLoading(false);

      try {
        const publicResponse = await api.get(`/public/qr/${encodeURIComponent(fresh.shortCode)}`);
        const publicResult = publicResponse.data?.data as { verdict?: string; vendorId?: string | null } | undefined;
        if (request !== qrRequest.current || currentStoreRef.current !== storeId) return;
        const publiclyLive = publicResult?.verdict === 'WEB_RENDER' && publicResult.vendorId === storeId;
        setPublicState(publiclyLive ? 'live' : 'unavailable');
        if (!publiclyLive) setFullScreen(false);
        if (options?.successMessage) {
          toast.show(publiclyLive ? options.successMessage : 'QR updated, but this store link is not live yet.');
        }
      } catch {
        if (request === qrRequest.current && currentStoreRef.current === storeId) {
          setPublicState('error');
          setFullScreen(false);
        }
      }
    } catch {
      if (request !== qrRequest.current || currentStoreRef.current !== storeId) return;
      if (!options?.background) {
        setQr(null);
        setQrStoreId(null);
      }
      setQrLoading(false);
      setQrError(true);
      setPublicState('error');
      setFullScreen(false);
    }
  }, []);

  const loadAnalytics = useCallback(async (storeId: string, selectedRange: QrAnalytics['range']) => {
    const request = ++analyticsRequest.current;
    setAnalytics(null);
    setAnalyticsLoading(true);
    setAnalyticsError(false);
    try {
      const response = await api.get(`/vendor/qr/analytics?range=${selectedRange}`, { headers: { 'x-vendor-id': storeId } });
      const fresh = response.data?.data as QrAnalytics | undefined;
      if (!fresh?.totals || request !== analyticsRequest.current || currentStoreRef.current !== storeId) return;
      setAnalytics(fresh);
      setAnalyticsLoading(false);
    } catch {
      if (request !== analyticsRequest.current || currentStoreRef.current !== storeId) return;
      setAnalytics(null);
      setAnalyticsLoading(false);
      setAnalyticsError(true);
    }
  }, []);

  useEffect(() => {
    setConfirming(null);
    setFullScreen(false);
    if (!currentStoreId) {
      setQr(null);
      setQrStoreId(null);
      setQrLoading(profile.isLoading);
      setQrError(!profile.isLoading);
      return;
    }
    void loadQr(currentStoreId);
  }, [currentStoreId, loadQr, profile.isLoading]);

  useEffect(() => {
    if (!currentStoreId || !qr || qrStoreId !== currentStoreId) return;
    const refresh = () => void loadQr(currentStoreId, { background: true });
    const timer = setInterval(refresh, 60_000);
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      clearInterval(timer);
      appState.remove();
    };
  }, [currentStoreId, loadQr, qr, qrStoreId]);

  useEffect(() => {
    if (!currentStoreId) {
      setAnalytics(null);
      setAnalyticsLoading(false);
      return;
    }
    void loadAnalytics(currentStoreId, range);
  }, [currentStoreId, loadAnalytics, range]);

  const qrMatchesCurrentStore = Boolean(qr && currentStoreId && qrStoreId === currentStoreId);
  if (qrLoading || (qr && !qrMatchesCurrentStore)) {
    return (
      <Screen>
        <SubHeader title="My QR & number" navigation={navigation} />
        <LoadingBlock />
      </Screen>
    );
  }
  if (!qr || !qrMatchesCurrentStore) {
    return (
      <Screen>
        <SubHeader title="My QR & number" navigation={navigation} />
        <ErrorState
          message={qrError ? "We couldn't load this store's QR code. Check your connection and try again." : undefined}
          onRetry={() => { if (currentStoreId) void loadQr(currentStoreId); }}
        />
      </Screen>
    );
  }

  const hasScans = (analytics?.totals.scans ?? 0) > 0;
  const compact = width < space['5xl'] * 9 || fontScale > 1.2;
  const qrSize = Math.min(width - GUTTER * 2 - space['2xl'] * 2, space['5xl'] * 5 + space['2xl']);
  const fullscreenQrSize = Math.max(space['5xl'] * 2, Math.min(width, height) - space['5xl'] * 2 - space.xl);
  const canManageQr = !profile.isLoading && Boolean(profile.owner) && profile.myRole === 'OWNER';
  const isPubliclyLive = publicState === 'live';

  const shareLink = () => {
    if (!isPubliclyLive) {
      toast.show(publicState === 'error' ? "Swift couldn't confirm this store link yet." : 'This store link is not live yet.');
      return;
    }
    void Share.share({ message: `Order from ${qr.vendorName} on Swift: ${qr.shortUrl}` }).catch(() => toast.show("Couldn't open the share sheet."));
  };

  const copyLink = () => {
    if (!isPubliclyLive) {
      toast.show(publicState === 'error' ? "Swift couldn't confirm this store link yet." : 'This store link is not live yet.');
      return;
    }
    if (copyText(qr.shortUrl)) toast.show('Store link copied.');
    else toast.show("Couldn't copy the link. Use Share link instead.");
  };

  const openStore = () => {
    if (!isPubliclyLive) {
      toast.show(publicState === 'error' ? "Swift couldn't confirm this store link yet." : 'This store link is not live yet.');
      return;
    }
    void Linking.openURL(qr.canonicalUrl).catch(() => toast.show("Couldn't open the web store."));
  };

  const refreshAfterLifecycleChange = (storeId: string, previousCode: string, message: string) => {
    setQr(null);
    setQrLoading(true);
    setPublicState('checking');
    void loadQr(storeId, { previousCode, successMessage: message });
    void loadAnalytics(storeId, range);
  };

  const runLifecycleAction = async (action: 'regenerate' | 'deactivate') => {
    if (lifecyclePending || !currentStoreId || qrStoreId !== currentStoreId) return;
    const storeId = currentStoreId;
    const previousCode = qr.shortCode;
    setLifecyclePending(action);
    setLifecycleError(null);
    try {
      const currentResponse = await api.get('/vendor/qr', { headers: { 'x-vendor-id': storeId } });
      const currentQr = currentResponse.data?.data as VendorQrPayload | undefined;
      if (!currentQr?.shortCode || currentQr.shortCode !== previousCode) {
        if (currentStoreRef.current === storeId) {
          setConfirming(null);
          toast.show('This store already has a newer QR code. Swift refreshed it; review before changing it.');
          void loadQr(storeId);
        }
        return;
      }
      if (action === 'regenerate') {
        await api.post('/vendor/qr/regenerate', {}, { headers: { 'x-vendor-id': storeId } });
      } else {
        await api.post('/vendor/qr/deactivate', { confirm: true }, { headers: { 'x-vendor-id': storeId } });
      }
      if (currentStoreRef.current !== storeId) return;
      setConfirming(null);
      refreshAfterLifecycleChange(
        storeId,
        previousCode,
        action === 'regenerate'
          ? 'New QR code ready. Your old code stays in its grace period.'
          : 'Old QR code disabled. A new store code is ready.',
      );
    } catch (lifecycleFailure) {
      if (currentStoreRef.current === storeId) {
        setLifecycleError(lifecycleFailure instanceof Error ? lifecycleFailure.message : 'Swift could not update this QR code.');
      }
    } finally {
      setLifecyclePending(null);
    }
  };

  return (
    <Screen>
      <SubHeader title="My QR & number" navigation={navigation} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {/* Hero — the live code. Tap = full-screen display for over-the-counter scans. */}
        <Card style={{ alignItems: 'center', marginBottom: space.lg }}>
          <Pressable
            onPress={() => setFullScreen(true)}
            disabled={!isPubliclyLive}
            accessibilityRole="button"
            accessibilityLabel="Show QR code full screen"
            accessibilityState={{ disabled: !isPubliclyLive }}
          >
            {({ pressed }) => (
              <View
                style={{
                  padding: space.lg,
                  borderRadius: radius.lg,
                  backgroundColor: color.white,
                  opacity: !isPubliclyLive ? 0.55 : pressed ? 0.85 : 1,
                }}
              >
                <SvgXml xml={qr.svg} width={qrSize} height={qrSize} />
              </View>
            )}
          </Pressable>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md }}>
            <T variant="body" weight="bold">
              {qr.vendorName}
            </T>
            <TonePill label={`v${qr.version}`} tone="neutral" />
          </View>
          <T variant="caption" tone={isPubliclyLive ? 'muted' : 'warning'} center style={{ marginTop: space.xs }}>
            {publicState === 'live'
              ? 'Customers scan this to open your live web menu — no app install'
              : publicState === 'checking'
                ? 'Checking whether this store link is live…'
                : publicState === 'unavailable'
                  ? 'This code is not taking customers to a live store yet.'
                  : "Swift couldn't confirm that this store link is live."}
          </T>
          <T variant="caption" tone={isPubliclyLive ? 'brand' : 'muted'} center style={{ marginTop: space.xs }}>
            {isPubliclyLive ? 'Tap the code to show it full screen' : 'Full-screen counter display unlocks when the link is live'}
          </T>
          <Pressable
            onPress={copyLink}
            disabled={!isPubliclyLive}
            accessibilityRole="button"
            accessibilityLabel="Copy web store link"
            accessibilityHint="Copies the short link customers can use to order"
            style={({ pressed }) => ({
              minHeight: space['4xl'] + space.xs,
              marginTop: space.md,
              paddingHorizontal: space.lg,
              borderRadius: radius.full,
              backgroundColor: color.surface.sunken,
              alignItems: 'center',
              justifyContent: 'center',
                  opacity: !isPubliclyLive ? 0.55 : pressed ? 0.85 : 1,
            })}
          >
            <T variant="label" tone="brand" weight="semibold" center>
              {qr.shortUrl}
            </T>
          </Pressable>
        </Card>

        <View style={{ flexDirection: compact ? 'column' : 'row', gap: space.sm, marginBottom: space.lg }}>
          <PillButton label="Share link" icon="share-2" disabled={!isPubliclyLive} onPress={shareLink} style={{ flex: 1 }} />
          <PillButton label="Open web menu" icon="external-link" variant="outline" disabled={!isPubliclyLive} onPress={openStore} style={{ flex: 1 }} />
        </View>

        {isPubliclyLive ? (
          <HowItWorks compact={compact} />
        ) : (
          <Card style={{ marginBottom: space.lg }}>
            <T variant="body" weight="semibold">Store link not ready</T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              Swift only enables sharing after the public resolver confirms this exact store. Check your store approval and availability, then retry.
            </T>
            <PillButton label="Check again" variant="outline" onPress={() => { if (currentStoreId) void loadQr(currentStoreId); }} style={{ alignSelf: 'stretch', marginTop: space.md }} />
          </Card>
        )}

        <Card style={{ marginBottom: space.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.md, marginBottom: space.sm }}>
            <Feather name="printer" size={18} color={color.text.secondary} />
            <T variant="body" weight="semibold" style={{ flex: 1 }}>
              Print counter card
            </T>
            <TonePill label="Unavailable" tone="neutral" />
          </View>
          <T variant="caption" tone="muted">
            The print-ready card exists on Swift's server, but this app build cannot securely download the authenticated file yet. Share the live link or show the code full screen for now.
          </T>
        </Card>

        <Card style={{ marginBottom: space.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.md, marginBottom: space.sm }}>
            <Feather name="phone-off" size={18} color={color.text.secondary} />
            <T variant="body" weight="semibold" style={{ flex: 1 }}>
              Your Swift call-in number
            </T>
            <TonePill label="Not assigned" tone="neutral" />
          </View>
          <T variant="caption" tone="muted">
            Swift does not yet issue a call-in order number for this store. Your subscription Swift Number pays weekly fees and is not a phone line. Online orders still land in Orders with every other live order.
          </T>
        </Card>

        {/* Performance — server truth only. */}
        <Card style={{ marginBottom: space.lg }}>
          <View style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', justifyContent: 'space-between', gap: space.sm, marginBottom: space.md }}>
            <T variant="body" weight="semibold">
              Performance
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {RANGES.map((r) => (
                <Chip key={r.value} label={r.label} selected={range === r.value} onPress={() => setRange(r.value)} />
              ))}
            </View>
          </View>
          {analyticsLoading ? (
            <LoadingBlock style={{ flex: 0, padding: space.lg }} />
          ) : analyticsError ? (
            <ErrorState
              message="We couldn't load QR performance. Check your connection and try again."
              onRetry={() => { if (currentStoreId) void loadAnalytics(currentStoreId, range); }}
              style={{ padding: space.lg }}
            />
          ) : !hasScans ? (
            <T variant="caption" tone="muted">
              Share your store link or show this code where customers look — scans show up here.
            </T>
          ) : (
            <View style={{ flexDirection: compact ? 'column' : 'row', gap: compact ? space.md : 0 }}>
              <Stat label="Scans" value={analytics!.totals.scans} />
              <Stat label="Unique scanners" value={analytics!.totals.approxUniqueScanners} approx />
              <Stat label="App installs" value={analytics!.totals.installsAttributed} />
            </View>
          )}
        </Card>

        {/* QR lifecycle writes are owner-only on the API. */}
        {profile.isLoading ? (
          <LoadingBlock style={{ flex: 0, padding: space.lg, marginBottom: space.lg }} />
        ) : !profile.owner ? (
          <Card style={{ marginBottom: space.lg }}>
            <T variant="body" weight="semibold">QR code controls unavailable</T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              Swift couldn't verify your store role. These controls stay locked and retry automatically.
            </T>
          </Card>
        ) : canManageQr ? (
          <Card style={{ marginBottom: space.lg, paddingVertical: space.sm }}>
            <SettingsRow icon="refresh-cw" label="Replace your QR code" sub={`Old code keeps working ${qr.graceDays} days`} onPress={() => { setLifecycleError(null); setConfirming('regenerate'); }} />
            <SettingsRow icon="slash" label="Turn off this QR code" sub="Stops working immediately" tone="error" onPress={() => { setLifecycleError(null); setConfirming('deactivate'); }} />
          </Card>
        ) : (
          <Card style={{ marginBottom: space.lg }}>
            <T variant="body" weight="semibold">QR code controls</T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              Only the store owner can replace or turn off this QR code.
            </T>
          </Card>
        )}

        {/* Placement tips */}
        <Card>
          <T variant="body" weight="semibold" style={{ marginBottom: space.md }}>
            Where to place your QR
          </T>
          {TIPS.map((tip) => (
            <View key={tip} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.sm }}>
              <Feather name="check" size={14} color={color.brand[500]} />
              <T variant="caption" tone="muted">
                {tip}
              </T>
            </View>
          ))}
        </Card>
      </ScrollView>

      {/* Full-screen display: white surround, huge code — scannable off-screen. */}
      <Modal visible={fullScreen} animationType="fade" onRequestClose={() => setFullScreen(false)}>
        <Pressable
          onPress={() => setFullScreen(false)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss full screen QR"
          style={{ flex: 1, backgroundColor: color.white, alignItems: 'center', justifyContent: 'center' }}
        >
          <SvgXml xml={qr.svg} width={fullscreenQrSize} height={fullscreenQrSize} />
          <T variant="body" weight="bold" style={{ marginTop: space.xl }}>
            {qr.vendorName}
          </T>
          <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
            Scan to order · tap anywhere to close
          </T>
        </Pressable>
      </Modal>

      {/* Regenerate confirm (Part 14 copy, grace from config) */}
      <PopupCard visible={confirming === 'regenerate'} onClose={() => { if (!lifecyclePending) setConfirming(null); }}>
        <PopupTitle variant="body" weight="bold" center>
          Replace your QR code?
        </PopupTitle>
        <T variant="caption" tone="muted" center style={{ marginTop: space.sm, marginBottom: space.lg }}>
          Your current code keeps working for {qr.graceDays} more days so printed materials don't break. New downloads use the new code.
        </T>
        <PillButton
          label="Replace code"
          loading={lifecyclePending === 'regenerate'}
          disabled={lifecyclePending !== null}
          onPress={() => void runLifecycleAction('regenerate')}
          style={{ alignSelf: 'stretch', marginBottom: space.md }}
        />
        {lifecycleError ? (
          <T variant="caption" tone="error" center accessibilityLiveRegion="assertive" style={{ marginBottom: space.md }}>
            {lifecycleError}
          </T>
        ) : null}
        <PillButton label="Cancel" variant="outline" disabled={lifecyclePending !== null} onPress={() => setConfirming(null)} style={{ alignSelf: 'stretch' }} />
      </PopupCard>

      {/* Deactivate confirm (destructive) */}
      <PopupCard visible={confirming === 'deactivate'} onClose={() => { if (!lifecyclePending) setConfirming(null); }}>
        <PopupTitle variant="body" weight="bold" center>
          Turn off this QR code?
        </PopupTitle>
        <T variant="caption" tone="muted" center style={{ marginTop: space.sm, marginBottom: space.lg }}>
          It stops working immediately. Anything printed with it will show a retired notice.
        </T>
        <PillButton
          label="Turn off"
          variant="destructive"
          loading={lifecyclePending === 'deactivate'}
          disabled={lifecyclePending !== null}
          onPress={() => void runLifecycleAction('deactivate')}
          style={{ alignSelf: 'stretch', marginBottom: space.md }}
        />
        {lifecycleError ? (
          <T variant="caption" tone="error" center accessibilityLiveRegion="assertive" style={{ marginBottom: space.md }}>
            {lifecycleError}
          </T>
        ) : null}
        <PillButton label="Cancel" variant="outline" disabled={lifecyclePending !== null} onPress={() => setConfirming(null)} style={{ alignSelf: 'stretch' }} />
      </PopupCard>
    </Screen>
  );
}
