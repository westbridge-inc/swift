/** @jsxImportSource react */
import { useState } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Pressable, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { color, radius, space } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import {
  Card,
  Chip,
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
import {
  useVendorProfile,
  useSaveItem,
  useUploadItemImage,
  useAddOptionGroup,
  useDeleteOptionGroup,
  useAddOption,
  useDeleteOption,
} from '../../../hooks/vendorops';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
} from '../../../stores/authStore';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { useVendorPreview } from '../../../stores/vendorPreview';
import { money } from '../../../lib/money';
import { mediaUrl } from '../../../lib/images';

/**
 * Modifiers editor (master plan §4.2): size / add-ons / toppings on an item.
 * The OptionGroup CRUD already exists server-side — this is its operator UI.
 * Mutations resolve to the created row, so the list updates from the response
 * instead of waiting on the menu query.
 */
function ModifiersSection({ item }: { item: any }) {
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const [groups, setGroups] = useState<any[]>(item.optionGroups ?? []);
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

  const removeOption = (groupId: string, optionId: string) => {
    if (readOnly) return;
    const owner = requireAuthSessionSnapshot();
    delOption.mutate({ id: optionId, authSession: owner }, {
      onSuccess: () => {
        try {
          requireAuthSessionForPrincipal(owner);
          setGroups((gs) =>
            gs.map((g) => (g.id === groupId ? { ...g, options: (g.options ?? []).filter((o: any) => o.id !== optionId) } : g)),
          );
        } catch {
          // The editor belongs to an older account and is being unmounted.
        }
      },
    });
  };

  return (
    <Card style={{ marginTop: space.lg }}>
      <T variant="heading">Options &amp; add-ons</T>
      <T variant="label" tone="muted" style={{ marginTop: 4 }}>
        Sizes, toppings, extras — customers pick these when ordering.
      </T>
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
            <Pressable disabled={readOnly} onPress={() => setRemoveGroupId(g.id)} hitSlop={8}>
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
          onPress={() => {
            if (readOnly) return;
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
  const adjust = useMutation({
    mutationFn: () => vendorApi.adjustStock(item.id, { delta: Number(delta), reason }),
    onSuccess: () => {
      setOpen(false);
      setDelta('');
      qc.invalidateQueries({ queryKey: ['vendor', 'menu'] });
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
      <InlineInput value={delta} onChangeText={setDelta} placeholder="+50 received, -3 damaged" keyboardType="default" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {(['RECEIVED', 'DAMAGED', 'MANUAL', 'RECONCILE', 'RETURN'] as const).map((r) => (
          <Chip key={r} label={r.toLowerCase()} selected={reason === r} onPress={() => setReason(r)} style={{ height: 32, paddingHorizontal: space.md }} />
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
  const { store } = useVendorProfile();
  const isService = store?.vendorType === 'SERVICE';
  const existingBooking = (existing?.bookingConfig ?? {}) as any;
  const [duration, setDuration] = useState<number>(existingBooking.durationMinutes ?? 30);
  const [days, setDays] = useState<number[]>(() => {
    const ds: number[] = (existingBooking.slots ?? []).map((s: any) => s.dayOfWeek);
    return ds.length ? Array.from(new Set(ds)) : [1, 2, 3, 4, 5];
  });
  const [startTime, setStartTime] = useState<string>(existingBooking.slots?.[0]?.start ?? '09:00');
  const [endTime, setEndTime] = useState<string>(existingBooking.slots?.[0]?.end ?? '17:00');
  const [mode, setMode] = useState<'AT_BUSINESS' | 'MOBILE' | 'BOTH'>(existingBooking.serviceMode ?? 'AT_BUSINESS');
  const [radiusKm, setRadiusKm] = useState<string>(existingBooking.serviceRadiusKm != null ? String(existingBooking.serviceRadiusKm) : '5');

  const priceNum = Number(price);
  const valid =
    name.trim().length >= 1 && Number.isFinite(priceNum) && priceNum >= 0 && !!categoryId && (!isService || days.length > 0);
  const busy = save.isPending || uploadImage.isPending;
  const previewUri = localPhoto?.uri ?? mediaUrl(existing?.imageUrl) ?? undefined;

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
          slots: days.map((d) => ({ dayOfWeek: d, start: startTime, end: endTime })),
          serviceMode: mode,
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
              // '' clears tracking (null) so a vendor can stop tracking stock.
              stockQuantity: stock.trim() === '' ? null : Number.isFinite(stockNum as number) ? stockNum : undefined,
              lowStockThreshold: lowStock.trim() === '' ? null : Number(lowStock) >= 0 ? Number(lowStock) : undefined,
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
    navigation.goBack();
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

            <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
              Available days
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg }}>
              {DAY_LABELS.map((d, i) => (
                <Chip
                  key={i}
                  label={d}
                  selected={days.includes(i)}
                  onPress={() => setDays((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))}
                  style={{ height: 36, paddingHorizontal: space.md }}
                />
              ))}
            </View>

            <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
              Hours
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.lg }}>
              <InlineInput style={{ flex: 1 }} value={startTime} onChangeText={setStartTime} placeholder="09:00" center />
              <T variant="label" tone="muted">
                to
              </T>
              <InlineInput style={{ flex: 1 }} value={endTime} onChangeText={setEndTime} placeholder="17:00" center />
            </View>

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
              {/* How big is one of these to carry? Riders on bicycles cannot take
                  a very bulky order, and dispatch uses this to keep it off them.
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
                  {bulk === 'very_bulky'
                    ? 'Like a 20 kg bag of rice or a case of water. Only riders with a bigger vehicle will be offered it.'
                    : bulk === 'bulky'
                      ? 'Like a crate of drinks or a large box.'
                      : 'Fits in a delivery bag with room to spare.'}
                </T>
              </View>
              <InlineInput value={sku} onChangeText={setSku} placeholder="SKU / barcode (optional)" />
              <InlineInput value={lowStock} onChangeText={setLowStock} placeholder="Low-stock alert at (e.g. 5)" keyboardType="number-pad" />
              {stock.trim() !== '' ? (
                <T variant="caption" tone="muted">
                  Tracked items sell down automatically and hide at 0. You’ll get an alert at your low-stock level.
                </T>
              ) : null}
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
          <T variant="caption" tone="muted" style={{ marginTop: space.md }}>
            Save the item first to add options &amp; add-ons (sizes, toppings, extras).
          </T>
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
          <Chip label="★ Popular" selected={popular} onPress={() => setPopular((v) => !v)} style={{ height: 38, paddingHorizontal: space.md }} />
        </View>

        {save.isError ? (
          <T variant="label" tone="error" style={{ marginBottom: space.md }}>
            Couldn&apos;t save. Check the details and try again.
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
                    : isService && days.length === 0
                      ? 'Pick available days'
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
    </Screen>
  );
}
