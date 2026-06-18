# Swift Consumer App — UI Overhaul to Uber Parity

Staged rebuild of the presentation layer to genuine Uber parity: **Gluestack UI v3** on the
red/white `@swift/ui` tokens, cached photography (**expo-image**), and 60fps recycled lists
(**FlashList**). One screen per commit; each stage gated (type-check + lint + `expo export`) and
device-verified before the next. The data layer (`src/hooks/*`, `src/services/api.ts`,
`src/stores/*`) is reused untouched.

## Smooth-scroll rules (every list screen)
- `components/ui/List` (FlashList v2) for all data lists — never `ScrollView` + `.map` (v2 auto-sizes rows; no `estimatedItemSize`).
- `components/ui/Image` (expo-image) for every remote image — cache + blurhash; no scroll re-decode.
- `React.memo` rows, stable keys, no inline closures/objects in hot rows.
- Press/scroll animation via reanimated on the UI thread.

## Do NOT rebuild (reuse)
- `src/hooks/*`, `src/services/api.ts`, `src/stores/*`
- `packages/ui/src/tokens.ts` + `tailwind.config.ts`, `global.css`, `metro.config.js`, `babel.config.js`
- Navigation graph + route names/params; `@swift/types`

## Stages (tick each when gated + device-verified)
- [x] **0a. Kickoff** — real icons (`@expo/vector-icons`), Home photo pass, `SwiftGY` native rename (fixes reserved-module build), gitignore generated native dirs
- [x] **0b. Foundation** — installed FlashList + expo-image + react-native-svg (one native rebuild; on-device verified). Components are **owned Gluestack-v3-style NativeWind components on `@swift/ui` tokens** — the gluestack CLI can't run headless (TTY-only), so they're hand-authored (the same owned/copy-paste paradigm v3 uses). Added `List` (FlashList) + `Image` (expo-image) + `Input`. (`Actionsheet`/`Modal`/`Toast` added per-stage as needed.)
- [x] **1. Home** — popular list → `List` (FlashList); RN `Image` → `Image` (expo-image); featured carousel. Gated + on-device verified.
- [ ] **2. Search** — Gluestack `Input`, debounce, filter chips, `List` results, empty/loading/error
- [ ] **3. VendorDetail** — expo-image hero, sticky header, sectioned menu `List`, option `Actionsheet`, add-to-cart
- [ ] **4. Cart** — `ScrollView` → `List`
- [ ] **5. Checkout** — Gluestack pickers; cash place-order
- [ ] **6. OrderTracking** — maps + status timeline
- [ ] **7. Orders** — `FlatList` → `List`
- [ ] **8. Account**
- [ ] **9. Taxi**
- [ ] **10. Courier**
- [ ] **11. Services**
- [ ] **12. Auth** — Country / Phone / OTP / Role / Register
- [ ] **13. Mover app** — `MoverStack` / `ActiveJobScreen`
- [ ] **14. Vendor app** — `VendorStack` / `VendorMenuScreen` / `VendorItemEditorScreen`
- [ ] **Shared cards** — `components/{customer,shared}/VendorCard` (memoize, expo-image, stable keys)

## Per-stage gate
`pnpm -C apps/mobile type-check && lint` + `expo export --platform ios` green → simulator
screenshot + tap-test the primary action against `localhost:3000` → commit → tick the box → next.
