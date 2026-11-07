'use client';

import { useQuery } from '@tanstack/react-query';
import { accountApi } from '@/components/account/account-api';
import { HelpPanel } from '@/components/account/help';

/**
 * [BUG-HUNT F04] A rider, a driver or a store on the website had no way to a person: the only Help form sits under
 * /account/help, which a partner never passes through and which shows Launching soon before launch. The same form and
 * the same requests, in the partner's own console. The console's session is the person's; no customer session is read.
 */
export function PartnerHelp() {
  const tickets = useQuery({ queryKey: ['partner-support'], queryFn: accountApi.tickets, retry: false, staleTime: 0, gcTime: 0 });
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-5">
      <h1 className="sw-title">Help</h1>
      <HelpPanel tickets={tickets} customerLinks={false} />
    </div>
  );
}
