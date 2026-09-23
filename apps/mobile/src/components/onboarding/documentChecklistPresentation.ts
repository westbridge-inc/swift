export function emptyChecklistCopy(status: { categoryUnavailable?: boolean }): { title: string; body: string } {
  if (status.categoryUnavailable) {
    return {
      title: 'Service checks pending',
      body: 'This service is unavailable while its required checks are prepared. You cannot receive requests yet.',
    };
  }
  return {
    title: 'Verification steps unavailable',
    body: 'We cannot confirm your requirements right now. Try again later.',
  };
}
