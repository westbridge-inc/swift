export enum RatingType {
  CUSTOMER_TO_VENDOR = 'CUSTOMER_TO_VENDOR',
  CUSTOMER_TO_RIDER = 'CUSTOMER_TO_RIDER',
  CUSTOMER_TO_DRIVER = 'CUSTOMER_TO_DRIVER',
  RIDER_TO_CUSTOMER = 'RIDER_TO_CUSTOMER',
  DRIVER_TO_CUSTOMER = 'DRIVER_TO_CUSTOMER',
}

export interface Rating {
  id: string;
  orderId: string;
  raterId: string;
  rateeId?: string | null;
  vendorId?: string | null;
  type: RatingType;
  score: number;
  comment?: string | null;
  tags: string[];
  isPublic: boolean;
  createdAt: string;
}
