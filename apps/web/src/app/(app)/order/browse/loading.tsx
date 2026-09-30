import { Bone, CategorySkeleton } from '@/components/customer-skeletons';
import { VendorGridSkeleton } from '@/components/order-ui';

export default function BrowseLoading() {
  return <div className="space-y-5"><Bone className="h-8 w-48" /><CategorySkeleton /><VendorGridSkeleton /></div>;
}
