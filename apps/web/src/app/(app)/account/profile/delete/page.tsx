'use client';

import { AccountBoundary } from '@/components/account/account-frame';
import { DeleteAccountFlow } from '@/components/account-deletion/delete-account-flow';

/** [WEB-DELETE] Account → Personal details → Delete my account, as the phone's Profile → Personal data. */
export default function DeleteAccountPage() {
  return <AccountBoundary path="/account/profile/delete"><DeleteAccountFlow area="customer" backHref="/account/profile" /></AccountBoundary>;
}
