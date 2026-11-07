'use client';

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LEGAL_ACCEPTED_EVENT } from '@/lib/legal-acceptance';
import { getProviderApproval, getProviderFee } from '@/lib/provider-fee-api';

/** The portal's provider section: shown only to a person with a provider profile. Accepting the agreement (the site's
 *  legal gate) reads the pro's standing and fee again (REVIEW-F #2231 S3-4). */
export function useProviderFee() {
  const client = useQueryClient();
  useEffect(() => {
    const again = () => { void client.invalidateQueries({ queryKey: ['provider-fee'] }); void client.invalidateQueries({ queryKey: ['provider-approval'] }); };
    window.addEventListener(LEGAL_ACCEPTED_EVENT, again);
    return () => window.removeEventListener(LEGAL_ACCEPTED_EVENT, again);
  }, [client]);
  const fee = useQuery({ queryKey: ['provider-fee'], queryFn: getProviderFee });
  const approval = useQuery({ queryKey: ['provider-approval'], queryFn: getProviderApproval, enabled: !!fee.data });
  // [REVIEW-F/M #2238 N1] A failed approval read is an error to retry, never "starts after approval" to an approved pro.
  return { fee, approval, isVerified: approval.data?.isVerified, approvalLoading: approval.isLoading };
}
