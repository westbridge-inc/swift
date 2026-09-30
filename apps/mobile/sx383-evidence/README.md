# PR #1397 — Revision 1 (SX383)

Writer: Westbridge / Codex GPT-6 Astra. Scope: F1–F4 from the coordinator's
SX383 verdict. Independent Sol review and remote CI remain pending. No merge.

`git fetch origin main` followed by `git rev-list --left-right --count HEAD...origin/main`
returned `1 6`. Merged main `5cb72799` into the existing branch (no rebase),
creating `13667b1a44f0e81c2992638b484c11fa59a43c30`.
The last pre-commit fetch returned `2 0`.

| Finding | Fix | Test and sensitivity proof |
| --- | --- | --- |
| F1 | Include store generation in the vendor navigation group key. | Batched A → B → A uses the real navigation container, navigators, live-orders hook and socket lifecycle. It disconnects the old socket, reconnects/subscribes A, removes the old listener and receives a new-order takeover. Red first: the socket remained disconnected. |
| F2 | Capture generation at action start; compare store ID and generation immediately after QR preflight, before either POST. | Four cases cover deactivate/regenerate during A → B and A → B → A. Red first: each stale action sent one POST with A's header. |
| F3 | Include store generation in notification validation and retry freshness. | Pending validation for C crosses A → B → A and cannot replace A; a captured failed-validation retry cannot issue another GET. Red first: validation returned C and retry made two requests. |
| F4 | Add real navigation-container coverage of the Account editor. | Dirty hours through the actual Account component, switch stores, observe the old input detached, navigate back to Account and observe a new route/input with a fresh draft. No test-driven editor unmount. A static-key mutation leaves the old input connected and fails the test. |

The navigation tests use the installed `@react-navigation/native-stack` JS view
and bottom-tabs with a real React DOM renderer. Native drawing, unrelated
screens, network data and socket transport are stubs. The navigator, navigation
container, store, Account/QR screens, live hook and socket lifecycle are real.
No device, native animation or simulator execution is claimed. The renderer and
DOM environment reuse the workspace's installed web dependencies; no installs.

## Red-first evidence

Before source changes, these commands proved the tested source blobs in merged
HEAD were identical to `b96a0e11`:

```text
git rev-parse <b96a0e11 or 13667b1a>:apps/mobile/<path>
src/modules/vendor/VendorStack.tsx: e88b66bd14574ef9d0271081c4cfa0a051fcc34d (both)
src/modules/vendor/screens/VendorMyQrScreen.tsx: 7ab202d2db8573946a7a7758c35b09b110a6f5f7 (both)
src/services/weekly-fee-notification.ts: 0f471f26fe6f8906150893039e5946599bb67da7 (both)
```

All commands below run from `apps/mobile`, with Node v20.19.6 first in PATH.

```text
./node_modules/.bin/vitest run --config vitest.comb.config.ts --maxWorkers=2 src/modules/vendor/VendorStack.navigation.test.ts src/services/weekly-fee-notification.test.ts
Test Files  2 failed (2)
Tests       7 failed | 9 passed (16)
```

Actual output: [red.log](red.log). The seven failures cover all new F1–F3 tests.
The F4 test passes on this baseline and has separate mutation evidence.

## F4 mutation: landed, traversed, restored

Temporarily replaced the production group's generation key with
`navigationKey="sx383-static"`, then ran:

```text
./node_modules/.bin/vitest run --config vitest.comb.config.ts --maxWorkers=2 src/modules/vendor/VendorStack.navigation.test.ts -t 'the real navigator retires'
AssertionError: expected true to be false
expect(oldInput.isConnected).toBe(false)
Tests  1 failed | 5 skipped (6)
MUTATION EXIT: 1
RESTORED: True
```

The five unselected cases were filtered only for this mutation probe; no test was
disabled. Source was restored in `finally` and its SHA-256 matched the saved
source. Actual probe output: [mutation-f4.log](mutation-f4.log).

## Restored gates

- Focused command above plus `src/modules/vendor/screens/VendorAccountScreen.previewExit.test.ts`
  → **3 files / 31 tests passed**, exit 0. [Output](green-focused.log).
- `df -h /System/Volumes/Data` → **16 GiB available, 92% capacity** before the full suite.
- `/Users/westbridgeinc/swift-coordination/scripts/heavy.sh ./node_modules/.bin/vitest run --config vitest.comb.config.ts --maxWorkers=2`
  → **221 files / 1,987 tests passed**, no skips, exit 0. [Output](full-mobile.log).
- `/Users/westbridgeinc/swift-coordination/scripts/heavy.sh ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
  → **exit 0**, after correcting the test-only navigation-ref generic. [Output](tsc.log).
- `/Users/westbridgeinc/swift-donor-main-14deaff5/node_modules/.bin/eslint <all changed mobile .ts/.tsx paths relative to origin/main, including new files>`
  → **19 files, exit 0**, no diagnostics.
- `git diff --check` → **exit 0**.

The final focused run includes the navigation-ref typing correction; it has no
runtime behavior change. Existing tests remain in the full suite. The older
Account harness assertion now expects the exact store-and-generation key.
