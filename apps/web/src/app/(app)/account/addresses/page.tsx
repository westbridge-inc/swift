import { AccountBoundary } from '@/components/account/account-frame';
import { SavedAddresses } from '@/components/account/saved-addresses';

export default function Page() {
  return <AccountBoundary path="/account/addresses"><SavedAddresses /></AccountBoundary>;
}
