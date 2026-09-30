import { AccountBoundary } from '@/components/account/account-frame';
import { ProfileSettings } from '@/components/account/profile-settings';

export default function Page() {
  return <AccountBoundary path="/account/profile"><ProfileSettings /></AccountBoundary>;
}
