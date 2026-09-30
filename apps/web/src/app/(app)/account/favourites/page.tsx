import { AccountBoundary } from '@/components/account/account-frame';
import { Favourites } from '@/components/account/favourites';

export default function Page() {
  return <AccountBoundary path="/account/favourites"><Favourites /></AccountBoundary>;
}
