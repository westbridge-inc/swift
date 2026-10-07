import { Bone, CategorySkeleton } from '@/components/customer-skeletons';
import { VendorGridSkeleton } from '@/components/order-ui';

export default function BrowseLoading() {
  return <div className="flex flex-col gap-4"><div><Bone className="h-[14px] w-28" /><Bone className="mt-1 h-7 w-48" /></div><CategorySkeleton /><VendorGridSkeleton /></div>;
}
