import type { FeeStatusState } from './weeklyFee';

// [FEE-STATUS · owner 25 Oct 2026] The short word for a pill beside the weekly fee. The phone's own file
// (not lib/weeklyFee, which is byte-identical with the web's weekly-fee page module and is kept small for
// the web perf budget); the web store console's copy is lib/subscription-words FEE_STATUS_PILL, and
// apps/web subscription-words.test pins the two together.
/** The short word for a pill beside the fee, and its tone. Never the code, never "Active" on a week that is due. */
export function feeStatusPill(state: FeeStatusState): { label: string; tone: 'success' | 'warning' | 'error' | 'brand' | 'neutral' } {
  return ({
    TRIAL: { label: 'Free trial', tone: 'brand' }, PAID: { label: 'Paid', tone: 'success' }, COVERED: { label: 'Paid', tone: 'success' },
    DUE: { label: 'Payment due', tone: 'warning' }, CHECKING: { label: 'Checking payment', tone: 'warning' }, FEE_PAUSED: { label: 'Fee paused', tone: 'neutral' },
    SUSPENDED: { label: 'Suspended', tone: 'error' }, INACTIVE: { label: 'Inactive', tone: 'error' }, STOPPED: { label: 'Billing stopped', tone: 'neutral' },
    CLOSED: { label: 'Closed', tone: 'neutral' }, UNKNOWN: { label: 'Status unavailable', tone: 'neutral' },
  } as const)[state] ?? { label: 'Status unavailable', tone: 'neutral' };
}
