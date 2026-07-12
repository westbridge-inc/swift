import { Pressable, View, ActivityIndicator } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Card, Badge } from '../ui';
import { useUploadDocument } from '../../hooks/verification';

function humanize(docType: string) {
  return docType.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Friendly names for known checklist docs; unknown slugs fall back to humanize().
const DOC_LABELS: Record<string, string> = {
  national_id: 'National ID',
  drivers_licence: "Driver's Licence",
  vehicle_registration: 'Vehicle Registration',
  vehicle_insurance: 'Vehicle Insurance',
  hire_car_permit: 'Hire-Car Permit',
  vehicle_plate_photo: 'Vehicle Plate Photo',
  police_clearance: 'Police Clearance Certificate',
  fitness_cert: 'Fitness Certificate',
  vehicle_exterior_photo: 'Car Exterior Photo (H plate + yellow visible)',
  owner_national_id: 'Owner National ID',
  business_registration: 'Business Registration',
  tin_certificate: 'TIN Certificate',
  gra_restaurant_licence: 'GRA Restaurant Licence',
  food_handler_cert: "Food Handler's Certificate",
  storefront_photo: 'Storefront Photo',
  selfie: 'Selfie',
};
const label = (docType: string) => DOC_LABELS[docType] ?? humanize(docType);
// Safe, always-present icons only.
const docIcon = (docType: string): keyof typeof MaterialCommunityIcons.glyphMap =>
  docType.includes('photo') || docType === 'selfie'
    ? 'camera-outline'
    : docType.includes('national_id') || docType.includes('licence')
      ? 'card-account-details-outline'
      : 'file-document-outline';

type DocStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | 'EXPIRED' | undefined;

const DAY_MS = 24 * 60 * 60 * 1000;
// Mirrors the API's renewal window: re-submission opens 30 days before expiry.
const RENEWAL_WINDOW_DAYS = 30;

export function DocumentUploadCard({
  role,
  docType,
  status,
  expiresAt,
  isNext,
}: {
  role: string;
  docType: string;
  status: DocStatus;
  expiresAt?: string | null;
  isNext?: boolean;
}) {
  const upload = useUploadDocument(role);
  const expired = status === 'EXPIRED';
  const pending = status === 'PENDING';
  const rejected = status === 'REJECTED';
  const daysLeft = expiresAt ? Math.ceil((new Date(expiresAt).getTime() - Date.now()) / DAY_MS) : null;
  const expiringSoon = status === 'APPROVED' && daysLeft != null && daysLeft <= RENEWAL_WINDOW_DAYS;
  // An approved doc inside its renewal window re-opens for upload.
  const approved = status === 'APPROVED' && !expiringSoon;

  const pick = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    upload.mutate({
      docType,
      file: { uri: a.uri, name: a.fileName ?? `${docType}.jpg`, type: a.mimeType ?? 'image/jpeg' },
    });
  };

  const caption = approved
    ? daysLeft != null
      ? `Approved — valid until ${new Date(expiresAt!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
      : 'Approved'
    : expiringSoon
      ? `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — tap to upload the renewal`
      : expired
        ? 'Expired — upload the renewal to keep operating'
        : pending
          ? 'Pending review'
          : rejected
            ? 'Rejected — tap to re-upload'
            : isNext
              ? 'Recommended next step'
              : 'Get started';

  return (
    <Pressable disabled={approved || pending || upload.isPending} onPress={pick}>
      <Card style={isNext && !status ? { borderColor: color.brand[500] } : undefined} className={isNext && !status ? 'mb-sm flex-row items-center' : 'mb-sm flex-row items-center'}>
        <View className="h-11 w-11 items-center justify-center rounded-full" style={{ backgroundColor: color.surface.subtle }}>
          <MaterialCommunityIcons
            name={approved ? 'check-decagram' : docIcon(docType)}
            size={20}
            color={approved ? color.success : expired || expiringSoon ? color.warning : color.brand[500]}
          />
        </View>
        <View className="ml-md flex-1">
          <Text className="text-xs text-text-secondary" style={expiringSoon || expired ? { color: color.warning } : undefined}>
            {caption}
          </Text>
          <Text className="text-base font-semibold">{label(docType)}</Text>
          {docType === 'national_id' || docType === 'owner_national_id' ? (
            <Text className="mt-0.5 text-xs text-text-muted">
              Face-matched against your profile selfie
            </Text>
          ) : null}
        </View>
        {upload.isPending ? (
          <ActivityIndicator />
        ) : approved ? (
          <Badge label="Approved" tone="success" />
        ) : expired ? (
          <Badge label="Expired" tone="error" />
        ) : pending ? (
          <Badge label="In review" tone="brand" />
        ) : (
          <Feather name="chevron-right" size={20} color={color.text.muted} />
        )}
      </Card>
    </Pressable>
  );
}
