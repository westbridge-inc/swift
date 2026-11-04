'use client';

import { DeleteAccountFlow } from '@/components/account-deletion/delete-account-flow';

/** [WEB-DELETE] Account → Delete my account for a rider or driver, as the phone's Personal data. */
export default function DeleteAccountPage() {
  return <DeleteAccountFlow area="mover" backHref="/portal/account" />;
}
