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
  owner_national_id: 'Owner National ID',
  business_registration: 'Business Registration',
  food_handler_cert: "Food Handler's Certificate",
  selfie: 'Selfie',
};
const label = (docType: string) => DOC_LABELS[docType] ?? humanize(docType);
// Safe, always-present icons only.
const docIcon = (docType: string): keyof typeof MaterialCommunityIcons.glyphMap =>
  docType.includes('national_id') || docType.includes('licence') || docType === 'selfie'
    ? 'card-account-details-outline'
    : 'file-document-outline';

type DocStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | undefined;

export function DocumentUploadCard({
  role,
  docType,
  status,
  isNext,
}: {
  role: string;
  docType: string;
  status: DocStatus;
  isNext?: boolean;
}) {
  const upload = useUploadDocument(role);
  const approved = status === 'APPROVED';
  const pending = status === 'PENDING';
  const rejected = status === 'REJECTED';

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
    ? 'Approved'
    : pending
      ? 'Pending review'
      : rejected
        ? 'Rejected — tap to re-upload'
        : isNext
          ? 'Recommended next step'
          : 'Get started';

  return (
    <Pressable disabled={approved || upload.isPending} onPress={pick}>
      <Card className={isNext && !status ? 'mb-sm flex-row items-center border-brand-500' : 'mb-sm flex-row items-center'}>
        <View className="h-11 w-11 items-center justify-center rounded-full" style={{ backgroundColor: color.surface.subtle }}>
          <MaterialCommunityIcons
            name={approved ? 'check-decagram' : docIcon(docType)}
            size={20}
            color={approved ? color.success : color.brand[500]}
          />
        </View>
        <View className="ml-md flex-1">
          <Text className="text-xs text-text-secondary">{caption}</Text>
          <Text className="text-base font-semibold">{label(docType)}</Text>
        </View>
        {upload.isPending ? (
          <ActivityIndicator />
        ) : approved ? (
          <Badge label="Approved" tone="success" />
        ) : pending ? (
          <Badge label="In review" tone="brand" />
        ) : (
          <Feather name="chevron-right" size={20} color={color.text.muted} />
        )}
      </Card>
    </Pressable>
  );
}
