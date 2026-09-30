import { apiFetch } from './auth';
import type { DocStatus } from './mover-api';

export type ChecklistRole = 'MOVER' | 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE' | 'SERVICE_PROVIDER';
export type VerificationStatus = DocStatus & { categoryUnavailable?: boolean };

export async function getDocumentChecklist(role: ChecklistRole, vehicleType?: string): Promise<VerificationStatus> {
  const params = new URLSearchParams({ role });
  if (role === 'MOVER' && vehicleType) params.set('vehicleType', vehicleType);
  const { data } = await apiFetch(`/api/v1/verification/status?${params}`, undefined, { redirectOnExpired: false });
  if (!data || !Array.isArray(data.checklist) || !data.checklist.every((item: unknown) => typeof item === 'string')
    || !Array.isArray(data.missing) || !Array.isArray(data.documents)) {
    throw new Error('Could not confirm your required documents. Please try again.');
  }
  return data as VerificationStatus;
}

// Same labels as the phone's DocumentUploadCard; requirements always come
// from the API, including country, vehicle and trade-specific differences.
const labels: Record<string, string> = {
  national_id: 'National ID', drivers_licence: "Driver's Licence", vehicle_registration: 'Vehicle Registration',
  vehicle_insurance: 'Vehicle Insurance', hire_car_permit: 'Hire-Car Permit', road_service_licence: 'Road Service Licence',
  vehicle_plate_photo: 'Vehicle Plate Photo', police_clearance: 'Police Clearance Certificate', fitness_cert: 'Fitness Certificate',
  vehicle_exterior_photo: 'Car Exterior Photo (H plate + yellow visible)', owner_national_id: 'Owner National ID',
  business_registration: 'Business Registration', tin_certificate: 'TIN Certificate', gra_restaurant_licence: 'GRA Restaurant Licence',
  food_handler_cert: "Food Handler's Certificate", storefront_photo: 'Storefront Photo', selfie: 'Selfie',
};
export const documentLabel = (type: string) => labels[type] ?? type.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
