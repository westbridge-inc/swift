import type { Vendor } from '@prisma/client';
import { safeMmgPayUrl } from './mmg-pay-url';
import { safePublicPhone } from './vendor-public-phone';

// ---------------------------------------------------------------------------
// THE public vendor card — ONE projection, every discovery surface.
//
// Home, browse and favourites all handed the WHOLE Vendor row to the client:
// `phone` (the operational/account contact — frequently the owner's own line,
// which is also their login-OTP number), `email` (no public counterpart at
// all), `ownerId`, `qrSlug`, and the staged MMG-link fields. A guest could
// drain the whole directory anonymously.
//
// This is the ONE allow-list for the card. A new Vendor column does NOT ride
// out to a customer until it is deliberately added here — and the wire-shape
// tests pin `VENDOR_CARD_PUBLIC_FIELDS`, so a field added to the model without
// a decision here fails the suite by default.
//
// `publicPhone` and `mmgPayUrl` are the two fields a vendor CHOOSES to publish
// (call-me number, own MMG pay link — a public pay URL, not a secret). Both
// are re-validated here rather than trusted: a stored row is untrusted until
// the boundary that hands it to a stranger's dialler or browser. Bad row -> no
// button, never a wrong call or a wrong pay destination. `status` never
// leaves; it only decides whether the platform may advertise a way to reach
// the store at all (SUSPENDED / PENDING_APPROVAL stores get no call button,
// exactly as the storefront detail route already behaves).
// ---------------------------------------------------------------------------

type VendorCardSource = Pick<
  Vendor,
  | 'id' | 'name' | 'slug' | 'description' | 'vendorType' | 'logoUrl' | 'coverImageUrl'
  | 'addressLine1' | 'addressLine2' | 'city' | 'region' | 'latitude' | 'longitude'
  | 'isCurrentlyOpen' | 'acceptingOrders' | 'deliveryRadius' | 'minOrderAmount'
  | 'estimatedPrepTime' | 'isFeatured' | 'averageRating' | 'totalRatings' | 'totalOrders'
  | 'cuisineTypes' | 'tags' | 'status' | 'publicPhone' | 'mmgPayUrl'
>;

/** The exact public card keys, in one place so the wire-shape tests can pin
 *  them. A new sensitive Vendor field leaks only if someone adds it here. */
export const VENDOR_CARD_PUBLIC_FIELDS = [
  'id', 'name', 'slug', 'description', 'vendorType', 'logoUrl', 'coverImageUrl',
  'addressLine1', 'addressLine2', 'city', 'region', 'latitude', 'longitude',
  'isCurrentlyOpen', 'acceptingOrders', 'deliveryRadius', 'minOrderAmount',
  'estimatedPrepTime', 'isFeatured', 'averageRating', 'totalRatings', 'totalOrders',
  'cuisineTypes', 'tags', 'publicPhone', 'mmgPayUrl',
] as const;

export interface VendorCardView {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  vendorType: Vendor['vendorType'];
  logoUrl: string | null;
  coverImageUrl: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string;
  latitude: number;
  longitude: number;
  isCurrentlyOpen: boolean;
  acceptingOrders: boolean;
  deliveryRadius: number;
  minOrderAmount: number | null;
  estimatedPrepTime: number;
  isFeatured: boolean;
  averageRating: number;
  totalRatings: number;
  totalOrders: number;
  cuisineTypes: string[];
  tags: string[];
  publicPhone: string | null;
  mmgPayUrl: string | null;
}

export function vendorCardView(vendor: VendorCardSource): VendorCardView {
  const advertisesContact = vendor.status !== 'SUSPENDED' && vendor.status !== 'PENDING_APPROVAL';
  return {
    id: vendor.id,
    name: vendor.name,
    slug: vendor.slug,
    description: vendor.description,
    vendorType: vendor.vendorType,
    logoUrl: vendor.logoUrl,
    coverImageUrl: vendor.coverImageUrl,
    addressLine1: vendor.addressLine1,
    addressLine2: vendor.addressLine2,
    city: vendor.city,
    region: vendor.region,
    latitude: vendor.latitude,
    longitude: vendor.longitude,
    isCurrentlyOpen: vendor.isCurrentlyOpen,
    acceptingOrders: vendor.acceptingOrders,
    deliveryRadius: vendor.deliveryRadius,
    minOrderAmount: vendor.minOrderAmount == null ? null : Number(vendor.minOrderAmount),
    estimatedPrepTime: vendor.estimatedPrepTime,
    isFeatured: vendor.isFeatured,
    averageRating: vendor.averageRating,
    totalRatings: vendor.totalRatings,
    totalOrders: vendor.totalOrders,
    cuisineTypes: vendor.cuisineTypes,
    tags: vendor.tags,
    publicPhone: advertisesContact ? safePublicPhone(vendor.publicPhone) : null,
    mmgPayUrl: safeMmgPayUrl(vendor.mmgPayUrl),
  };
}
