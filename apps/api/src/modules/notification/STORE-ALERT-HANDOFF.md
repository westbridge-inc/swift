# Store alert delivery authority

Store alerts reach the owner and current active staff. The first alert and both
re-ring jobs authorize each recipient again at inbox persistence and at outbound
handoff. A selected recipient list is not permission to deliver later.

## Revocation ordering

`withStoreAlertAuthority` locks the matching staff/user/store rows, or the
owner/user/store rows, with `FOR SHARE`. The inbox write commits in that same
transaction. Deletion, account changes and ownership changes therefore serialize
with the write.

For a socket or push, the transaction starts the actual emit or transport call
while those locks are held. Both promise handlers are attached immediately. The
transaction then releases its locks before waiting for the provider response.
The Expo adapter carries this callback to every chunk and retry, after its other
awaited checks. A deletion that commits first prevents handoff; a deletion waiting
on the locks commits after handoff. A message already handed off may arrive after
revocation and cannot be recalled by this code.

Authority reads have a four-second monotonic validity window and statement
timeout, inside a five-second transaction with a two-second acquisition limit.
The final check rejects a result that arrives after a process stall. Store-room
convergence likewise checks elapsed time before retaining or readmitting sockets.

## Rung ownership and expiry

The two-minute claim is renewed and checked by token before each handoff. Its
completion and cleanup also compare the token, so an old worker cannot overwrite
a replacement. The response deadline is checked after the final awaited guard,
including budget, membership and Redis work. Auto-cancellation need not have run.

Before the first handoff, an atomic Redis operation writes a separate submission
marker for one day. If a provider response or worker is lost, expiration of the
short claim does not authorize a new submission. The outcome is
`submission_unknown`. The next ladder rung remains the fallback. A crash between
writing that marker and starting transport can lose this rung; the provider call
and Redis write are not an atomic operation. These guards depend on retained Redis
state and do not establish exactly-once provider delivery.

The active worker may continue with distinct recipients/chunks after a successful
response. A proven push rejection or pre-connection failure may use the bounded
retry schedule, with fresh authority on each attempt. An ambiguous response stops
further submissions by that worker. SMS spend is refunded only when no call was
handed off or the provider proves non-submission; a timeout, lost response or
ambiguous provider failure keeps the spend. Provider network work remains bounded
by its adapter timeout and occurs outside membership transactions.

The first rung remains at 30 seconds. Hold/seen stopping rules, owner and staff
delivery, the separate SMS budget and tenant-scoped operator audience remain in
effect.
