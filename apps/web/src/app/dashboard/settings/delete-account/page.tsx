'use client';

import { DeleteAccountFlow } from '@/components/account-deletion/delete-account-flow';

/** [WEB-DELETE] Account → Delete my account (a store owner: Request account closure), as the phone's Personal data. */
export default function DeleteAccountPage() {
  return <DeleteAccountFlow area="store" backHref="/dashboard/settings" />;
}
