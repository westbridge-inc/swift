# Swift mobile — two apps, one codebase

`apps/mobile` builds **two separate store apps** from a single source tree, selected at build time by
the `EXPO_PUBLIC_APP_VARIANT` env var.

| Variant | App name | Bundle ID | Root mounted | Native extras |
|---|---|---|---|---|
| `customer` (default) | Swift | `gy.swift.app` | `CustomerStack` | location when-in-use |
| `partner` | Swift Partner | `gy.swift.partner` | Mover / Vendor stacks (role-routed) | background location + push |

The variant flows through two places:

- **`app.config.ts`** reads it to set per-variant name / bundle id / scheme / icon / permissions /
  plugins.
- **`src/lib/appVariant.ts`** (`getAppVariant()`) reads it in JS; **`src/navigation/RootNavigator.tsx`**
  mounts the matching root. `partnerStackKey(activeRole)` routes *within* the partner app
  (`mover` / `vendor` / `onboarding`).

## Run locally

```bash
pnpm -C apps/mobile start            # customer (default)
pnpm -C apps/mobile start:partner    # partner
# native dev clients:
pnpm -C apps/mobile ios              #  ios:partner | android | android:partner
```

## Build (EAS)

Each `eas.json` profile pairs an environment with a variant:

```bash
eas build -p ios --profile production            # customer
eas build -p ios --profile production-partner    # partner
```

Other profiles: `development[-partner]`, `preview[-partner]`.

## Before the partner app ships (follow-ups)

- `eas init` a **separate EAS project** for the partner app and set its `EAS_PROJECT_ID`
  (each app is its own project / OTA channel / store credentials).
- Replace `assets/icon-partner.png` (currently a copy of the customer icon) with real partner art.
- Background GPS + push are **wired natively** (permissions / `UIBackgroundModes`); the JS background
  `TaskManager` location task and `expo-notifications` integration are follow-ups — movers already
  foreground-stream via `useBroadcastLocation`.
- Make the Account role-switch UI variant-aware (hide cross-app roles / deep-link to the other app).
