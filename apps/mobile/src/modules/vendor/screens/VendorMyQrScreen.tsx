/** @jsxImportSource react */
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, Share, View, useWindowDimensions } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { SvgXml } from 'react-native-svg';
import { Card, Chip, ErrorState, LinkText, LoadingBlock, PillButton, PopupCard, Screen, SettingsRow, T, TonePill } from '../../../kit';
import { useDeactivateQr, useRegenerateQr, useVendorQr, useVendorQrAnalytics, type QrAnalytics } from '../../../hooks/vendorops';
import { GUTTER, SubHeader } from '../shared';

// ---------------------------------------------------------------------------
// My Swift QR — the vendor's acquisition artifact (qr spec Part 5, copy Part
// 14). Hero = the LIVE code (never a static image); tap for a full-screen
// white display so a customer can scan straight off the vendor's phone — the
// zero-print day-one path. Performance numbers are server truth (reconciled
// to rows by a merge-gated test). Download/print-pack buttons arrive WITH the
// asset endpoints — nothing dead ships.
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

function HowItWorks() {
  return (
    <Card style={{ marginBottom: space.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      {STEPS.map((step, i) => (
        <React.Fragment key={step.label}>
          {i > 0 ? <Feather name="chevron-right" size={16} color={color.text.muted} /> : null}
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

/** Scans → Store views → Orders, as one thin proportional bar. */
function FunnelBar({ analytics }: { analytics: QrAnalytics }) {
  const scans = analytics.totals.scans;
  const views = analytics.totals.storeViews;
  const orders = analytics.totals.webOrders;
  if (scans === 0) return null;
  const seg = (n: number) => Math.max(4, Math.round((n / scans) * 100));
  return (
    <View style={{ marginTop: space.lg }}>
      <T variant="caption" tone="muted">
        Scans → Store views → Orders
      </T>
      <View style={{ flexDirection: 'row', height: 6, borderRadius: radius.full, overflow: 'hidden', marginTop: space.xs, backgroundColor: color.surface.sunken }}>
        <View style={{ width: `${seg(scans)}%`, backgroundColor: color.brand[500], opacity: 0.35 }} />
        <View style={{ width: `${seg(views)}%`, backgroundColor: color.brand[500], opacity: 0.65 }} />
        <View style={{ width: `${seg(orders)}%`, backgroundColor: color.brand[500] }} />
      </View>
    </View>
  );
}

export function VendorMyQrScreen({ navigation }: any) {
  const { width } = useWindowDimensions();
  const qrQ = useVendorQr();
  const [range, setRange] = useState<QrAnalytics['range']>('30d');
  const analyticsQ = useVendorQrAnalytics(range);
  const regenerate = useRegenerateQr();
  const deactivate = useDeactivateQr();
  const [fullScreen, setFullScreen] = useState(false);
  const [confirming, setConfirming] = useState<null | 'regenerate' | 'deactivate'>(null);

  if (qrQ.isLoading) {
    return (
      <Screen>
        <SubHeader title="My Swift QR" navigation={navigation} />
        <LoadingBlock />
      </Screen>
    );
  }
  const qr = qrQ.data;
  if (!qr) {
    return (
      <Screen>
        <SubHeader title="My Swift QR" navigation={navigation} />
        <ErrorState onRetry={() => qrQ.refetch()} />
      </Screen>
    );
  }

  const analytics = analyticsQ.data ?? null;
  const hasScans = (analytics?.totals.scans ?? 0) > 0;
  const qrSize = Math.min(width - GUTTER * 2 - space['2xl'] * 2, 264);

  const shareLink = () => {
    void Share.share({ message: `Order from ${qr.vendorName} on Swift: ${qr.shortUrl}` });
  };

  return (
    <Screen>
      <SubHeader title="My Swift QR" navigation={navigation} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {/* Hero — the live code. Tap = full-screen display for over-the-counter scans. */}
        <Card style={{ alignItems: 'center', marginBottom: space.lg }}>
          <Pressable onPress={() => setFullScreen(true)} accessibilityRole="button" accessibilityLabel="Show QR code full screen">
            {({ pressed }) => (
              <View
                style={{
                  padding: space.lg,
                  borderRadius: radius.lg,
                  backgroundColor: color.white,
                  opacity: pressed ? 0.85 : 1,
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
          <T variant="caption" tone="muted" center style={{ marginTop: 2 }}>
            Customers scan this to order from you
          </T>
          <T variant="caption" tone="brand" center style={{ marginTop: space.xs }}>
            Tap the code to show it full screen
          </T>
        </Card>

        <PillButton label="Share link" icon="share-2" onPress={shareLink} style={{ marginBottom: space.lg }} />

        <HowItWorks />

        {/* Performance — server truth only. */}
        <Card style={{ marginBottom: space.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md }}>
            <T variant="body" weight="semibold">
              Performance
            </T>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              {RANGES.map((r) => (
                <Chip key={r.value} label={r.label} selected={range === r.value} onPress={() => setRange(r.value)} />
              ))}
            </View>
          </View>
          {analyticsQ.isLoading ? (
            <LoadingBlock style={{ flex: 0, padding: space.lg }} />
          ) : !hasScans ? (
            <T variant="caption" tone="muted">
              Print your code and put it where customers look — scans show up here.
            </T>
          ) : (
            <>
              <View style={{ flexDirection: 'row' }}>
                <Stat label="Scans" value={analytics!.totals.scans} />
                <Stat label="Orders from QR" value={analytics!.totals.webOrders} />
                <Stat label="App installs" value={analytics!.totals.installsAttributed} />
              </View>
              <FunnelBar analytics={analytics!} />
            </>
          )}
        </Card>

        {/* Manage */}
        <Card style={{ marginBottom: space.lg, paddingVertical: space.sm }}>
          <SettingsRow icon="refresh-cw" label="Replace your QR code" sub={`Old code keeps working ${qr.graceDays} days`} onPress={() => setConfirming('regenerate')} />
          <SettingsRow icon="slash" label="Turn off this QR code" sub="Stops working immediately" tone="error" onPress={() => setConfirming('deactivate')} />
        </Card>

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
          <SvgXml xml={qr.svg} width={width * 0.86} height={width * 0.86} />
          <T variant="body" weight="bold" style={{ marginTop: space.xl }}>
            {qr.vendorName}
          </T>
          <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
            Scan to order · tap anywhere to close
          </T>
        </Pressable>
      </Modal>

      {/* Regenerate confirm (Part 14 copy, grace from config) */}
      <PopupCard visible={confirming === 'regenerate'} onClose={() => setConfirming(null)}>
        <T variant="body" weight="bold" center>
          Replace your QR code?
        </T>
        <T variant="caption" tone="muted" center style={{ marginTop: space.sm, marginBottom: space.lg }}>
          Your current code keeps working for {qr.graceDays} more days so printed materials don't break. New downloads use the new code.
        </T>
        <PillButton
          label="Replace code"
          loading={regenerate.isPending}
          onPress={() => regenerate.mutate(undefined, { onSettled: () => setConfirming(null) })}
          style={{ alignSelf: 'stretch', marginBottom: space.md }}
        />
        <LinkText label="Cancel" tone="muted" onPress={() => setConfirming(null)} />
      </PopupCard>

      {/* Deactivate confirm (destructive) */}
      <PopupCard visible={confirming === 'deactivate'} onClose={() => setConfirming(null)}>
        <T variant="body" weight="bold" center>
          Turn off this QR code?
        </T>
        <T variant="caption" tone="muted" center style={{ marginTop: space.sm, marginBottom: space.lg }}>
          It stops working immediately. Anything printed with it will show a retired notice.
        </T>
        <PillButton
          label="Turn off"
          variant="destructive"
          loading={deactivate.isPending}
          onPress={() => deactivate.mutate(undefined, { onSettled: () => setConfirming(null) })}
          style={{ alignSelf: 'stretch', marginBottom: space.md }}
        />
        <LinkText label="Cancel" tone="muted" onPress={() => setConfirming(null)} />
      </PopupCard>
    </Screen>
  );
}
