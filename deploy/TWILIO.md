# Twilio SMS launch controls

Swift's backend sends OTP and alert SMS with a revocable Twilio API key. The
outbound contract is `NOTIFICATION_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`,
`TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, and `TWILIO_FROM`. The API key SID
and secret are the HTTP Basic username and password; the Account SID selects
the account in the Messages URL. The configured sender is an E.164 phone number.
Startup checks these formats locally, but cannot confirm that Twilio assigned
the number to this account. The master Auth Token is not used for sending.
If inbound webhook signature verification is added later, give its Auth Token
the separate name `TWILIO_WEBHOOK_AUTH_TOKEN` and keep that value out of the
outbound adapter.

The three identifiers (`TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`,
`TWILIO_FROM`) are settings in the host's `deploy/.env`. The API key secret is
entered into the host's encrypted store with
`deploy/owner/swift-secrets-prompt.command` (or `sudo swift-secrets set
TWILIO_API_KEY_SECRET` on the host, value on stdin) and wired in `deploy/.env`
as `TWILIO_API_KEY_SECRET_FILE=/run/secrets/TWILIO_API_KEY_SECRET`; keep an
owner controlled password manager backup. Keep sandbox values in a separate
entry and use them only for local or staging work. Never place live values in
this repository, a local `.env`, mobile or browser builds, or chat. The
examples contain variable names only; production boot refuses an incomplete
Twilio configuration. `deploy/preflight.sh` reads a candidate env file (and
the store with `--secrets-dir`) and runs that same boot guard, but cannot prove
credentials are valid or that delivery is enabled at Twilio.

Before enabling live sends, restrict Twilio outbound Messaging Geographic
Permissions to the approved launch destinations (Guyana uses +592); add other
countries only after launch approval. Set the provider account's available
spending limit or alerts and verify who receives those alerts. Swift's
`OTP_PHONE_DAILY_CAP` (default 8) and `OTP_GLOBAL_DAILY_CAP` (default 5000)
bound OTP volume; they do not cap every alert SMS. Set the global cap to an
explicit affordable number for the launch volume, then monitor provider usage.

For rotation, create a new application API key, set its SID in `deploy/.env`
and its secret with `swift-secrets set` (the previous encrypted version is kept
as `TWILIO_API_KEY_SECRET.cred.prev`), run `sudo systemctl restart
swift-secrets.service`, restart the backend, verify a controlled delivery and
its logs, then revoke the old key. Roll back by restoring the previous secret
version only while that key remains active. If either secret is exposed,
revoke that key first and issue a replacement.
