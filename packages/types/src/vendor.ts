export enum VendorType {
  RESTAURANT = 'RESTAURANT',
  SUPERMARKET = 'SUPERMARKET',
}

export enum VendorStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  CLOSED = 'CLOSED',
}

export interface Vendor {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  description?: string | null;
  vendorType: VendorType;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  phone: string;
  email?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  region: string;
  latitude: number;
  longitude: number;
  isCurrentlyOpen: boolean;
  acceptingOrders: boolean;
  deliveryRadius: number;
  minOrderAmount: number;
  estimatedPrepTime: number;
  isVerified: boolean;
  isFeatured: boolean;
  averageRating: number;
  totalRatings: number;
  totalOrders: number;
  cuisineTypes: string[];
  tags: string[];
  status: VendorStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  vendorId: string;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  sortOrder: number;
  isActive: boolean;
  items?: Item[];
}

export interface Item {
  id: string;
  vendorId: string;
  categoryId: string;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  basePrice: number;
  isAvailable: boolean;
  isPopular: boolean;
  sku?: string | null;
  unit?: string | null;
  stockQuantity?: number | null;
  dietaryTags: string[];
  allergens: string[];
  totalOrdered: number;
  sortOrder: number;
  optionGroups?: OptionGroup[];
}

export interface OptionGroup {
  id: string;
  itemId: string;
  name: string;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  options: Option[];
  sortOrder: number;
}

export interface Option {
  id: string;
  optionGroupId: string;
  name: string;
  additionalPrice: number;
  isDefault: boolean;
  isAvailable: boolean;
  sortOrder: number;
}

export interface OperatingHours {
  id: string;
  vendorId: string;
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
}
