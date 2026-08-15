# Swift mobile local smoke suite

This Maestro layer proves that the installed iOS development build can load
the current Metro bundle, render the one-app role picker, enter the read-only
driver and business previews, return from both previews, and open the local
phone-auth shell. The preview round trips use in-process sample data and do not
require the Swift API.

It deliberately does **not** claim coverage for OTP/session issuance, real
customer or earner work, payments, dispatch, background location, camera,
push notifications, store signing, or physical-device behavior. Those remain
separate backend-backed and physical-device certification lanes.

## Safety contract

- Pass an explicit simulator UDID. The runner never chooses, boots, or stops a
  simulator.
- The protected iPhone UDID is denied before Maestro runs.
- `clearState: true` resets only Swift's app sandbox on the selected disposable
  simulator so every flow starts at the same first-open boundary.
- The runner does not start or stop Metro or the API. Metro must already serve
  the exact worktree. The default development-client URL is
  `http://127.0.0.1:8081`.
- No production credentials or OTP bypass values are stored in this suite.

## Run

From `apps/mobile`:

```sh
SWIFT_IOS_SMOKE_DEVICE='<disposable-simulator-udid>' pnpm e2e:ios:smoke
```

Override `SWIFT_EXPO_DEV_URL_ENCODED` only when Metro is exposed on a different
URL. Its value must be URL encoded. Override `SWIFT_MAESTRO_REPORT` to choose a
different JUnit report path; the default is
`/tmp/swift-maestro-ios-smoke.xml`.
