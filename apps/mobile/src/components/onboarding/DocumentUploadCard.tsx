import { Alert, Pressable, View, ActivityIndicator } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Card, Badge } from '../ui';
import { useUploadDocument } from '../../hooks/verification';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
} from '../../stores/authStore';
import type { AuthSessionSnapshot } from '../../lib/authSession';

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
  road_service_licence: 'Road Service Licence',
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
/** Friendly document name for other surfaces (suspension banners etc.). */
export const docLabel = label;
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
  submittedAt,
  reviewNote,
  isNext,
}: {
  role: string;
  docType: string;
  status: DocStatus;
  expiresAt?: string | null;
  submittedAt?: string | null;
  reviewNote?: string | null;
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

  const send = (a: ImagePicker.ImagePickerAsset, authSession: AuthSessionSnapshot) =>
    upload.mutate({
      docType,
      file: { uri: a.uri, name: a.fileName ?? `${docType}.jpg`, type: a.mimeType ?? 'image/jpeg' },
      authSession,
    });

  const fromCamera = async () => {
    try {
      const owner = requireAuthSessionSnapshot();
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      requireAuthSessionForPrincipal(owner);
      if (!perm.granted) return;
      const res = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      requireAuthSessionForPrincipal(owner);
      if (!res.canceled && res.assets?.[0]) send(res.assets[0], owner);
    } catch (cameraError) {
      if (!(cameraError instanceof AuthSessionBoundaryError)) throw cameraError;
    }
  };

  const fromLibrary = async () => {
    try {
      const owner = requireAuthSessionSnapshot();
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      requireAuthSessionForPrincipal(owner);
      if (!perm.granted) return;
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
      });
      requireAuthSessionForPrincipal(owner);
      if (!res.canceled && res.assets?.[0]) send(res.assets[0], owner);
    } catch (libraryError) {
      if (!(libraryError instanceof AuthSessionBoundaryError)) throw libraryError;
    }
  };

  // Docs are photographed at the counter/kerb more often than they sit in the
  // gallery — offer the camera first, library as the alternative.
  const pick = () =>
    Alert.alert(label(docType), 'Add a clear, well-lit photo. All corners visible, no glare.', [
      { text: 'Take photo', onPress: fromCamera },
      { text: 'Choose from library', onPress: fromLibrary },
      { text: 'Cancel', style: 'cancel' },
    ]);

  // The server's rejection reason is the fix instruction — surface it verbatim.
  const uploadErr = upload.isError
    ? ((upload.error as any)?.response?.data?.error?.message ?? 'Upload failed — tap to try again')
    : null;

  const caption = uploadErr
    ? uploadErr
    : approved
      ? daysLeft != null
        ? `Approved — valid until ${new Date(expiresAt!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
        : 'Approved'
      : expiringSoon
        ? `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — tap to upload the renewal`
        : expired
          ? 'Expired — upload the renewal to keep operating'
          : pending
            ? submittedAt
              ? `Submitted ${new Date(submittedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} — in review`
              : 'In review'
            : rejected
              ? reviewNote
                ? `Rejected: ${reviewNote} — tap to re-upload`
                : 'Rejected — tap to re-upload'
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
          <Text
            className="text-xs text-text-secondary"
            style={uploadErr || rejected ? { color: color.error } : expiringSoon || expired ? { color: color.warning } : undefined}
          >
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
        ) : rejected ? (
          <Badge label="Rejected" tone="error" />
        ) : pending ? (
          <Badge label="In review" tone="brand" />
        ) : (
          <Feather name="chevron-right" size={20} color={color.text.muted} />
        )}
      </Card>
    </Pressable>
  );
}
