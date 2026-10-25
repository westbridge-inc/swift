# Signup continuation authority cutover

## Why this release cannot roll

The legacy API and the proof-bound API intentionally do not share a signup
authority protocol. Legacy instances store OTP records at `otp:<phone>` and
accept a phone-global `otp_verified:<phone>` registration window. The new API
uses hashed, cluster-slotted OTP/generation records and accepts only a random,
phone-bound, one-use continuation returned to the verifier.

Running both versions behind one load balancer can make a send and verify land
on incompatible key schemes. More importantly, any old instance can still
mint or accept the legacy phone-global registration authority. Therefore this
release requires a maintenance-window cutover in which every old API instance
stops serving before any new instance receives traffic. The repository's
production API workflow remains fail-closed until that procedure is automated
and independently reviewed.

## Required order

1. Record the exact release commit and require all current-base CI and review
   gates for that commit.
2. Put the public API into maintenance mode at the load balancer. Confirm that
   no new auth request can reach an application instance.
3. Drain in-flight HTTP requests, then stop every old API instance. Stop the
   matching old worker image as part of the existing mover-authority cutover.
4. Confirm no old process or automatic rollback target is serving. Do not
   delete Redis data: legacy OTP and registration-window keys expire on their
   existing five- and ten-minute clocks and the new binary ignores them.
5. Start the exact reviewed API and worker image. Keep public traffic closed
   until health, boot guards, migrations, and an isolated synthetic new-user
   OTP-to-register journey pass on that exact image.
6. Open traffic only to the new fleet. Verify existing-user OTP login, new-user
   registration, password reset, browser-cookie signup, and native signup.
7. Preserve timestamps, image digest, process census, health output, and the
   synthetic journey result in the release evidence packet.

## Rollback boundary

Before public traffic reaches the new binary, rollback may restart the exact
old image while maintenance mode remains active. After the new binary has
served an auth request, do not perform an automatic or mixed-fleet rollback.
Keep maintenance mode enabled, stop the new fleet, wait at least ten minutes
so both generations of ephemeral signup authority expire, and obtain an
incident-reviewed decision before an old image can serve again. Restoring the
old image also restores the original phone-global signup weakness, so the
preferred recovery is a corrected roll-forward release.

This runbook contains no production credentials or provider-specific values.
