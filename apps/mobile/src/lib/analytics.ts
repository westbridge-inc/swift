// ---------------------------------------------------------------------------
// Product analytics — DISABLED (SWIFT-AUD-D9-01).
//
// The prior PostHog client POSTed product events to a US endpoint
// (us.i.posthog.com) with distinct_id = the account id — a cross-border transfer
// of personal data that the Privacy Policy never disclosed, i.e. a Guyana Data
// Protection Act 2023 transparency + lawful-transfer gap. It also contradicted
// the declared stack.
//
// `track()` is kept as a no-op so every call site is unaffected — no event ever
// leaves the device. Re-enable analytics only once it is (a) disclosed in the
// Privacy Policy (processor, location, purpose), (b) consent-gated, and (c)
// configured with IP capture disabled.
// ---------------------------------------------------------------------------

/** No-op. Analytics is disabled pending DPA-compliant disclosure + consent. */
export function track(_event: string, _properties: Record<string, string | number | boolean> = {}): void {
  // intentionally does nothing — no data is collected or transmitted
}
