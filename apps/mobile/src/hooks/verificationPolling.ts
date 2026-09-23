/** A policy-held category cannot become verified through polling. */
export function verificationRefetchInterval(
  status: { roleVerified?: boolean; categoryUnavailable?: boolean } | undefined,
): number | false {
  return status?.roleVerified || status?.categoryUnavailable ? false : 15_000;
}
