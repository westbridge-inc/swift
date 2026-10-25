import { AccountBoundary } from '@/components/account/account-frame';
import { Help } from '@/components/account/help';

export default async function Page({ searchParams }: { searchParams: Promise<{ orderId?: string }> }) {
  const { orderId } = await searchParams;
  const order = typeof orderId === 'string' ? orderId.slice(0, 64) : '';
  return <AccountBoundary path={`/account/help${order ? `?orderId=${encodeURIComponent(order)}` : ''}`}><Help key={order} orderId={order} /></AccountBoundary>;
}
