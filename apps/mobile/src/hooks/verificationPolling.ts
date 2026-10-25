/** A policy-held category cannot become verified through polling. */
export function verificationRefetchInterval(
  status: { roleVerified?: boolean; categoryUnavailable?: boolean } | undefined,
): number | false {
  return status?.roleVerified || status?.categoryUnavailable ? false : 15_000;
}

/** A held profile cannot become public through periodic verification refreshes. */
export function serviceProviderProfileRefetchInterval(
  profile: { isVerified?: boolean; categoryUnavailable?: boolean } | null | undefined,
): number | false {
  return profile && !profile.isVerified && !profile.categoryUnavailable ? 15_000 : false;
}
