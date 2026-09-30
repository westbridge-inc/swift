import { VendorGridSkeleton } from '@/components/order-ui';

export default function SearchLoading() {
  return <div className="space-y-5"><div className="h-[50px] rounded-full border border-black/10 bg-white" /><VendorGridSkeleton /></div>;
}
