/**
 * Format amount as GYD currency.
 */
export function formatGYD(amount: number): string {
  return `$${amount.toLocaleString()} GYD`;
}

/**
 * Format a phone number for display.
 */
export function formatPhone(phone: string): string {
  if (phone.startsWith('+592')) {
    const local = phone.slice(4);
    return `+592 ${local.slice(0, 3)} ${local.slice(3)}`;
  }
  return phone;
}

/**
 * Generate order number: SW-YYMMDD-XXX
 */
export function generateOrderNumber(sequence: number): string {
  const now = new Date();
  const yy = now.getFullYear().toString().slice(2);
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  return `SW-${yy}${mm}${dd}-${sequence.toString().padStart(3, '0')}`;
}

/**
 * Format distance in km.
 */
export function formatDistance(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(1)} km`;
}

/**
 * Format estimated time.
 */
export function formatETA(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}
