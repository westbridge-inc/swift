// Money truth: order value is context, never Swift revenue. The current admin
// aggregates do not account consistently for waivers, custom rates and USD
// pricing, so this surface refuses to turn them into an income claim.

export default function Money() {
  return (
    <div className="max-w-3xl">
      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-neutral-500">Business subscription revenue</p>
        <div className="rounded-xl border border-[var(--swift-line)] bg-[var(--swift-warning-soft)] p-5 text-sm text-[var(--swift-deep)]">
          <p className="font-semibold">No authoritative revenue aggregate is exposed.</p>
          <p className="mt-1">
            Current admin totals do not consistently apply fee waivers, custom rates and USD pricing, so Mission Control does not show them as collected income.
          </p>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Swift holds no order money. Delivery fees and order value are not platform revenue, and riders never pay a subscription.
        </p>
      </div>
    </div>
  );
}
