# Services catalogue and appointment readiness

This tranche changes discovery and category selection. It does not certify the
service-job lifecycle, appointment capacity, document review, or payments.

## One catalogue

`GET /api/v1/services/catalog` publishes the API's canonical IDs, display names,
category groups, risk tier, currently available booking modes, current availability, and
document-policy metadata. Customer discovery and provider registration consume
this endpoint. Provider registration accepts canonical categories rather than
an unrestricted text field. The API still validates every save and request.

The existing 23 service IDs and aliases are retained. Categories with unresolved
service-specific policy topics, including barber, hairdresser and tutor, are
held at the profile, verification and quote-request gates. Customer discovery
and new provider selection show only currently available categories. A quote
request does not reserve an appointment.

Beauty salon, nail technician, makeup artist, photographer, lawyer and
accountant are added as catalogue entries whose new profiles and requests are
unavailable pending implementation of the appropriate checks. Lawyers and
accountants remain quote-first; they are never represented as zero-price items
or free consultations. The verification status explicitly marks a stored held
profile as unavailable, and generic identity evidence cannot activate it.

## Documents

Actual upload requirements remain in the existing country configuration:
`SERVICE_PROVIDER` plus `SERVICE_PROVIDER_TRADE_<ID>`. Identity/background,
trade or professional standing, premises/hygiene, and safeguarding requirements
are different concerns. Catalogue metadata identifies their relevant review
topics; a topic marked `POLICY_REVIEW_REQUIRED` is not a legal finding, upload
requirement, approved credential or automated verification.

Before opening a pending category, implement and review its country-specific
evidence types, applicant upload flow, reviewer authority, expiry and revocation,
and prove the public-listability/job gate against that checklist. Do not merely
remove it from the pending set. Requirements can depend on work scope, premises
and geography; this static catalogue does not make a Guyana legal-compliance
claim. The current UI renders the existing authoritative document checklist
after supported provider registration. A held profile instead displays a
policy-hold message and does not promise approval from an empty checklist.

## Appointment gate

The public `modes` field lists `QUOTE_JOB` only. `appointmentsEnabled` remains
false in every category. The new discovery UI cannot enter fixed-slot checkout.
Existing appointment routes elsewhere in the app are unchanged by this tranche
and remain open audit findings.

Required appointment work before enabling this discovery path:

- Real-instant/timezone-safe slot validation in Guyana.
- Interval/resource exclusion, including overlapping different offerings and
  second-level timestamp variants.
- Exclusive expiring hold before external payment instructions, with losing
  slot recovery and direct-business repayment/dispute handling.
- Order/Booking completion, cancellation and rescheduling coupling.
- Correct customer/provider notification destinations and recoverable delivery.
- Native and web journeys through availability, confirmation, reschedule,
  cancellation, no-show, completion and restart recovery.

These requirements are tracked by REPORT-SERVICES-APPOINTMENTS-20260920
(SA-02/03/04/08/09/12). This catalogue is not evidence that any has passed.

## Integration boundaries

PR #1253's frozen service-job candidate remains separately owned. This tranche
does not edit its route file, job transaction/transition helpers, client job
hooks or job screen. It extracts the catalogue helpers from services.service.ts
into service-catalog.ts and re-exports their existing names. A new standalone
catalogue route plugin is registered in app.ts. The only shared-type index
change is a type export; preserve #1253's independent additions on integration.

The weekly-fee lane separately owns provider subscription enforcement.
Qualification decisions and general document review remain with their existing
owners. No schema, migration, payment, fee, or country checklist is changed here.
