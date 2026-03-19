/**
 * Validate Guyana phone number.
 */
export function isValidGuyanaPhone(phone: string): boolean {
  const cleaned = phone.replace(/\D/g, '');
  // +592 followed by 7 digits
  return /^592\d{7}$/.test(cleaned) || /^\d{7}$/.test(cleaned);
}

/**
 * Validate email.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Validate OTP (6 digits).
 */
export function isValidOtp(otp: string): boolean {
  return /^\d{6}$/.test(otp);
}
