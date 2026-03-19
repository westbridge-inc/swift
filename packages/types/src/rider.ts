export enum RiderType {
  DELIVERY = 'DELIVERY',
  COURIER = 'COURIER',
  BOTH = 'BOTH',
}

export enum VehicleType {
  BICYCLE = 'BICYCLE',
  MOTORCYCLE = 'MOTORCYCLE',
  CAR = 'CAR',
}

export interface Rider {
  id: string;
  userId: string;
  riderType: RiderType;
  vehicleType: VehicleType;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  vehicleYear?: number | null;
  vehicleColor?: string | null;
  licensePlate?: string | null;
  documentsVerified: boolean;
  isOnline: boolean;
  isAvailable: boolean;
  currentLat?: number | null;
  currentLng?: number | null;
  lastLocationUpdate?: string | null;
  currentOrderId?: string | null;
  totalDeliveries: number;
  totalCourierJobs: number;
  averageRating: number;
  totalRatings: number;
  completionRate: number;
  createdAt: string;
  updatedAt: string;
}

export interface Driver {
  id: string;
  userId: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleYear: number;
  vehicleColor: string;
  licensePlate: string;
  vehicleCapacity: number;
  documentsVerified: boolean;
  isOnline: boolean;
  isAvailable: boolean;
  currentLat?: number | null;
  currentLng?: number | null;
  lastLocationUpdate?: string | null;
  currentRideId?: string | null;
  totalRides: number;
  averageRating: number;
  totalRatings: number;
  acceptanceRate: number;
  cancellationRate: number;
  createdAt: string;
  updatedAt: string;
}
