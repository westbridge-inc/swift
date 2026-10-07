/**
 * [NO-DEAD-ENDS · owner, 6 Oct] Why GO snapped back, and the button that fixes it.
 *
 * The mover home shows the server's refusal under the switch. Only the two
 * liveness refusals came with a button; documents, the weekly fee and a
 * safety review were sentences with no way forward from where the person
 * stood. Each refusal code now maps to the one screen that resolves it (every
 * route is registered in the mover stack). Unknown codes get no button: the
 * sentence stands alone, as before. Pure, so it is unit-testable.
 */
export interface GoOnlineDoor {
  label: string;
  route: 'LivenessCheck' | 'GetHelp' | 'MoverDocuments' | 'WeeklyFee';
  params?: Record<string, unknown>;
}

export function goOnlineDoorFor(code: string | undefined, profile: 'RIDER' | 'DRIVER'): GoOnlineDoor | null {
  switch (code) {
    case 'LIVENESS_CHECK_REQUIRED':
      return { label: 'Take the selfie check', route: 'LivenessCheck', params: { profile } };
    case 'LIVENESS_LOCKED':
      return { label: 'Contact support', route: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Identity check locked my account' } };
    case 'VERIFICATION_REQUIRED':
      return { label: 'Open Documents', route: 'MoverDocuments' };
    case 'SUBSCRIPTION_PAST_DUE':
    case 'SUBSCRIPTION_SUSPENDED':
    case 'SUBSCRIPTION_REQUIRED':
      return { label: 'Open Weekly fee', route: 'WeeklyFee' };
    case 'SAFETY_SUSPENDED':
      return { label: 'Contact support', route: 'GetHelp', params: { category: 'SAFETY', subject: 'Responding to a safety review on my account' } };
    default:
      return null;
  }
}
