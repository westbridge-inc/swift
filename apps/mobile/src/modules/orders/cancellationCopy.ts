export function appointmentCancellationResolutionCopy(status: string): string {
  return status === 'PENDING'
    ? 'This booking request is now with the provider. Contact the provider or Swift support if it needs to change.'
    : 'The provider has accepted this booking. Contact the provider or Swift support if it now needs to change.';
}
