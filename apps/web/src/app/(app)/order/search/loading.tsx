import { VendorGridSkeleton } from '@/components/order-ui';

export default function SearchLoading() {
  return <div className="flex flex-col gap-4"><div className="h-12 max-w-[640px] rounded-full border border-[var(--swift-border)] bg-[var(--swift-card)]" /><VendorGridSkeleton label="Searching" /></div>;
}
