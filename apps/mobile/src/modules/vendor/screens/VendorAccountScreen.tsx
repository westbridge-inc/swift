/** @jsxImportSource react */
import { useState, useEffect } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Image } from 'expo-image';
import { color, radius, space } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { SvgXml } from 'react-native-svg';
import {
  Card,
  Chip,
  IconChip,
  LoadingBlock,
  PillButton,
  PopupCard,
  PopupTitle,
  Screen,
  SettingsRow,
  T,
  TonePill,
} from '../../../kit';
import { BrandSwitch } from '../../../kit/controls';
import { DAY_LABELS, GUTTER, InlineInput, fmtDate, prettyVendorType } from '../shared';
import { DocumentChecklist } from '../../../components/onboarding/DocumentChecklist';
import { MmgPayLinkCard } from '../../../components/MmgPayLinkCard';
import { PublicCallNumberCard } from '../../../components/PublicCallNumberCard';
import { vendorApi } from '../../../services/api';
import { useVerificationStatus } from '../../../hooks/verification';
import {
  useVendorProfile,
  useVendorQr,
  useVendorStaff,
  useAddStaff,
  useRemoveStaff,
  useUpdateStaffRole,
  useVendorPromos,
  useCreatePromo,
  useUpdatePromo,
  useDeletePromo,
  useVendorSubscription,
  useVendorHours,
  useSetHours,
  type DayHours,
} from '../../../hooks/vendorops';
import { RoleSwitcherSheet } from '../../../components/RoleSwitcherSheet';
import { money } from '../../../lib/money';
import { mediaUrl } from '../../../lib/images';
import { safeVendorRole, TabHeader, VendorBillingNotice } from '../shared';

export function VendorAccountScreen() {
  const navigation = useNavigation<any>();
  const { owner, store } = useVendorProfile();
  const myRole = safeVendorRole(owner?.myRole);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const isOwner = myRole === 'OWNER';
  const isManager = myRole === 'OWNER' || myRole === 'MANAGER';
  const sub = useVendorSubscription(isOwner);
  const hoursQ = useVendorHours();
  const setHours = useSetHours();
  const qc = useQueryClient();
  const saveMmgLink = useMutation({
    mutationFn: (mmgPayUrl: string | null) => vendorApi.updateProfile({ mmgPayUrl }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] }),
  });
  // The server owns what a publishable number is (a complete +592 subscriber
  // line), so a rejection is surfaced in ITS words rather than re-guessed here —
  // two opinions about a valid number is how a shopkeeper gets told their own
  // shop number is wrong for a reason that is not true.
  const [callNumberError, setCallNumberError] = useState<string | null>(null);
  const saveCallNumber = useMutation({
    mutationFn: (publicPhone: string | null) => vendorApi.updateProfile({ publicPhone }),
    onMutate: () => setCallNumberError(null),
    onSuccess: () => {
      setCallNumberError(null);
      void qc.invalidateQueries({ queryKey: ['vendor', 'profile'] });
    },
    onError: (e: any) => setCallNumberError(
      e?.response?.data?.error?.message ?? 'That number could not be saved. Check it and try again.',
    ),
  });

  const [days, setDays] = useState<DayHours[]>([]);
  useEffect(() => {
    // [WR-007] Seed the editor ONLY from a successful read. A failed fetch
    // used to fabricate seven 08:00–22:00 days here — and Save would then
    // delete/recreate the store's REAL schedule from the fabrication. The
    // default seed is legitimate only for a first-run vendor with no rows.
    if (!hoursQ.isSuccess) return;
    const byDay = new Map<number, DayHours>();
    for (const h of hoursQ.data ?? []) {
      if (!byDay.has(h.dayOfWeek)) {
        byDay.set(h.dayOfWeek, {
          dayOfWeek: h.dayOfWeek,
          openTime: h.openTime || '08:00',
          closeTime: h.closeTime || '22:00',
          isClosed: !!h.isClosed,
        });
      }
    }
    setDays(Array.from({ length: 7 }, (_, d) => byDay.get(d) ?? { dayOfWeek: d, openTime: '08:00', closeTime: '22:00', isClosed: false }));
  }, [hoursQ.isSuccess, hoursQ.data]);

  const setDay = (d: number, patch: Partial<DayHours>) =>
    setDays((prev) => prev.map((x) => (x.dayOfWeek === d ? { ...x, ...patch } : x)));

  return (
    <Screen>
      <TabHeader title="Account" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {/* Store identity */}
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.lg }}>
          <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[50] }}>
            <MaterialCommunityIcons name="storefront" size={26} color={color.brand[600]} />
          </View>
          <View style={{ flex: 1 }}>
            <T variant="heading" numberOfLines={1}>
              {store?.name ?? 'Your store'}
            </T>
            <T variant="label" tone="muted" numberOfLines={1} style={{ marginTop: 2 }}>
              {prettyVendorType(store?.vendorType)}
              {store?.city ? ` · ${store.city}` : ''}
            </T>
          </View>
        </Card>

        <Card style={{ marginBottom: space.lg, paddingVertical: space.sm }}>
          <SettingsRow icon="life-buoy" label="Get help" sub="A human answers — orders, billing, account" onPress={() => navigation.navigate('GetHelp')} />
          <SettingsRow icon="refresh-cw" label="Switch app" sub="Swift · Swift Driver" onPress={() => setSwitcherOpen(true)} />
        </Card>

        {isOwner ? <SubscriptionCard sub={sub.data} phone={store?.phone} /> : null}

        {isManager ? (
          <MmgPayLinkCard
            who="store"
            value={store?.mmgPayUrl}
            saving={saveMmgLink.isPending}
            onSave={(u) => saveMmgLink.mutate(u)}
          />
        ) : null}

        {isManager ? (
          <PublicCallNumberCard
            value={store?.publicPhone}
            saving={saveCallNumber.isPending}
            error={callNumberError}
            onSave={(p) => saveCallNumber.mutate(p)}
          />
        ) : null}

        {isOwner && store?.vendorType ? <VendorDocumentsSection vendorType={store.vendorType} /> : null}

        {isManager ? <StoreQrCard /> : null}

        {isManager ? <PromosSection /> : null}

        {isOwner ? <StaffSection /> : null}

        {!isManager ? (
          <Card style={{ marginBottom: space.lg }}>
            <T variant="label" weight="semibold">
              Staff account
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
              You work the order queue and can mark items sold out. Menus, hours and billing stay with the manager and owner.
            </T>
          </Card>
        ) : null}

        {isManager ? (
          <>
            <T variant="heading" style={{ marginBottom: space.md }}>
              Business hours
            </T>
            {hoursQ.isLoading ? (
              <LoadingBlock />
            ) : hoursQ.isError ? (
              <Card style={{ marginBottom: space.lg }}>
                <T variant="label" tone="muted">
                  Couldn&apos;t load your hours. Editing stays off so a guess never overwrites your real schedule.
                </T>
                <PillButton label="Retry" size="md" variant="soft" style={{ marginTop: space.sm }} onPress={() => hoursQ.refetch()} />
              </Card>
            ) : (
              <Card style={{ marginBottom: space.lg }}>
                {days.map((d) => (
                  <View key={d.dayOfWeek} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.sm }}>
                    <T variant="label" weight="semibold" style={{ width: 40 }}>
                      {DAY_LABELS[d.dayOfWeek]}
                    </T>
                    {d.isClosed ? (
                      <T variant="label" tone="muted" style={{ flex: 1, paddingHorizontal: space.sm }}>
                        Closed
                      </T>
                    ) : (
                      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.sm }}>
                        <View style={{ flex: 1, borderRadius: radius.md, borderWidth: 1, borderColor: color.border.subtle, backgroundColor: color.surface.base }}>
                          <TextInput
                            value={d.openTime}
                            onChangeText={(t) => setDay(d.dayOfWeek, { openTime: t })}
                            placeholder="08:00"
                            placeholderTextColor={color.text.muted}
                            style={{ fontFamily: 'Hanken', fontSize: 13, color: color.text.primary, textAlign: 'center', paddingVertical: 8 }}
                          />
                        </View>
                        <T variant="label" tone="muted">
                          –
                        </T>
                        <View style={{ flex: 1, borderRadius: radius.md, borderWidth: 1, borderColor: color.border.subtle, backgroundColor: color.surface.base }}>
                          <TextInput
                            value={d.closeTime}
                            onChangeText={(t) => setDay(d.dayOfWeek, { closeTime: t })}
                            placeholder="22:00"
                            placeholderTextColor={color.text.muted}
                            style={{ fontFamily: 'Hanken', fontSize: 13, color: color.text.primary, textAlign: 'center', paddingVertical: 8 }}
                          />
                        </View>
                      </View>
                    )}
                    <BrandSwitch value={!d.isClosed} onChange={(val) => setDay(d.dayOfWeek, { isClosed: !val })} />
                  </View>
                ))}
                <PillButton label="Save hours" size="md" loading={setHours.isPending} style={{ marginTop: space.sm }} disabled={days.length === 0} onPress={() => setHours.mutate(days)} />
                {setHours.isSuccess ? (
                  <T variant="caption" tone="success" center style={{ marginTop: space.sm }}>
                    Hours updated
                  </T>
                ) : null}
              </Card>
            )}
          </>
        ) : null}
      </ScrollView>

      <RoleSwitcherSheet visible={switcherOpen} current="vendor" onClose={() => setSwitcherOpen(false)} />
    </Screen>
  );
}

/** Billing state exactly as the subscription engine records it: trial, grace,
 *  rate and the next billing date (weekly flat fee — the whole Swift model). */
/**
 * The business's legal documents, owner-only: live checklist status with
 * expiry — an approved document re-opens for upload inside its 30-day renewal
 * window, and an expired one explains exactly why commerce stopped.
 */
function VendorDocumentsSection({ vendorType }: { vendorType: string }) {
  const { data: status, isLoading, isError, refetch } = useVerificationStatus<any>(vendorType);
  return (
    <View style={{ marginBottom: space.lg }}>
      <DocumentChecklist role={vendorType} status={status} isLoading={isLoading} isError={isError} onRetry={refetch} />
    </View>
  );
}

function SubscriptionCard({ sub, phone }: { sub: any; phone?: string }) {
  const navigation = useNavigation<any>();
  const pill = !sub
    ? { label: 'Inactive', tone: 'brand' as const }
    : sub.isTrialActive
      ? { label: 'Free trial', tone: 'brand' as const }
      : sub.isInGracePeriod
        ? { label: 'Grace period', tone: 'warning' as const }
        : sub.status === 'ACTIVE'
          ? { label: 'Active', tone: 'success' as const }
          : { label: String(sub.status ?? '').toLowerCase() || 'Inactive', tone: 'neutral' as const };
  const subLine = !sub
    ? 'Not active yet'
    : sub.isTrialActive && sub.trialEndDate
      ? `Trial ends ${fmtDate(sub.trialEndDate)} · then ${money(sub.weeklyRate)}/week`
      : sub.isInGracePeriod && sub.gracePeriodEnd
        ? `Weekly fee due by ${fmtDate(sub.gracePeriodEnd)}`
        : `${money(sub.customRate ?? sub.weeklyRate)}/week${sub.nextBillingDate ? ` · next bill ${fmtDate(sub.nextBillingDate)}` : ''}`;
  return (
    <>
      <Card style={{ marginBottom: space.lg, paddingVertical: space.sm }}>
        <SettingsRow icon="calendar" label="Subscription" sub={subLine} right={<TonePill label={pill.label} tone={pill.tone} />} />
        <SettingsRow
          icon="hash"
          label="My Swift Number"
          sub="Pay the weekly fee at any MMG agent"
          onPress={() => navigation.navigate('VendorMySwiftNumber')}
        />
        {phone ? <SettingsRow icon="phone" label="Phone" right={<T variant="label" tone="muted">{phone}</T>} /> : null}
      </Card>
      {/* Only actionable billing status belongs here. A healthy account stays
          quiet; prepaid fee credit is deliberately not framed as a wallet. */}
      <VendorBillingNotice sub={sub} onPay={() => navigation.navigate('VendorMySwiftNumber')} />
    </>
  );
}

/** Storefront QR (real /vendor/qr payload) — the entry point into the full
 *  "My Swift QR" screen (share, performance, lifecycle). */
function StoreQrCard() {
  const qrQ = useVendorQr();
  const navigation = useNavigation<any>();
  if (!qrQ.data?.svg) return null;
  return (
    <Pressable onPress={() => navigation.navigate('VendorMyQr')} accessibilityRole="button" accessibilityLabel="Open My Swift QR">
      {({ pressed }) => (
        <Card style={{ alignItems: 'center', marginBottom: space.lg, opacity: pressed ? 0.85 : 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', justifyContent: 'space-between' }}>
            <T variant="body" weight="semibold">
              My Swift QR
            </T>
            <Feather name="chevron-right" size={18} color={color.text.muted} />
          </View>
          <View style={{ padding: space.md, borderRadius: radius.lg, backgroundColor: color.white, marginTop: space.md }}>
            <SvgXml xml={qrQ.data.svg} width={168} height={168} />
          </View>
          <T variant="caption" weight="semibold" tone="brand" style={{ marginTop: space.md }}>
            {qrQ.data.deepLink}
          </T>
          <T variant="caption" tone="muted" center style={{ marginTop: 4 }}>
            Customers scan this to order from you — tap to share, print and see scans.
          </T>
        </Card>
      )}
    </Pressable>
  );
}

/**
 * Operator promotions (master plan §4.2): the store's own promo codes.
 * Create %/$ codes with an end date, pause/resume, delete. Customers see
 * live codes on the storefront and apply them at checkout.
 */
function PromosSection() {
  const promosQ = useVendorPromos();
  const createPromo = useCreatePromo();
  const updatePromo = useUpdatePromo();
  const deletePromo = useDeletePromo();

  const [showForm, setShowForm] = useState(false);
  const [code, setCode] = useState('');
  const [desc, setDesc] = useState('');
  const [kind, setKind] = useState<'PERCENTAGE' | 'FIXED_AMOUNT'>('PERCENTAGE');
  const [value, setValue] = useState('');
  const [minOrder, setMinOrder] = useState('');
  const [days, setDays] = useState(7);

  const promos: any[] = promosQ.data ?? [];
  const errMsg =
    (createPromo.error as any)?.response?.data?.error?.message ?? (createPromo.error as any)?.response?.data?.message;

  const submit = () => {
    const v = Number(value);
    if (!code.trim() || !desc.trim() || !Number.isFinite(v) || v <= 0) return;
    const validUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    createPromo.mutate(
      {
        code: code.trim().toUpperCase(),
        description: desc.trim(),
        discountType: kind,
        discountValue: v,
        ...(Number(minOrder) > 0 ? { minOrderAmount: Number(minOrder) } : {}),
        validUntil,
      },
      {
        onSuccess: () => {
          setShowForm(false);
          setCode('');
          setDesc('');
          setValue('');
          setMinOrder('');
        },
      },
    );
  };

  return (
    <>
      <T variant="heading" style={{ marginBottom: space.md }}>
        Promotions
      </T>
      <Card style={{ marginBottom: space.lg }}>
        {promos.map((p) => {
          const expired = new Date(p.validUntil).getTime() < Date.now();
          return (
            <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <T variant="label" weight="bold" style={{ letterSpacing: 1 }}>
                    {p.code}
                  </T>
                  <TonePill label={expired ? 'Expired' : p.isActive ? 'Live' : 'Paused'} tone={expired ? 'neutral' : p.isActive ? 'success' : 'neutral'} />
                </View>
                <T variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 2 }}>
                  {p.discountType === 'PERCENTAGE' ? `${Number(p.discountValue)}% off` : `${money(p.discountValue)} off`}
                  {p.minOrderAmount ? ` over ${money(p.minOrderAmount)}` : ''} · used {p.currentUses}×
                </T>
              </View>
              {!expired ? (
                <PillButton
                  label={p.isActive ? 'Pause' : 'Resume'}
                  variant="soft"
                  size="sm"
                  style={{ marginRight: space.sm }}
                  disabled={updatePromo.isPending}
                  onPress={() => updatePromo.mutate({ id: p.id, data: { isActive: !p.isActive } })}
                />
              ) : null}
              <Pressable onPress={() => deletePromo.mutate(p.id)} hitSlop={8}>
                <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                  <Feather name="trash-2" size={16} color={color.text.muted} />
                </View>
              </Pressable>
            </View>
          );
        })}
        {promos.length === 0 && !promosQ.isLoading ? (
          <T variant="label" tone="muted" style={{ marginBottom: space.md }}>
            No codes yet — run your first promotion and it shows on your storefront.
          </T>
        ) : null}

        {showForm ? (
          <View style={{ gap: space.md }}>
            <InlineInput value={code} onChangeText={setCode} placeholder="Code (e.g. SAVE20)" autoCapitalize="characters" />
            <InlineInput value={desc} onChangeText={setDesc} placeholder="What customers see (e.g. 20% off this week)" />
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <Chip label="% off" selected={kind === 'PERCENTAGE'} onPress={() => setKind('PERCENTAGE')} style={{ height: 38, paddingHorizontal: space.md }} />
              <Chip label="GYD off" selected={kind === 'FIXED_AMOUNT'} onPress={() => setKind('FIXED_AMOUNT')} style={{ height: 38, paddingHorizontal: space.md }} />
            </View>
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <InlineInput style={{ flex: 1 }} value={value} onChangeText={setValue} placeholder={kind === 'PERCENTAGE' ? '% (e.g. 20)' : 'GYD (e.g. 500)'} keyboardType="number-pad" />
              <InlineInput style={{ flex: 1 }} value={minOrder} onChangeText={setMinOrder} placeholder="Min order (opt.)" keyboardType="number-pad" />
            </View>
            <T variant="caption" weight="semibold" tone="muted">
              Runs for
            </T>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              {[3, 7, 14, 30].map((d) => (
                <Chip key={d} label={`${d} days`} selected={days === d} onPress={() => setDays(d)} style={{ height: 36, paddingHorizontal: space.md }} />
              ))}
            </View>
            {errMsg ? (
              <T variant="label" tone="error">
                {errMsg}
              </T>
            ) : null}
            <PillButton
              label="Launch promotion"
              size="md"
              loading={createPromo.isPending}
              disabled={!code.trim() || !desc.trim() || !(Number(value) > 0)}
              onPress={submit}
            />
          </View>
        ) : (
          <PillButton label="New promotion" variant="soft" size="md" onPress={() => setShowForm(true)} />
        )}
      </Card>
    </>
  );
}

/**
 * Staff & roles (master plan §4.1) — the owner's team panel: add an existing
 * Swift account by phone as MANAGER or STAFF, flip roles, remove access.
 */
function StaffSection() {
  const staffQ = useVendorStaff();
  const addStaff = useAddStaff();
  const removeStaff = useRemoveStaff();
  const updateRole = useUpdateStaffRole();
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<'MANAGER' | 'STAFF'>('STAFF');
  const [removing, setRemoving] = useState<any | null>(null);

  const members: any[] = staffQ.data ?? [];
  const errMsg = (addStaff.error as any)?.response?.data?.error?.message ?? (addStaff.error as any)?.response?.data?.message;

  const submit = () => {
    const p = phone.trim();
    if (p.length < 10) return;
    addStaff.mutate({ phone: p, role }, { onSuccess: () => setPhone('') });
  };

  return (
    <>
      <T variant="heading" style={{ marginBottom: space.md }}>
        Team
      </T>
      <Card style={{ marginBottom: space.lg }}>
        {members.map((m) => (
          <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
            {m.user?.avatar ? (
              <Image source={{ uri: mediaUrl(m.user.avatar) ?? undefined }} style={{ width: 36, height: 36, borderRadius: 18 }} contentFit="cover" />
            ) : (
              <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[50] }}>
                <Feather name="user" size={16} color={color.text.muted} />
              </View>
            )}
            <View style={{ flex: 1, marginLeft: space.sm }}>
              <T variant="label" weight="semibold">
                {[m.user?.firstName, m.user?.lastName].filter(Boolean).join(' ')}
              </T>
              <T variant="caption" tone="muted">
                {m.user?.phone}
              </T>
            </View>
            <PillButton
              label={m.role === 'MANAGER' ? 'Manager' : 'Staff'}
              variant="soft"
              size="sm"
              style={{ marginRight: space.sm }}
              disabled={updateRole.isPending}
              onPress={() => updateRole.mutate({ id: m.id, role: m.role === 'MANAGER' ? 'STAFF' : 'MANAGER' })}
            />
            <Pressable onPress={() => setRemoving(m)} hitSlop={8}>
              <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                <Feather name="x" size={16} color={color.text.muted} />
              </View>
            </Pressable>
          </View>
        ))}
        {members.length === 0 && !staffQ.isLoading ? (
          <T variant="label" tone="muted" style={{ marginBottom: space.md }}>
            No team members yet — add your manager or floor staff by phone.
          </T>
        ) : null}

        <InlineInput value={phone} onChangeText={setPhone} placeholder="+592 phone of an existing Swift account" keyboardType="phone-pad" />
        <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
          <Chip label="Staff · queue + availability" selected={role === 'STAFF'} onPress={() => setRole('STAFF')} />
          <Chip label="Manager" selected={role === 'MANAGER'} onPress={() => setRole('MANAGER')} />
        </View>
        {errMsg ? (
          <T variant="label" tone="error" style={{ marginTop: space.md }}>
            {errMsg}
          </T>
        ) : null}
        <PillButton
          label="Add to team"
          variant="soft"
          size="md"
          style={{ marginTop: space.md }}
          loading={addStaff.isPending}
          disabled={phone.trim().length < 10}
          onPress={submit}
        />
        <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
          Tap a role pill to switch Manager ↔ Staff.
        </T>
      </Card>

      <PopupCard visible={!!removing} onClose={() => setRemoving(null)}>
        <IconChip icon="user-x" size={56} tone="error" />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Remove team member?
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {removing?.user?.firstName ?? 'This person'} will lose store access immediately.
        </T>
        <PillButton
          label="Remove"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => {
            const id = removing!.id;
            setRemoving(null);
            removeStaff.mutate(id);
          }}
        />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setRemoving(null)} />
      </PopupCard>
    </>
  );
}
