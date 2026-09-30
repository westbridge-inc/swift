import { AccountBoundary } from '@/components/account/account-frame';
import { Safety } from '@/components/account/safety';

export default function Page() {
  return <AccountBoundary path="/account/safety"><Safety /></AccountBoundary>;
}
