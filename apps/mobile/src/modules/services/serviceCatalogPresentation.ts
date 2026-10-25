import type { ServiceCategory } from '@swift/types';

export const SERVICE_GROUP_LABELS: Record<ServiceCategory['group'], string> = {
  HOME_AND_TRADES: 'Home, repairs & trades',
  PERSONAL_CARE: 'Hair, beauty & personal care',
  EDUCATION: 'Lessons & tutoring',
  EVENTS: 'Food, events & photography',
  PROFESSIONAL: 'Professional consultations',
};

export function selectedServiceCategory(categories: ServiceCategory[], id?: string): ServiceCategory | undefined {
  return categories.find((category) => category.id === id);
}

/** Discovery only shows categories that currently accept quote requests. */
export function customerServiceCategories(categories: ServiceCategory[]): ServiceCategory[] {
  return categories.filter((category) => category.quoteRequestsEnabled && category.modes.includes('QUOTE_JOB'));
}

export function providerVerificationPresentation(
  status: { roleVerified?: boolean; categoryUnavailable?: boolean } | undefined,
  isVerified: boolean,
): { label: string; description: string; live: boolean } {
  if (status?.categoryUnavailable) {
    return {
      label: 'Checks pending',
      description: 'This service is unavailable while its required checks are prepared.',
      live: false,
    };
  }
  if (isVerified) return { label: 'Live', description: 'Customers can find you and send job requests.', live: true };
  return {
    label: status?.roleVerified ? 'Activating' : 'Not live yet',
    description: 'Complete the required checks below before customers can find you.',
    live: false,
  };
}

export function serviceRequestTrade(categories: ServiceCategory[], id?: string): string | undefined {
  const category = selectedServiceCategory(categories, id);
  return category?.quoteRequestsEnabled && category.modes.includes('QUOTE_JOB') ? category.id : undefined;
}
