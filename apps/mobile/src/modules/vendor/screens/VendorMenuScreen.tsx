/** @jsxImportSource react */
import { useState, useEffect } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { color, radius, space } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  IconChip,
  LoadingBlock,
  PillButton,
  PopupCard,
  PopupTitle,
  Screen,
  T,
  TonePill,
} from '../../../kit';
import { GUTTER, InlineInput, SubHeader } from '../shared';
import {
  useVendorProfile,
  useVendorMenu,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
  useDeleteItem,
  useSetItemAvailability,
  useUploadCategoryPhoto,
  useRemoveCategoryPhoto,
} from '../../../hooks/vendorops';
import { usePullToRefresh } from '../../../hooks/usePullToRefresh';
import { useVendorPreview } from '../../../stores/vendorPreview';
import { money } from '../../../lib/money';
import { inventorySummary } from '../../../lib/vendorInventory';
import { isKeptPhoto, storePhotoUrl } from '../../../lib/images';

/** [IMAGES-E2E PR4 · REVIEW-F S4-2 on #1965] A photo address saved before photos were uploaded: named for what it is. */
export const OUTSIDE_PHOTO_NOTE = "Its old photo link isn't shown to customers. Upload the photo again.";
import { Switch as AvailabilitySwitch } from '../../../kit/switch';
import { catalogueMeta, safeVendorRole, numericFact } from '../shared';
import { catalogueCheckLine } from '../../../lib/catalogueCheck';

export function MenuItemRow({
  item,
  navigation,
  categories,
  canEdit,
}: {
  item: any;
  navigation: any;
  categories: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const setAvail = useSetItemAvailability();
  const del = useDeleteItem();
  const serverAvailable = item.isAvailable !== false;
  const [markedAvailable, setMarkedAvailable] = useState(serverAvailable);
  useEffect(() => setMarkedAvailable(serverAvailable), [serverAvailable]);
  const tracksStock = item.stockQuantity != null;
  const outOfStock = tracksStock && item.stockQuantity <= 0;
  const soldOut = !markedAvailable;
  const lowStock =
    markedAvailable &&
    !outOfStock &&
    tracksStock &&
    item.lowStockThreshold != null &&
    item.stockQuantity <= item.lowStockThreshold;
  const availabilityDisabled = readOnly || setAvail.isPending;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ordered = numericFact(item.totalOrdered);
  const stockDetail = outOfStock
    ? '0 left'
    : lowStock
      ? `${item.stockQuantity} left · alert at ${item.lowStockThreshold}`
      : tracksStock
        ? `${item.stockQuantity} in stock`
        : null;
  const itemDetail = [ordered == null ? null : `${ordered} orders placed`, stockDetail].filter(Boolean).join(' · ');
  // [IMAGES-E2E PR4 · COORD ruling 19 Oct (a)] Only a photo Swift keeps is shown, here as to customers;
  // an outside address saved before photos were uploaded is named, so the store can upload it again.
  const photoUri = isKeptPhoto(item.imageUrl) ? storePhotoUrl(item.imageUrl, 160) : null;
  const photoNotShown = !!item.imageUrl && !photoUri;
  const toggleAvailability = () => {
    const next = !markedAvailable;
    setMarkedAvailable(next);
    setAvail.mutate(
      { id: item.id, isAvailable: next },
      { onError: () => setMarkedAvailable(!next) },
    );
  };

  return (
    <Card style={{ marginBottom: space.md, backgroundColor: soldOut || outOfStock ? color.soft.warning : color.surface.base }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
        <View style={{ opacity: soldOut ? 0.55 : 1 }}>
          {photoUri ? (
            <Image
              source={{ uri: photoUri }}
              style={{ width: space['5xl'], height: space['5xl'], borderRadius: radius.md }}
              contentFit="cover"
              accessibilityLabel={`${item.name} photo`}
            />
          ) : (
            <View
              style={{
                width: space['5xl'],
                height: space['5xl'],
                borderRadius: radius.md,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: color.brand[50],
              }}
            >
              <Feather name="image" size={18} color={color.text.muted} />
            </View>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.md, opacity: soldOut ? 0.62 : 1 }}>
            <T variant="heading" numberOfLines={2} style={{ flex: 1 }}>
              {item.name}
            </T>
            <T variant="numM" numberOfLines={1}>
              {money(item.basePrice)}
            </T>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm }}>
            {soldOut ? <TonePill label="SOLD OUT" tone="warning" /> : null}
            {outOfStock ? <TonePill label="0 LEFT" tone="warning" /> : null}
            {lowStock ? <TonePill label={`${item.stockQuantity} LEFT`} tone="warning" /> : null}
            {itemDetail ? (
              <T variant="caption" tone="muted" style={{ flexShrink: 1 }}>
                {itemDetail}
              </T>
            ) : null}
          </View>
          {photoNotShown ? (
            <T variant="caption" weight="semibold" style={{ marginTop: space.xs, color: color.warning }}>
              {OUTSIDE_PHOTO_NOTE}
            </T>
          ) : null}
          {/* [GUARDRAILS §8] Why customers cannot see this item: Swift does not allow it, or is checking it. */}
          {catalogueCheckLine(item.catalogueCheck) ? (
            <T variant="caption" weight="semibold" style={{ marginTop: space.xs, color: item.catalogueCheck?.status === 'NOT_ALLOWED' ? color.error : color.warning }}>
              {catalogueCheckLine(item.catalogueCheck)}
            </T>
          ) : null}
        </View>
      </View>

      <Pressable
        disabled={availabilityDisabled}
        onPress={toggleAvailability}
        accessibilityRole="switch"
        accessibilityLabel={`${item.name} availability`}
        accessibilityHint={
          soldOut
              ? 'Make this item available to customers'
              : 'Mark this item sold out for new orders'
        }
        accessibilityState={{ checked: markedAvailable, disabled: availabilityDisabled, busy: setAvail.isPending }}
        style={{
          minHeight: space['5xl'],
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: space.md,
          marginTop: space.md,
          paddingHorizontal: space.md,
          borderRadius: radius.md,
          backgroundColor: soldOut || outOfStock ? color.surface.base : color.brand[50],
        }}
      >
        <View style={{ flex: 1, paddingVertical: space.sm }}>
          <T variant="label" weight="semibold" tone={soldOut || outOfStock ? 'warning' : 'deep'}>
            {soldOut ? 'Hidden from new orders' : outOfStock ? 'Visible, but can’t be ordered' : 'Available to customers'}
          </T>
          <T variant="caption" tone="muted">
            {soldOut
              ? 'Customers can’t add this to a new order.'
              : outOfStock
                ? 'Stock is zero. Switch off to hide it, or restock it.'
                : 'Switch off to stop new customers adding it.'}
          </T>
        </View>
        <AvailabilitySwitch
          value={markedAvailable}
          disabled={availabilityDisabled}
          accessible={false}
          pointerEvents="none"
        />
      </Pressable>

      {setAvail.isError ? (
        <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
          Availability didn’t update — check your connection and try again.
        </T>
      ) : null}

      {canEdit ? (
        <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
          <PillButton
            label="Edit item"
            variant="soft"
            size="md"
            style={{ flex: 1 }}
            onPress={() => navigation.navigate('VendorItemEditor', { item, categories })}
          />
          <PillButton
            label="Delete"
            variant="outline"
            size="md"
            style={{ flex: 1 }}
            loading={del.isPending}
            disabled={readOnly}
            onPress={() => setConfirmDelete(true)}
          />
        </View>
      ) : null}

      <PopupCard visible={canEdit && confirmDelete} onClose={() => setConfirmDelete(false)}>
        <IconChip icon="trash-2" size={56} tone="error" />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Delete item?
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          Remove &quot;{item.name}&quot; from your menu.
        </T>
        <PillButton
          label="Delete"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => {
            if (readOnly || !canEdit) return;
            setConfirmDelete(false);
            del.mutate(item.id);
          }}
        />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setConfirmDelete(false)} />
      </PopupCard>
    </Card>
  );
}

/** Stock alerts from the fetched menu itself: tracked items at/below their
 *  own alert level (or sold out and auto-hidden). */
// Inventory-first lead for goods vendors (grocery/shop): an at-a-glance stock
// health read above the catalogue. Data-driven — self-hides when nothing tracks
// stock, so restaurants/services (null stock) never see it.
function InventorySummaryCard({ categories }: { categories: any[] }) {
  const s = inventorySummary(categories);
  if (s.tracked === 0) return null;
  const cells: { label: string; value: number; tone: 'ink' | 'warning' | 'muted' }[] = [
    { label: 'In stock', value: s.inStock, tone: 'ink' },
    { label: 'Low', value: s.lowStock, tone: s.lowStock > 0 ? 'warning' : 'muted' },
    { label: 'Out', value: s.outOfStock, tone: s.outOfStock > 0 ? 'warning' : 'muted' },
    { label: 'SKUs', value: s.tracked, tone: 'muted' },
  ];
  return (
    <Card style={{ marginBottom: space.md }}>
      <T variant="caption" weight="bold" tone="muted" style={{ letterSpacing: 1, marginBottom: space.sm }}>
        INVENTORY
      </T>
      <View style={{ flexDirection: 'row' }}>
        {cells.map((c) => (
          <View key={c.label} style={{ flex: 1 }}>
            <T variant="heading" tone={c.tone}>
              {String(c.value)}
            </T>
            <T variant="caption" tone="muted">
              {c.label}
            </T>
          </View>
        ))}
      </View>
    </Card>
  );
}

function LowStockCard({ categories, navigation, catOptions }: { categories: any[]; navigation: any; catOptions: { id: string; name: string }[] }) {
  const low = categories
    .flatMap((c: any) => c.items ?? [])
    .filter(
      (i: any) =>
        i.stockQuantity != null &&
        (i.stockQuantity <= 0 || (i.lowStockThreshold != null && i.stockQuantity <= i.lowStockThreshold)),
    )
    .sort((a: any, b: any) => a.stockQuantity - b.stockQuantity);
  if (low.length === 0) return null;
  return (
    <View style={{ borderRadius: radius.lg, backgroundColor: color.soft.warning, padding: space.lg, marginBottom: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Feather name="alert-triangle" size={16} color={color.warning} />
        <T variant="body" weight="semibold">
          Inventory alerts · {low.length}
        </T>
      </View>
      {low.slice(0, 4).map((i: any) => {
        const status = i.stockQuantity <= 0
          ? i.isAvailable === false
            ? '0 left · sold out'
            : '0 left · switch off'
          : `${i.stockQuantity} left`;
        return (
          <Pressable
            key={i.id}
            onPress={() => navigation.navigate('VendorItemEditor', { item: i, categories: catOptions })}
            accessibilityRole="button"
            accessibilityLabel={`${i.name}. ${status}`}
            accessibilityHint="Open the item editor"
          >
            {({ pressed }) => (
              <View style={{ minHeight: space['5xl'], flexDirection: 'row', alignItems: 'center', opacity: pressed ? 0.7 : 1 }}>
                <T variant="label" numberOfLines={1} style={{ flex: 1, paddingRight: space.md }}>
                  {i.name}
                </T>
                <T variant="label" weight="semibold" tone={i.stockQuantity <= 0 ? 'warning' : 'ink'}>
                  {status}
                </T>
                <Feather name="chevron-right" size={14} color={color.text.muted} style={{ marginLeft: space.xs }} />
              </View>
            )}
          </Pressable>
        );
      })}
      {low.length > 4 ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
          +{low.length - 4} more below their alert level
        </T>
      ) : null}
    </View>
  );
}

/** Category heading with manager controls; staff receive the same factual heading
 *  without authoring affordances. */
export function CategoryHeader({ cat, canEdit }: { cat: any; canEdit: boolean }) {
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const updateCategory = useUpdateCategory();
  const deleteCategory = useDeleteCategory();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState<string>(cat.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const itemCount = (cat.items ?? []).length;
  // [IMAGES-E2E PR4/PR5] The section's own photo: above the section on the store page, and Home can show it.
  const [photoOpen, setPhotoOpen] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  // [REVIEW-F S4-5 on #1965] Removing asks first, like every other photo removal.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const uploadPhoto = useUploadCategoryPhoto();
  const removePhoto = useRemoveCategoryPhoto();
  const sectionPhoto = isKeptPhoto(cat.imageUrl) ? storePhotoUrl(cat.imageUrl, 160) : null;
  // [REVIEW-F S4-4 on #1965] An outside address is named here too, as on items.
  const sectionPhotoNotShown = !!cat.imageUrl && !sectionPhoto;
  const closePhoto = () => { setPhotoOpen(false); setConfirmRemove(false); };
  const photoBusy = uploadPhoto.isPending || removePhoto.isPending;
  const serverWords = (e: unknown, fallback: string) =>
    (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ?? fallback;
  const pickSectionPhoto = async () => {
    if (readOnly || !canEdit) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setPhotoError('Photo library access needed. Allow it in Settings to choose a photo.');
      return;
    }
    setPhotoError(null);
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 0.85 });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    uploadPhoto.mutate(
      { id: cat.id, file: { uri: a.uri, name: a.fileName ?? 'section.jpg', type: a.mimeType ?? 'image/jpeg' } },
      {
        onSuccess: closePhoto,
        onError: (e: unknown) => setPhotoError(serverWords(e, "That photo didn't upload. Check your connection and try again.")),
      },
    );
  };

  const saveName = () => {
    if (readOnly || !canEdit) return;
    const n = name.trim();
    if (!n || n === cat.name) {
      setEditing(false);
      setName(cat.name);
      return;
    }
    updateCategory.mutate({ id: cat.id, data: { name: n } }, { onSuccess: () => setEditing(false) });
  };

  if (editing && canEdit) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md }}>
        <InlineInput style={{ flex: 1 }} value={name} onChangeText={setName} placeholder="Category name" />
        <PillButton label="Save" size="md" loading={updateCategory.isPending} disabled={!name.trim()} onPress={saveName} />
        <PillButton
          label="Cancel"
          variant="soft"
          size="md"
          onPress={() => {
            setEditing(false);
            setName(cat.name);
          }}
        />
      </View>
    );
  }

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
      {sectionPhoto || canEdit ? (
        <Pressable
          disabled={readOnly || !canEdit}
          onPress={() => { setPhotoError(null); setConfirmRemove(false); setPhotoOpen(true); }}
          accessibilityRole={canEdit ? 'button' : 'image'}
          accessibilityLabel={canEdit ? `Photo for ${cat.name}` : `${cat.name} photo`}
          accessibilityState={{ disabled: readOnly || !canEdit }}
          hitSlop={4}
          style={{ marginRight: space.md }}
        >
          <View style={{ width: 40, height: 40, borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[50] }}>
            {sectionPhoto ? (
              <Image source={{ uri: sectionPhoto }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
            ) : (
              <Feather name={sectionPhotoNotShown ? 'alert-circle' : 'camera'} size={16} color={sectionPhotoNotShown ? color.warning : color.text.muted} />
            )}
          </View>
        </Pressable>
      ) : null}
      <T variant="heading" numberOfLines={1} style={{ flex: 1, paddingRight: space.md }}>
        {cat.name}
      </T>
      <T variant="caption" tone="muted" style={{ marginRight: canEdit ? space.sm : 0 }}>
        {itemCount} item{itemCount === 1 ? '' : 's'}
      </T>
      {canEdit ? (
        <>
          <Pressable
            disabled={readOnly}
            onPress={() => setEditing(true)}
            accessibilityRole="button"
            accessibilityLabel={`Rename ${cat.name}`}
            accessibilityState={{ disabled: readOnly }}
          >
            {({ pressed }) => (
              <View style={{ width: space['5xl'], height: space['5xl'], alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
                <Feather name="edit-2" size={16} color={color.text.muted} />
              </View>
            )}
          </Pressable>
          <Pressable
            disabled={readOnly}
            onPress={() => setConfirmDelete(true)}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${cat.name}`}
            accessibilityState={{ disabled: readOnly }}
          >
            {({ pressed }) => (
              <View style={{ width: space['5xl'], height: space['5xl'], alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
                <Feather name="trash-2" size={16} color={color.text.muted} />
              </View>
            )}
          </Pressable>
        </>
      ) : null}

      <PopupCard visible={canEdit && photoOpen} onClose={closePhoto}>
        <PopupTitle variant="title" center>Photo for “{cat.name}”</PopupTitle>
        {confirmRemove ? (
          <>
            <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
              {sectionPhotoNotShown
                ? 'Remove this photo link? It is taken off this section.'
                : 'Remove this photo? It is deleted from Swift and customers stop seeing it.'}
            </T>
            {photoError ? <T variant="caption" tone="error" center style={{ marginTop: space.sm }}>{photoError}</T> : null}
            <PillButton
              label="Remove photo"
              style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
              loading={removePhoto.isPending}
              disabled={photoBusy}
              onPress={() => {
                if (readOnly || !canEdit) return;
                removePhoto.mutate(cat.id, {
                  onSuccess: closePhoto,
                  onError: (e: unknown) => setPhotoError(serverWords(e, "That photo couldn't be removed. Try again.")),
                });
              }}
            />
            <PillButton label="Keep it" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setConfirmRemove(false)} />
          </>
        ) : (
          <>
            {/* [REVIEW-F S3-1 on #1965 · S4-1 on #1973] True on both counts: the store page always shows it above the
                section (PR5); Home only can (one tile per section name, none while the discovery rail is live). */}
            <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
              Customers see it above “{cat.name}” on your store page, and it can show on Home. Location and camera details are removed.
            </T>
            {sectionPhotoNotShown ? (
              <T variant="caption" weight="semibold" center style={{ marginTop: space.sm, color: color.warning }}>{OUTSIDE_PHOTO_NOTE}</T>
            ) : null}
            {photoError ? <T variant="caption" tone="error" center style={{ marginTop: space.sm }}>{photoError}</T> : null}
            <PillButton
              label={sectionPhoto ? 'Choose a new photo' : 'Choose a photo'}
              style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
              loading={uploadPhoto.isPending}
              disabled={photoBusy}
              onPress={() => { void pickSectionPhoto(); }}
            />
            {cat.imageUrl ? (
              <PillButton
                label="Remove photo"
                variant="soft"
                style={{ alignSelf: 'stretch', marginTop: space.md }}
                disabled={photoBusy}
                onPress={() => { setPhotoError(null); setConfirmRemove(true); }}
              />
            ) : null}
            <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={closePhoto} />
          </>
        )}
      </PopupCard>

      <PopupCard visible={canEdit && confirmDelete} onClose={() => setConfirmDelete(false)}>
        <IconChip icon="trash-2" size={56} tone="error" />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Delete “{cat.name}”?
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {itemCount > 0
            ? `This removes the section AND its ${itemCount} item${itemCount === 1 ? '' : 's'} from your menu.`
            : 'This removes the empty section from your menu.'}
        </T>
        <PillButton
          label={itemCount > 0 ? `Delete section + ${itemCount} item${itemCount === 1 ? '' : 's'}` : 'Delete section'}
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          loading={deleteCategory.isPending}
          onPress={() => {
            if (readOnly || !canEdit) return;
            setConfirmDelete(false);
            deleteCategory.mutate(cat.id);
          }}
        />
        <PillButton label="Keep it" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setConfirmDelete(false)} />
      </PopupCard>
    </View>
  );
}

export function VendorMenuScreen({ navigation }: any) {
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const menuQ = useVendorMenu();
  const pull = usePullToRefresh(menuQ.refetch); // the spinner follows the pull, never a background refetch (lib/pullToRefresh)
  const createCategory = useCreateCategory();
  const { owner, store } = useVendorProfile();
  const myRole = safeVendorRole(owner?.myRole);
  const canEdit = myRole === 'OWNER' || myRole === 'MANAGER';
  const cat = catalogueMeta(store?.vendorType); // R1: title + prompts named for the type
  const [newCat, setNewCat] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const categories: any[] = menuQ.data ?? [];
  const catOptions = categories.map((c) => ({ id: c.id, name: c.name }));
  const allItems = categories.flatMap((category) => category.items ?? []);
  const soldOutCount = allItems.filter((item: any) => item.isAvailable === false).length;
  const activeCount = Math.max(0, allItems.length - soldOutCount);
  const visibleCategories = selectedCategoryId
    ? categories.filter((category) => category.id === selectedCategoryId)
    : categories;
  const selectedCategoryExists = !selectedCategoryId || categories.some((category) => category.id === selectedCategoryId);

  useEffect(() => {
    if (!selectedCategoryExists) setSelectedCategoryId(null);
  }, [selectedCategoryExists]);

  const addCategory = () => {
    if (readOnly || !canEdit) return;
    const name = newCat.trim();
    if (name.length < 1) return;
    createCategory.mutate(
      { name },
      {
        onSuccess: () => {
          setNewCat('');
          setAddingCategory(false);
        },
      },
    );
  };

  return (
    <Screen>
      <SubHeader title={canEdit ? cat.label : 'Availability'} navigation={navigation} hideBack />
      {menuQ.isLoading ? (
        <LoadingBlock />
      ) : menuQ.isError && !menuQ.data ? (
        <ErrorState message="We couldn't load your menu. Check your connection and try again." onRetry={() => menuQ.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={() => { void pull.onRefresh(); }} tintColor={color.brand[500]} />}
        >
          {menuQ.isError && menuQ.data ? (
            <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
              Showing the menu from the last check. Check your connection and try again.
            </T>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space.md, marginBottom: space.lg }}>
            <View style={{ flex: 1 }}>
              <T variant="micro" tone="muted">
                YOUR MENU
              </T>
              <T variant="heading" style={{ marginTop: space.xs }}>
                {activeCount} active · {soldOutCount} sold out
              </T>
            </View>
            {soldOutCount > 0 ? <TonePill label={`${soldOutCount} SOLD OUT`} tone="warning" /> : null}
          </View>

          {canEdit ? (
            <>
              <View style={{ flexDirection: 'row', gap: space.md, marginBottom: space.md }}>
                <PillButton
                  label="Bulk import"
                  icon="upload-cloud"
                  variant="outline"
                  size="md"
                  style={{ flex: 1 }}
                  disabled={readOnly}
                  onPress={() => navigation.navigate('VendorBulkImport')}
                />
                <PillButton
                  label="Add item"
                  icon="plus"
                  size="md"
                  style={{ flex: 1 }}
                  disabled={readOnly || catOptions.length === 0}
                  onPress={() => navigation.navigate('VendorItemEditor', { categories: catOptions })}
                />
              </View>
              {catOptions.length === 0 ? (
                <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
                  Add a section first, then add individual items.
                </T>
              ) : null}
            </>
          ) : (
            <T variant="caption" tone="muted" style={{ marginBottom: space.lg }}>
              Floor access: switch items on or sold out. Editing stays with a manager or owner.
            </T>
          )}

          {categories.length > 0 ? (
            <View style={{ marginBottom: space.lg }}>
              <T variant="micro" tone="muted" style={{ marginBottom: space.sm }}>
                SECTIONS
              </T>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
                <Chip
                  label={`All · ${allItems.length}`}
                  selected={selectedCategoryId === null}
                  onPress={() => setSelectedCategoryId(null)}
                />
                {categories.map((category) => (
                  <Chip
                    key={category.id}
                    label={`${category.name} · ${(category.items ?? []).length}`}
                    selected={selectedCategoryId === category.id}
                    onPress={() => setSelectedCategoryId(category.id)}
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}

          {/* Inventory-first: goods vendors lead with stock health (self-hides
              for restaurants/services, which don't track stock). */}
          <InventorySummaryCard categories={categories} />

          {canEdit ? (
            <View style={{ marginBottom: space.lg }}>
              {addingCategory ? (
                <Card>
                  <T variant="label" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                    New section
                  </T>
                  <InlineInput value={newCat} onChangeText={setNewCat} placeholder={cat.catPlaceholder} />
                  <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
                    <PillButton
                      label="Add section"
                      size="md"
                      style={{ flex: 1 }}
                      loading={createCategory.isPending}
                      disabled={readOnly || newCat.trim().length < 1}
                      onPress={addCategory}
                    />
                    <PillButton label="Cancel" variant="soft" size="md" style={{ flex: 1 }} onPress={() => setAddingCategory(false)} />
                  </View>
                </Card>
              ) : (
                <PillButton label="Add section" variant="soft" size="md" onPress={() => setAddingCategory(true)} />
              )}
            </View>
          ) : null}

          {canEdit ? <LowStockCard categories={categories} navigation={navigation} catOptions={catOptions} /> : null}

          {categories.length === 0 ? (
            <EmptyState
              icon="book-open"
              title={canEdit ? `Build your ${cat.label.toLowerCase()}` : 'No items to update'}
              body={canEdit ? 'Add a section, then start adding items.' : 'A manager or owner needs to add the first item.'}
            />
          ) : (
            visibleCategories.map((category) => (
              <View key={category.id} style={{ marginBottom: space.lg }}>
                <CategoryHeader cat={category} canEdit={canEdit} />
                {(category.items ?? []).length === 0 ? (
                  <T variant="label" tone="muted" style={{ marginBottom: space.md }}>
                    No items yet.
                  </T>
                ) : (
                  category.items.map((item: any) => (
                    <MenuItemRow
                      key={item.id}
                      item={item}
                      navigation={navigation}
                      categories={catOptions}
                      canEdit={canEdit}
                    />
                  ))
                )}
              </View>
            ))
          )}

          {/* [Wave 3 · ref 20] The reference's fuller promise, verified true
              before being written: proposeSubstitution (vendor) → the
              customer approves/rejects LIVE (hooks/customer.ts §5.3), with
              refund-line when nothing can swap. The screen may only ever
              claim what the rails actually do. */}
          {categories.length > 0 ? (
            <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
              Sold-out items are hidden from new orders. They appear again when you switch them on.
              If a current order has an item you mark sold out, the customer is asked to choose a
              replacement or the item is marked for a refund. The business handles any money directly.
            </T>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}
