/** @jsxImportSource react */
import { useVendorMutation } from '../../../hooks/useVendorMutation';
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { usePreventRemove } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { Pressable, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { color, radius, space } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as Crypto from 'expo-crypto';
import {
  BrandSwitch,
  Card,
  Chip,
  ConfirmDialog,
  IconChip,
  LabeledInput,
  LinkText,
  PhotoDrop,
  PillButton,
  PopupCard,
  PopupTitle,
  Screen,
  Segmented,
  T,
} from '../../../kit';
import { DAY_LABELS, GUTTER, InlineInput, SubHeader } from '../shared';
import { vendorApi } from '../../../services/api';
import { toast } from '../../../kit/toast';
import { useRowHold } from '../../../lib/useRowHold';
import { SOLD_IN_STORE } from '../../../lib/inStoreSale';
import { afterDismiss } from '../../../kit/after-dismiss';
import {
  useVendorProfile,
  useSaveItem,
  useUploadItemImage,
  useAddOptionGroup,
  useDeleteOptionGroup,
  useAddOption,
  useDeleteOption,
  MENU_WRITE_KEY,
  answerIntoMenu,
  menuScope,
} from '../../../hooks/vendorops';
import { menuWithItemFields } from '../../../lib/menuAnswers';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
} from '../../../stores/authStore';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { useVendorPreview } from '../../../stores/vendorPreview';
import { money } from '../../../lib/money';
import { vatClassChoices, type VatClass } from '../../../lib/storeVat';
import { useStoreVat } from '../../../hooks/storeVat';
import { isKeptPhoto, storePhotoUrl, HERO_PHOTO_WIDTH } from '../../../lib/images';
import { STORE_PICK } from '../../../lib/storePick';
import { BULK_WORDS } from '../../../lib/bulkWords';
import {
  BUFFER_CHOICES, NOTICE_CHOICES, choicesWith, instantBookingAvailable, minutesLabel, nextWindow, openingBookingSettings,
  slotsFromWeekHours, weekHoursFromSlots, weekHoursProblem, type WeekHours,
} from '../../../lib/bookingHours';

/** [TAP-AUDIT] An option group (with its choices) written on a NEW item, before its first save: kept on the phone and
 *  sent with the item in the one create request (POST /vendor/items takes `optionGroups`), so a store adds an item
 *  with its sizes in one visit instead of saving, finding the item again and adding each choice one request at a time. */
export type DraftOptionGroup = {
  key: string;
  name: string;
  isRequired: boolean;
  maxSelect: number;
  options: { key: string; name: string; additionalPrice: number }[];
};

/** The create request's `optionGroups`, exactly what the store typed (the server checks every name, as it does for
 *  a group added later). */
export function draftOptionGroupsPayload(groups: DraftOptionGroup[]) {
  return groups.map((g) => ({
    name: g.name,
    isRequired: g.isRequired,
    minSelect: g.isRequired ? 1 : 0,
    maxSelect: g.maxSelect,
    options: g.options.map((o) => ({ name: o.name, additionalPrice: o.additionalPrice })),
  }));
}

let draftKeys = 0;
const nextDraftKey = () => `draft-${++draftKeys}`;

/** [REVIEW-F #2141 S4-2] The item or its section was deleted on another phone: the server's "Category with id … not
 *  found" names an internal id, so the store reads this instead. */
export const ITEM_GONE_WORDS = 'This section or item was removed on another phone. Go back and open the menu again.';

/** [TAP-AUDIT] Why the server would not save the item, in its own words (a banned word, documents not yet checked).
 *  A refusal with no words for a person (the form's shape, a duplicate, a server fault) keeps the editor's own
 *  sentence; a missing item or section says so in plain words. */
export function saveRefusal(error: unknown): string | null {
  const body = (error as { response?: { data?: { error?: { code?: unknown; message?: unknown } } } } | null)?.response?.data?.error;
  if (body?.code === 'NOT_FOUND') return ITEM_GONE_WORDS;
  if (!body || body.code === 'VALIDATION_ERROR' || body.code === 'DUPLICATE' || body.code === 'INTERNAL_ERROR') return null;
  if (typeof body.message !== 'string' || !body.message.trim()) return null;
  return body.message;
}

/**
 * Modifiers editor (master plan §4.2): size / add-ons / toppings on an item.
 * The OptionGroup CRUD already exists server-side — this is its operator UI.
 * Mutations resolve to the created row, so the list updates from the response
 * instead of waiting on the menu query. On a NEW item (no id yet) the groups and
 * choices are a draft the editor sends with the item ([TAP-AUDIT], `staged`).
 */
function ModifiersSection({ item, staged }: { item: any; staged?: { groups: DraftOptionGroup[]; set: Dispatch<SetStateAction<DraftOptionGroup[]>> } }) {
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const [savedGroups, setGroups] = useState<any[]>(item?.optionGroups ?? []);
  const groups: any[] = staged
    ? staged.groups.map((g) => ({ id: g.key, name: g.name, isRequired: g.isRequired, maxSelect: g.maxSelect, options: g.options.map((o) => ({ id: o.key, name: o.name, additionalPrice: o.additionalPrice })) }))
    : savedGroups;
  const addGroup = useAddOptionGroup();
  const delGroup = useDeleteOptionGroup();
  const addOption = useAddOption();
  const delOption = useDeleteOption();

  const [groupName, setGroupName] = useState('');
  const [groupRequired, setGroupRequired] = useState(false);
  const [groupMulti, setGroupMulti] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, { name: string; price: string }>>({});
  const [removeGroupId, setRemoveGroupId] = useState<string | null>(null);
  const draft = (gid: string) => drafts[gid] ?? { name: '', price: '' };

  const submitGroup = async () => {
    if (readOnly) return;
    const name = groupName.trim();
    if (!name || addGroup.isPending) return;
    if (staged) {
      staged.set((gs) => [...gs, { key: nextDraftKey(), name, isRequired: groupRequired, maxSelect: groupMulti ? 10 : 1, options: [] }]);
      setGroupName('');
      setGroupRequired(false);
      setGroupMulti(false);
      return;
    }
    const owner = requireAuthSessionSnapshot();
    const g = await addGroup.mutateAsync({
      itemId: item.id,
      data: { name, isRequired: groupRequired, minSelect: groupRequired ? 1 : 0, maxSelect: groupMulti ? 10 : 1 },
      authSession: owner,
    });
    requireAuthSessionForPrincipal(owner);
    setGroups((gs) => [...gs, { options: [], ...g }]);
    setGroupName('');
    setGroupRequired(false);
    setGroupMulti(false);
  };

  const submitOption = async (groupId: string) => {
    if (readOnly) return;
    const d = draft(groupId);
    const name = d.name.trim();
    if (!name || addOption.isPending) return;
    if (staged) {
      const additionalPrice = Number(d.price) || 0;
      staged.set((gs) => gs.map((g) => (g.key === groupId ? { ...g, options: [...g.options, { key: nextDraftKey(), name, additionalPrice }] } : g)));
      setDrafts((s) => ({ ...s, [groupId]: { name: '', price: '' } }));
      return;
    }
    const owner = requireAuthSessionSnapshot();
    const opt = await addOption.mutateAsync({
      groupId,
      data: { name, additionalPrice: Number(d.price) || 0 },
      authSession: owner,
    });
    requireAuthSessionForPrincipal(owner);
    setGroups((gs) => gs.map((g) => (g.id === groupId ? { ...g, options: [...(g.options ?? []), opt] } : g)));
    setDrafts((s) => ({ ...s, [groupId]: { name: '', price: '' } }));
  };

  // [BUG-GUARDS C2] Each option's x waits for its own delete (a second tap on it is ignored); another option's x goes through.
  const holdRow = useRowHold();
  const removeOption = (groupId: string, optionId: string) => {
    if (readOnly) return;
    if (staged) {
      staged.set((gs) => gs.map((g) => (g.key === groupId ? { ...g, options: g.options.filter((o) => o.key !== optionId) } : g)));
      return;
    }
    const owner = requireAuthSessionSnapshot();
    // [REVIEW-F #2123 S3-1] The option comes off on ITS OWN call's promise: with two options' x in flight, per-call
    // callbacks (mutate/mutateAsync options) reach only the latest call. A sample preview never gets here (readOnly).
    holdRow(optionId, () => delOption.mutateAsync({ id: optionId, authSession: owner }).then(() => {
      try {
        requireAuthSessionForPrincipal(owner);
        setGroups((gs) =>
          gs.map((g) => (g.id === groupId ? { ...g, options: (g.options ?? []).filter((o: any) => o.id !== optionId) } : g)),
        );
      } catch {
        // The editor belongs to an older account and is being unmounted.
      }
    }, () => undefined)); // a failed delete is told by the app's mutation error notice; the row is released for another try
  };

  return (
    <Card style={{ marginTop: space.lg }}>
      <T variant="heading">Options &amp; add-ons</T>
      <T variant="label" tone="muted" style={{ marginTop: 4 }}>
        Sizes, toppings, extras — customers pick these when ordering.
      </T>
      {staged && groups.length > 0 ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
          Saved with the item when you tap Add item.
        </T>
      ) : null}
      {readOnly ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
          Read-only in the sample preview.
        </T>
      ) : null}

      {groups.map((g) => (
        <View key={g.id} style={{ marginTop: space.md, borderRadius: radius.lg, backgroundColor: color.surface.subtle, padding: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <T variant="body" weight="semibold">
                {g.name}
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                {g.isRequired ? 'Required' : 'Optional'} · {g.maxSelect > 1 ? `up to ${g.maxSelect}` : 'pick one'}
              </T>
            </View>
            <Pressable
              disabled={readOnly}
              onPress={() => (staged ? staged.set((gs) => gs.filter((d) => d.key !== g.id)) : setRemoveGroupId(g.id))}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${g.name}`}
            >
              <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                <Feather name="trash-2" size={18} color={color.text.muted} />
              </View>
            </Pressable>
          </View>

          {(g.options ?? []).map((o: any) => (
            <View key={o.id} style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.sm }}>
              <T variant="label" style={{ flex: 1 }}>
                {o.name}
              </T>
              <T variant="label" tone="muted" style={{ marginRight: space.md }}>
                {Number(o.additionalPrice) > 0 ? `+${money(o.additionalPrice)}` : 'Free'}
              </T>
              <Pressable disabled={readOnly} onPress={() => removeOption(g.id, o.id)} hitSlop={8}>
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Feather name="x" size={16} color={color.text.muted} />
                </View>
              </Pressable>
            </View>
          ))}

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.sm }}>
            <InlineInput
              style={{ flex: 1 }}
              value={draft(g.id).name}
              onChangeText={(t: string) => setDrafts((s) => ({ ...s, [g.id]: { ...draft(g.id), name: t } }))}
              placeholder="Choice (e.g. Large)"
            />
            <InlineInput
              style={{ width: 96 }}
              value={draft(g.id).price}
              onChangeText={(t: string) => setDrafts((s) => ({ ...s, [g.id]: { ...draft(g.id), price: t } }))}
              placeholder="+GYD"
              keyboardType="number-pad"
            />
            <Pressable onPress={() => submitOption(g.id)} disabled={readOnly || addOption.isPending}>
              {({ pressed }) => (
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: pressed ? color.brand[600] : color.brand[500],
                  }}
                >
                  <Feather name="plus" size={18} color={color.white} />
                </View>
              )}
            </Pressable>
          </View>
        </View>
      ))}

      <View style={{ marginTop: space.md }}>
        <InlineInput value={groupName} onChangeText={setGroupName} placeholder="New group (e.g. Size, Toppings)" />
        <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
          <Chip label="Required" selected={groupRequired} onPress={() => setGroupRequired((v) => !v)} style={{ height: 38, paddingHorizontal: space.lg }} />
          <Chip label="Multiple picks" selected={groupMulti} onPress={() => setGroupMulti((v) => !v)} style={{ height: 38, paddingHorizontal: space.lg }} />
        </View>
        <PillButton
          label="Add option group"
          variant="soft"
          size="md"
          style={{ marginTop: space.md }}
          loading={addGroup.isPending}
          disabled={readOnly || !groupName.trim()}
          onPress={submitGroup}
        />
      </View>

      <PopupCard visible={!!removeGroupId} onClose={() => setRemoveGroupId(null)}>
        <IconChip icon="trash-2" size={56} tone="error" />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Remove group?
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          Delete this option group and all its choices.
        </T>
        <PillButton
          label="Delete"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          loading={delGroup.isPending}
          onPress={() => {
            if (readOnly || delGroup.isPending) return;
            const gid = removeGroupId!;
            setRemoveGroupId(null);
            const owner = requireAuthSessionSnapshot();
            delGroup.mutate({ id: gid, authSession: owner }, {
              onSuccess: () => {
                try {
                  requireAuthSessionForPrincipal(owner);
                  setGroups((gs) => gs.filter((g) => g.id !== gid));
                } catch {
                  // The editor belongs to an older account and is being unmounted.
                }
              },
            });
          }}
        />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setRemoveGroupId(null)} />
      </PopupCard>
    </Card>
  );
}

/** §5.6 reasoned stock movement — the audit-trail path, not a raw overwrite:
 *  ±delta with a reason (received / damaged / manual / reconcile / return). */
function StockAdjustRow({ item }: { item: any }) {
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<'RECEIVED' | 'DAMAGED' | 'MANUAL' | 'RECONCILE' | 'RETURN'>('RECEIVED');
  // [MASTER-025] One key per adjustment as entered: tapping Apply again after a
  // failure cannot move stock twice; changing the entry is a new adjustment.
  const [commandKey, setCommandKey] = useState(() => Crypto.randomUUID());
  const adjust = useVendorMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: () => vendorApi.adjustStock(item.id, { delta: Number(delta), reason }, commandKey),
    onMutate: menuScope,
    onSuccess: (res: any, _vars: void, scope) => {
      setCommandKey(Crypto.randomUUID());
      setOpen(false);
      setDelta('');
      // [TAP-AUDIT] The count the ledger now holds goes into the menu at once; the menu is read again once, later.
      const answer = res?.data?.data;
      const fields = {
        ...(typeof answer?.stockQuantity === 'number' ? { stockQuantity: answer.stockQuantity } : {}),
        ...(typeof answer?.isAvailable === 'boolean' ? { isAvailable: answer.isAvailable } : {}),
      };
      answerIntoMenu(qc, scope, (menu) => menuWithItemFields(menu, item.id, fields));
    },
  });
  const n = Number(delta);
  const valid = delta.trim() !== '' && Number.isInteger(n) && n !== 0;

  if (!open) {
    if (readOnly) {
      return (
        <T variant="caption" tone="muted">
          Stock adjustment is read-only in preview.
        </T>
      );
    }
    return (
      <Pressable onPress={() => setOpen(true)} hitSlop={6}>
        <T variant="caption" weight="semibold" tone="brand">
          Adjust stock (received / damaged)…
        </T>
      </Pressable>
    );
  }
  return (
    <View style={{ gap: space.sm }}>
      <InlineInput value={delta} onChangeText={(v) => { setDelta(v); setCommandKey(Crypto.randomUUID()); }} placeholder="+50 received, -3 damaged" keyboardType="default" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {(['RECEIVED', 'DAMAGED', 'MANUAL', 'RECONCILE', 'RETURN'] as const).map((r) => (
          <Chip key={r} label={r.toLowerCase()} selected={reason === r} onPress={() => { setReason(r); setCommandKey(Crypto.randomUUID()); }} style={{ height: 32, paddingHorizontal: space.md }} />
        ))}
      </View>
      {adjust.isError ? (
        <T variant="caption" tone="error">
          {((adjust.error as any)?.response?.data?.error?.message) ?? 'Adjustment failed.'}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <PillButton label="Apply" size="sm" style={{ flex: 1 }} loading={adjust.isPending} disabled={readOnly || !valid || adjust.isPending} onPress={() => adjust.mutate()} />
        <PillButton label="Cancel" variant="soft" size="sm" style={{ flex: 1 }} onPress={() => setOpen(false)} />
      </View>
    </View>
  );
}

export function VendorItemEditorScreen({ navigation, route }: any) {
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const existing = route.params?.item;
  const categories: { id: string; name: string }[] = route.params?.categories ?? [];
  const save = useSaveItem();
  const uploadImage = useUploadItemImage();
  const [name, setName] = useState<string>(existing?.name ?? '');
  const [price, setPrice] = useState<string>(existing ? String(existing.basePrice ?? '') : '');
  const [description, setDescription] = useState<string>(existing?.description ?? '');
  const [categoryId, setCategoryId] = useState<string>(existing?.categoryId ?? categories[0]?.id ?? '');
  const [available, setAvailable] = useState<boolean>(existing ? existing.isAvailable !== false : true);
  const [popular, setPopular] = useState<boolean>(!!existing?.isPopular);
  const [sku, setSku] = useState<string>(existing?.sku ?? '');
  const [unit, setUnit] = useState<string>(existing?.unit ?? '');
  // [G2] The load hint dispatch needs to keep a 20 kg rice bag off a bicycle.
  // Three words, never units: the server maps them. An item saved before the
  // field existed reads as normal, which is exactly how it has always behaved.
  const [bulk, setBulk] = useState<'normal' | 'bulky' | 'very_bulky'>(existing?.bulk ?? 'normal');
  const [stock, setStock] = useState<string>(existing?.stockQuantity != null ? String(existing.stockQuantity) : '');
  const [lowStock, setLowStock] = useState<string>(existing?.lowStockThreshold != null ? String(existing.lowStockThreshold) : '');
  const [localPhoto, setLocalPhoto] = useState<{ uri: string; name: string; type: string } | null>(null);
  const [photoErr, setPhotoErr] = useState<string | null>(null);

  // Service businesses configure a bookable appointment instead of stock.
  const { store, myRole } = useVendorProfile();
  const isService = store?.vendorType === 'SERVICE';
  // [STORE-VAT · owner O-5] The owner of a store that told Swift it is VAT-registered gives each item its VAT class.
  // A sample preview has no VAT; a manager does not see it (the business's tax registration is the owner's).
  const samplePreview = useVendorPreview((st) => st.previewType) != null;
  const storeVat = useStoreVat(myRole === 'OWNER' && !samplePreview);
  const vatRate = storeVat.data && storeVat.data.status !== 'NONE' ? storeVat.data.ratePercent : null;
  const vatEffective = storeVat.data?.effective === true;
  const [vatClass, setVatClass] = useState<VatClass>((existing?.vatClass as VatClass | undefined) ?? 'STANDARD');
  const existingBooking = (existing?.bookingConfig ?? {}) as any;
  const [duration, setDuration] = useState<number>(existingBooking.durationMinutes ?? 30);
  // [BOOK-S5a] Hours per day, more than one window a day (a break is the gap between two). Every
  // stored window is kept: the old editor put the first window's times on every day when it saved.
  const [week, setWeek] = useState<WeekHours>(() => weekHoursFromSlots(existingBooking.slots));
  // [BOOK-S5a · owner A4/C2] The gap after each booking, the minimum notice and "Confirm bookings
  // automatically". null = not touched: the opening value follows the server (the switch's word on
  // the profile can arrive after the editor opens).
  const instantAvailable = isService && instantBookingAvailable(store);
  const opening = openingBookingSettings(existing?.bookingConfig ?? null, instantAvailable);
  const [instantTouched, setInstant] = useState<boolean | null>(null);
  const [bufferTouched, setBuffer] = useState<number | null>(null);
  const [noticeTouched, setNotice] = useState<number | null>(null);
  const instant = instantTouched ?? opening.instantBooking;
  const buffer = bufferTouched ?? opening.bufferMinutes;
  const notice = noticeTouched ?? opening.minNoticeMinutes;
  const hoursProblem = isService ? weekHoursProblem(week) : null;
  const setDayWindows = (day: number, update: (windows: WeekHours[number]) => WeekHours[number]) =>
    setWeek((w) => w.map((windows, d) => (d === day ? update(windows) : windows)));
  const [mode, setMode] = useState<'AT_BUSINESS' | 'MOBILE' | 'BOTH'>(existingBooking.serviceMode ?? 'AT_BUSINESS');
  const [radiusKm, setRadiusKm] = useState<string>(existingBooking.serviceRadiusKm != null ? String(existingBooking.serviceRadiusKm) : '5');

  // [UI-SWEEP U67] Typed, unsaved changes are never thrown away silently.
  // Back, a swipe, or a board door to the menu list (navigate + pop) stops on
  // "Discard your changes?"; Discard lets that same navigation through. A
  // change is a difference from how the editor opened (a toggle put back is
  // not one); a saved item, or a read-only preview, leaves without an ask.
  // [TAP-AUDIT] A new item's option groups and choices, sent with it in the one create request.
  const [draftGroups, setDraftGroups] = useState<DraftOptionGroup[]>([]);
  const formNow = JSON.stringify([
    name, price, description, categoryId, available, popular, sku, unit, bulk, stock, lowStock,
    duration, week, instantTouched, bufferTouched, noticeTouched, mode, radiusKm,
    draftGroups.map((g) => [g.name, g.isRequired, g.maxSelect, g.options.map((o) => [o.name, o.additionalPrice])]),
  ]);
  const [formAtOpen] = useState(formNow);
  const [leaving, setLeaving] = useState(false);
  const [discardAsk, setDiscardAsk] = useState<{ action: any } | null>(null);
  const unsaved = !readOnly && !leaving && (formNow !== formAtOpen || localPhoto !== null);
  usePreventRemove(unsaved, ({ data }) => setDiscardAsk({ action: data.action }));
  // The ask is lifted (a render) before the saved editor closes itself.
  useEffect(() => {
    if (leaving) navigation.goBack();
  }, [leaving, navigation]);

  const priceNum = Number(price);
  const valid =
    name.trim().length >= 1 && Number.isFinite(priceNum) && priceNum >= 0 && !!categoryId && (!isService || hoursProblem == null);
  const busy = save.isPending || uploadImage.isPending;
  // [IMAGES-E2E PR4] Only a photo Swift keeps is drawn (an outside address is not shown to customers either).
  const previewUri = localPhoto?.uri ?? (isKeptPhoto(existing?.imageUrl) ? storePhotoUrl(existing?.imageUrl, HERO_PHOTO_WIDTH) : null) ?? undefined;

  const [photoMenu, setPhotoMenu] = useState(false);

  const applyAsset = (res: ImagePicker.ImagePickerResult) => {
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setLocalPhoto({ uri: a.uri, name: a.fileName ?? 'item.jpg', type: a.mimeType ?? 'image/jpeg' });
  };

  const pickFromLibrary = async () => {
    setPhotoMenu(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      // [G9 · #917's law] A denied permission explains itself. The camera
      // path already did; the library path failed silent — same sentence
      // shape now, Settings named as the way back.
      setPhotoErr('Photo library access needed — allow it in Settings to choose a photo.');
      return;
    }
    setPhotoErr(null);
    applyAsset(await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 }));
  };

  const takePhoto = async () => {
    setPhotoMenu(false);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setPhotoErr('Camera access needed — allow it in Settings to take photos.');
      return;
    }
    setPhotoErr(null);
    applyAsset(await ImagePicker.launchCameraAsync({ quality: 0.8 }));
  };

  const submit = async () => {
    if (readOnly || !valid || busy) return;
    const owner = requireAuthSessionSnapshot();
    const operationStoreId = useStoreSwitcher.getState().selectedStoreId;
    const stockNum = stock.trim() === '' ? undefined : Number(stock);
    const bookingConfig = isService
      ? {
          durationMinutes: duration,
          slots: slotsFromWeekHours(week),
          serviceMode: mode,
          bufferMinutes: buffer,
          minNoticeMinutes: notice,
          // [BOOK-S5a] Sent only while the server says it can be chosen; otherwise the listing keeps what it stores.
          ...(instantAvailable ? { instantBooking: instant } : {}),
          ...(mode !== 'AT_BUSINESS' ? { serviceRadiusKm: Number(radiusKm) || 0 } : {}),
        }
      : undefined;
    const saved: any = await save.mutateAsync({
      id: existing?.id,
      authSession: owner,
      storeId: operationStoreId,
      data: {
        categoryId,
        name: name.trim(),
        description: description.trim() || undefined,
        basePrice: priceNum,
        isAvailable: available,
        isPopular: popular,
        ...(isService
          ? { fulfillment: 'APPOINTMENT' as const, bookingConfig }
          : {
              sku: sku.trim() || undefined,
              unit: unit.trim() || undefined,
              bulk,
              // [STORE-VAT] Sent only when the owner sees the choice; otherwise the item keeps its class.
              ...(vatRate != null ? { vatClass } : {}),
              // '' clears tracking (null) so a vendor can stop tracking stock.
              stockQuantity: stock.trim() === '' ? null : Number.isFinite(stockNum as number) ? stockNum : undefined,
              lowStockThreshold: lowStock.trim() === '' ? null : Number(lowStock) >= 0 ? Number(lowStock) : undefined,
              // [TAP-AUDIT] A new item's groups and choices travel with it (one request, not one per choice).
              ...(!existing && draftGroups.length > 0 ? { optionGroups: draftOptionGroupsPayload(draftGroups) } : {}),
            }),
      },
    });
    let current = requireAuthSessionForPrincipal(owner);
    const itemId = existing?.id ?? saved?.id;
    if (localPhoto && itemId) {
      // Item is already saved; a failed photo upload shouldn't block the flow.
      try {
        await uploadImage.mutateAsync({
          id: itemId,
          file: localPhoto,
          authSession: current,
          storeId: operationStoreId,
        });
      } catch (uploadError) {
        if (uploadError instanceof AuthSessionBoundaryError) throw uploadError;
        // [WR-034] The item is durable but the vendor must KNOW the photo
        // didn't make it — a silent miss ships a photo-less listing.
        toast.show("Item saved, but the photo didn't upload — open the item and add it again.");
      }
      current = requireAuthSessionForPrincipal(owner);
    }
    requireAuthSessionForPrincipal(current);
    setLeaving(true);
  };

  return (
    <Screen>
      <SubHeader title={existing ? 'Edit Item' : 'New Item'} navigation={navigation} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {/* Photo — the kit's PhotoDrop when the slot is empty (WS-2: a dashed
            CONTROL inviting the one person who can fix it, never a grey state);
            the pressable preview once a photograph exists. First adoption of
            the primitive — the hand-rolled twin retires. */}
        {previewUri ? (
          <Pressable disabled={readOnly} onPress={() => setPhotoMenu(true)}>
            {({ pressed }) => (
              <View
                style={{
                  height: 160,
                  borderRadius: radius.lg,
                  overflow: 'hidden',
                  marginBottom: space.sm,
                  opacity: pressed ? 0.85 : 1,
                }}
              >
                <Image source={{ uri: previewUri }} style={{ width: '100%', height: 160 }} contentFit="cover" />
              </View>
            )}
          </Pressable>
        ) : (
          <PhotoDrop
            onPress={() => setPhotoMenu(true)}
            disabled={readOnly}
            uploading={uploadImage.isPending}
            hint="Bright and straight-on — customers choose with their eyes"
            style={{ marginBottom: space.sm }}
          />
        )}
        {previewUri ? (
          <View style={{ alignItems: 'center', marginBottom: space.lg }}>
            {readOnly ? (
              <T variant="caption" tone="muted">Read-only sample photo</T>
            ) : (
              <LinkText label={uploadImage.isPending ? 'Uploading…' : 'Change photo'} onPress={() => setPhotoMenu(true)} />
            )}
          </View>
        ) : null}
        {photoErr ? (
          <T variant="caption" tone="error" center style={{ marginBottom: space.md }}>
            {photoErr}
          </T>
        ) : null}

        <View style={{ gap: space.md }}>
          <LabeledInput value={name} onChangeText={setName} placeholder="Item name" />
          <LabeledInput value={price} onChangeText={setPrice} placeholder="Price (GYD)" keyboardType="decimal-pad" />
          <InlineInput value={description} onChangeText={setDescription} placeholder="Description (optional)" multiline />
        </View>

        {isService ? (
          <Card style={{ marginTop: space.lg }}>
            <T variant="heading" style={{ marginBottom: space.md }}>
              Appointment booking
            </T>

            <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
              Appointment length
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg }}>
              {[15, 30, 45, 60, 90, 120].map((m) => (
                <Chip key={m} label={`${m} min`} selected={duration === m} onPress={() => setDuration(m)} style={{ height: 36, paddingHorizontal: space.md }} />
              ))}
            </View>

            {/* [BOOK-S5a] Hours per day. A day with no hours is closed; a break is the gap between two windows. */}
            <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
              Hours each day
            </T>
            <View style={{ gap: space.sm, marginBottom: space.lg }}>
              {DAY_LABELS.map((label, d) => {
                const windows = week[d] ?? [];
                const open = windows.length > 0;
                return (
                  <View key={label} style={{ gap: space.xs }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                      <Chip
                        label={open ? label : `${label} · closed`}
                        selected={open}
                        onPress={() => setDayWindows(d, (w) => (w.length > 0 ? [] : [nextWindow([])]))}
                        style={{ height: 36, paddingHorizontal: space.md, minWidth: 64 }}
                      />
                      {open ? (
                        <LinkText label="Add hours" onPress={() => setDayWindows(d, (w) => [...w, nextWindow(w)])} />
                      ) : null}
                    </View>
                    {windows.map((w, i) => (
                      <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                        <InlineInput
                          style={{ flex: 1 }}
                          value={w.start}
                          onChangeText={(t) => setDayWindows(d, (ws) => ws.map((x, j) => (j === i ? { ...x, start: t } : x)))}
                          placeholder="09:00"
                          center
                        />
                        <T variant="label" tone="muted">to</T>
                        <InlineInput
                          style={{ flex: 1 }}
                          value={w.end}
                          onChangeText={(t) => setDayWindows(d, (ws) => ws.map((x, j) => (j === i ? { ...x, end: t } : x)))}
                          placeholder="17:00"
                          center
                        />
                        <Pressable
                          onPress={() => setDayWindows(d, (ws) => ws.filter((_, j) => j !== i))}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove ${label} ${w.start}–${w.end}`}
                        >
                          <Feather name="x" size={18} color={color.text.muted} />
                        </Pressable>
                      </View>
                    ))}
                  </View>
                );
              })}
              {hoursProblem ? (
                <T variant="caption" tone="error">{hoursProblem}</T>
              ) : null}
            </View>

            <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
              Gap after each booking
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg }}>
              {choicesWith(BUFFER_CHOICES, buffer).map((m) => (
                <Chip key={m} label={minutesLabel(m)} selected={buffer === m} onPress={() => setBuffer(m)} style={{ height: 36, paddingHorizontal: space.md }} />
              ))}
            </View>

            <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.xs }}>
              Minimum notice
            </T>
            <T variant="caption" tone="muted" style={{ marginBottom: space.sm }}>
              How close to its start a customer can still book a time.
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg }}>
              {choicesWith(NOTICE_CHOICES, notice).map((m) => (
                <Chip key={m} label={minutesLabel(m)} selected={notice === m} onPress={() => setNotice(m)} style={{ height: 36, paddingHorizontal: space.md }} />
              ))}
            </View>

            {/* [BOOK-S5a · owner A3/A4] Shown only while the server says it can be chosen. */}
            {instantAvailable ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.lg }}>
                <View style={{ flex: 1 }}>
                  <T variant="label" weight="semibold">Confirm bookings automatically</T>
                  <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                    {instant
                      ? 'Bookings paid in cash at the appointment are confirmed as soon as the customer books. MMG bookings still wait for you to accept.'
                      : 'Every booking waits for you to accept it.'}
                  </T>
                </View>
                <BrandSwitch value={instant} onChange={setInstant} label="Confirm bookings automatically" />
              </View>
            ) : null}

            <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
              Where does it happen?
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md }}>
              <Chip label="At my place" selected={mode === 'AT_BUSINESS'} onPress={() => setMode('AT_BUSINESS')} style={{ height: 38, paddingHorizontal: space.md }} />
              <Chip label="I travel to them" selected={mode === 'MOBILE'} onPress={() => setMode('MOBILE')} style={{ height: 38, paddingHorizontal: space.md }} />
              <Chip label="Both" selected={mode === 'BOTH'} onPress={() => setMode('BOTH')} style={{ height: 38, paddingHorizontal: space.md }} />
            </View>

            {mode !== 'AT_BUSINESS' ? (
              <View>
                <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                  How far will you travel from your store? (km)
                </T>
                <InlineInput value={radiusKm} onChangeText={setRadiusKm} placeholder="5" keyboardType="number-pad" />
              </View>
            ) : null}
          </Card>
        ) : (
          <>
            {/* Inventory — used by groceries/shops; optional for restaurants */}
            <T variant="label" weight="semibold" tone="muted" style={{ marginTop: space.lg, marginBottom: space.sm }}>
              Inventory (optional)
            </T>
            <View style={{ gap: space.md }}>
              <View style={{ flexDirection: 'row', gap: space.md }}>
                <InlineInput style={{ flex: 1 }} value={stock} onChangeText={setStock} placeholder="Stock qty" keyboardType="number-pad" />
                <InlineInput style={{ flex: 1 }} value={unit} onChangeText={setUnit} placeholder="Unit (kg, ea)" />
              </View>
              {/* How big is one of these to carry? An order holding a bulky or very bulky
                  item is never offered to a bicycle (lib/bulkWords; the server's utils/load).
                  A choice, not a number — nobody should be asked to think in units. */}
              <View>
                <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                  How bulky is one of these to carry?
                </T>
                <Segmented
                  options={[
                    { key: 'normal', label: 'Normal' },
                    { key: 'bulky', label: 'Bulky' },
                    { key: 'very_bulky', label: 'Very bulky' },
                  ] as const}
                  value={bulk}
                  onChange={setBulk}
                />
                <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                  {BULK_WORDS[bulk]}
                </T>
              </View>
              {vatRate != null ? (
                <View>
                  <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                    VAT on this item
                  </T>
                  <Segmented
                    options={vatClassChoices(vatRate, vatEffective).map((c) => ({ key: c.value, label: c.value === 'STANDARD' ? 'Standard' : c.value === 'ZERO_RATED' ? 'Zero-rated' : 'Exempt' }))}
                    value={vatClass}
                    onChange={(k) => setVatClass(k as VatClass)}
                  />
                  <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                    {vatClassChoices(vatRate, vatEffective).find((c) => c.value === vatClass)?.label}. You choose each item’s VAT class and
                    are responsible for it; check with the GRA.
                  </T>
                </View>
              ) : null}
              <InlineInput value={sku} onChangeText={setSku} placeholder="SKU / barcode (optional)" />
              <InlineInput value={lowStock} onChangeText={setLowStock} placeholder="Low-stock alert at (e.g. 5)" keyboardType="number-pad" />
              {stock.trim() !== '' ? (
                <T variant="caption" tone="muted">
                  Tracked items sell down automatically and hide at 0. You’ll get an alert at your low-stock level.
                </T>
              ) : (
                // [IN-STORE-SALE] Why the menu list shows no "Sold in store −1" for this item.
                <T variant="caption" tone="muted">
                  {SOLD_IN_STORE.untracked}
                </T>
              )}
              {/* Reasoned movements (received/damaged/…) keep an audit trail —
                  different from overwriting the number above. */}
              {existing && existing.stockQuantity != null ? (
                <StockAdjustRow item={existing} />
              ) : null}
            </View>
          </>
        )}

        {existing && !isService ? (
          <ModifiersSection item={existing} />
        ) : !isService ? (
          <ModifiersSection item={null} staged={{ groups: draftGroups, set: setDraftGroups }} />
        ) : null}

        <T variant="label" weight="semibold" tone="muted" style={{ marginTop: space.lg, marginBottom: space.sm }}>
          Category
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg }}>
          {categories.map((c) => (
            <Chip key={c.id} label={c.name} selected={c.id === categoryId} onPress={() => setCategoryId(c.id)} style={{ height: 38, paddingHorizontal: space.md }} />
          ))}
        </View>

        <View style={{ flexDirection: 'row', gap: space.md, marginBottom: space.lg }}>
          <Chip label={available ? 'Available' : 'Sold out'} selected={available} onPress={() => setAvailable((v) => !v)} style={{ height: 38, paddingHorizontal: space.md }} />
          <Chip label={`★ ${STORE_PICK}`} selected={popular} onPress={() => setPopular((v) => !v)} style={{ height: 38, paddingHorizontal: space.md }} />
        </View>

        {save.isError ? (
          <T variant="label" tone="error" style={{ marginBottom: space.md }}>
            {saveRefusal(save.error) ?? "Couldn't save. Check the details and try again."}
          </T>
        ) : null}
        {/* [#947's grammar] A disabled button says WHY — the first unmet
            requirement, in the vendor's own order of work. */}
        <PillButton
          label={
            readOnly
              ? 'Read-only preview'
              : !name.trim()
                ? 'Name the item first'
                : !(Number.isFinite(priceNum) && priceNum >= 0)
                  ? 'Set a price'
                  : !categoryId
                    ? 'Pick a category'
                    : isService && hoursProblem
                      ? 'Fix the hours'
                      : existing
                        ? 'Save changes'
                        : 'Add item'
          }
          loading={busy}
          disabled={readOnly || !valid}
          onPress={submit}
        />
      </ScrollView>

      {/* Photo source picker — kit popup */}
      <PopupCard visible={photoMenu} onClose={() => setPhotoMenu(false)}>
        <IconChip icon="camera" size={56} />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Item photo
        </PopupTitle>
        <PillButton label="Take photo" style={{ alignSelf: 'stretch', marginTop: space['2xl'] }} onPress={takePhoto} />
        <PillButton label="Choose from library" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={pickFromLibrary} />
        {localPhoto ? (
          <PillButton
            label="Remove selected photo"
            variant="outline"
            style={{ alignSelf: 'stretch', marginTop: space.md }}
            onPress={() => {
              setLocalPhoto(null);
              setPhotoMenu(false);
            }}
          />
        ) : null}
      </PopupCard>

      {/* [UI-SWEEP U67] The ask before typed changes are thrown away. */}
      <ConfirmDialog
        open={discardAsk !== null}
        title="Discard your changes?"
        body="What you changed on this item is not saved."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          const ask = discardAsk;
          setDiscardAsk(null);
          if (ask) afterDismiss(() => navigation.dispatch(ask.action));
        }}
        onClose={() => setDiscardAsk(null)}
      />
    </Screen>
  );
}
