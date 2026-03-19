export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  RIDER = 'RIDER',
  DRIVER = 'DRIVER',
  VENDOR_OWNER = 'VENDOR_OWNER',
  ADMIN = 'ADMIN',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  BANNED = 'BANNED',
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  DEACTIVATED = 'DEACTIVATED',
}

export interface User {
  id: string;
  phone: string;
  email?: string | null;
  firstName: string;
  lastName: string;
  avatar?: string | null;
  roles: UserRole[];      // Changed from single role
  activeRole: UserRole;   // Currently active role
  status: UserStatus;
  isPhoneVerified: boolean;
  isEmailVerified: boolean;
  lastKnownLat?: number | null;
  lastKnownLng?: number | null;
  walletBalance: number;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string | null;
}

export enum RecoveryMethod {
  EMAIL = 'EMAIL',
  IDENTITY_VERIFICATION = 'IDENTITY_VERIFICATION',
  IN_PERSON = 'IN_PERSON',
}

export enum RecoveryStatus {
  PENDING = 'PENDING',
  EMAIL_SENT = 'EMAIL_SENT',
  DOCUMENTS_SUBMITTED = 'DOCUMENTS_SUBMITTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

export interface AccountRecovery {
  id: string;
  userId: string;
  method: RecoveryMethod;
  status: RecoveryStatus;
  newPhone?: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface Address {
  id: string;
  userId: string;
  label: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  instructions?: string | null;
  isDefault: boolean;
}
