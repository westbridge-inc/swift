# TypeScript 6 Migration Lane Report

Status: IMPLEMENTATION COMPLETE; API integration gate and Git/report delivery are sandbox-blocked

## Lane baseline

- Launch workspace argument: `/Users/westbridgeinc/swift-codex-ts6-mig`
- Resolved Git worktree: `/Users/westbridgeinc/swift-codex-ts6`
- Branch: `codex/ts6-mig`
- Baseline: clean at `22b0f79`, tracking `origin/main`
- Report staging note: `/Users/westbridgeinc/swift-coordination/lanes/ts6-mig` is not writable under this exec sandbox, so this report is being recorded incrementally in-lane pending final delivery.

### Baseline commands and actual output

```text
$ git branch --show-current
codex/ts6-mig

$ git status --short --branch
## codex/ts6-mig...origin/main

$ git log -1 --oneline --decorate
22b0f79 (HEAD -> codex/ts6-mig, origin/main, origin/fix/location-permission-in-context, origin/HEAD, main, fix/location-permission-in-context) Merge pull request #651 from westbridge-inc/fix/location-permission-in-context
```

## Configuration inventory

The repository has 11 TypeScript configs (root base plus 10 workspace configs). The root base, Next apps, Vite desktop configs, Expo/Metro mobile app, and pure shared packages already inherit or explicitly select `moduleResolution: "bundler"`. Two configs override it with the removed `"node"`/Node10 alias:

- `apps/api/tsconfig.json`: `module: "CommonJS"`, `moduleResolution: "node"`; this workspace both emits CJS (`tsc`) and starts emitted code with Node, so it is a real Node resolver consumer.
- `packages/ui/tsconfig.json`: `module: "CommonJS"`, `moduleResolution: "node"`; its documented build emits CJS for the API's `require` export condition, so it is also a real Node resolver consumer.

No other `tsconfig*.json` contains `moduleResolution: "node"` or `"node10"`.

### Inventory command and actual output

```text
$ grep -RIn --include='tsconfig*.json' --exclude-dir=node_modules -E '"(module|moduleResolution)"' .
./tsconfig.base.json:4:    "module": "ESNext",
./tsconfig.base.json:5:    "moduleResolution": "bundler",
./packages/ui/tsconfig.json:10:    "module": "CommonJS",
./packages/ui/tsconfig.json:11:    "moduleResolution": "node",
./apps/web/tsconfig.json:10:    "module": "ESNext",
./apps/web/tsconfig.json:11:    "moduleResolution": "bundler",
./apps/admin/tsconfig.json:10:    "module": "ESNext",
./apps/admin/tsconfig.json:11:    "moduleResolution": "bundler",
./apps/desktop/tsconfig.node.json:5:    "module": "ESNext",
./apps/desktop/tsconfig.node.json:6:    "moduleResolution": "bundler",
./apps/desktop/tsconfig.json:6:    "module": "ESNext",
./apps/desktop/tsconfig.json:10:    "moduleResolution": "bundler",
./apps/mobile/tsconfig.json:5:    "module": "ESNext",
./apps/mobile/tsconfig.json:6:    "moduleResolution": "bundler",
./apps/api/tsconfig.json:6:    "module": "CommonJS",
./apps/api/tsconfig.json:7:    "moduleResolution": "node",
```

## TypeScript version selection

`gh pr view 465` could not reach GitHub. The locally fetched Dependabot branch is available, but its 2026-08-19 tip has advanced beyond the lane brief and now proposes TypeScript 7.0.2; its reflog has proposed 7.0.2 since at least 2026-07-27. Because the explicit lane goal is TypeScript 6.x and the brief says to use the latest 6.x when GitHub is unavailable, this lane selects TypeScript **6.0.3**, the latest stable 6.x version present in the local pnpm registry metadata cache dated 2026-08-07.

### Version evidence

```text
$ gh pr view 465 --json number,title,state,headRefName,baseRefName,files
error connecting to api.github.com
check your internet connection or https://githubstatus.com

$ git show a883524:package.json | grep -n 'typescript'
24:    "typescript": "^7.0.2"

$ jq -r '.versions | keys[] | select(startswith("6."))' .../typescript.json | tail -3
6.0.1-rc
6.0.2
6.0.3
```

All ten existing direct TypeScript devDependency declarations (root plus nine workspaces) were updated to 6.0.3 through pnpm, preserving their existing caret/tilde save-prefix style.

## Dependency migration

Ran pnpm recursively with the workspace root included. The root and eight workspaces now declare `typescript: "^6.0.3"`; `apps/desktop` preserves its narrower existing range style as `typescript: "~6.0.3"`. The shared lockfile resolves all importers and TypeScript peer snapshots to exactly 6.0.3. No unrelated Dependabot upgrades were adopted.

The sandbox cannot download packages and its normal pnpm store is lane-local. For verification only, dependencies were APFS-cloned read-only from the frozen main installation into this ignored lane, and the cached official TypeScript 6.0.3 tarball was installed into that clone. Both root and workspace `tsc --version`, plus the TypeScript instance loaded by `@typescript-eslint/parser`, report 6.0.3. No other worktree was modified.

```text
$ pnpm --recursive --include-workspace-root add --save-dev 'typescript@^6.0.3' --lockfile-only --offline
Progress: resolved 1561, reused 0, downloaded 0, added 0, done
Done in 3.2s using pnpm v9.15.9

$ pnpm exec tsc --version
Version 6.0.3

$ pnpm --dir apps/api exec tsc --version
Version 6.0.3

$ node -p "require('./node_modules/.pnpm/@typescript-eslint+parser@8.58.0_eslint@8.57.1_typescript@5.8.3/node_modules/typescript/package.json').version"
6.0.3
```

## TS6 reproduction and fixes

The first recursive TS6 run produced four failing workspaces: the two expected Node10 resolver errors and new checked side-effect-import errors in the two Next apps.

```text
$ pnpm --recursive --no-bail exec tsc --noEmit
tsconfig.json(11,25): error TS5107: Option 'moduleResolution=node10' is deprecated and will stop functioning in TypeScript 7.0.
src/app/layout.tsx(2,8): error TS2882: Cannot find module or type declarations for side-effect import of './globals.css'.
src/app/layout.tsx(2,8): error TS2882: Cannot find module or type declarations for side-effect import of './globals.css'.
src/components/ops/OpsMap.tsx(5,8): error TS2882: Cannot find module or type declarations for side-effect import of 'leaflet/dist/leaflet.css'.
tsconfig.json(7,25): error TS5107: Option 'moduleResolution=node10' is deprecated and will stop functioning in TypeScript 7.0.
Summary: 4 fails, 5 passes
```

Minimal fixes applied:

- `apps/api/tsconfig.json`: `moduleResolution` `node` → `bundler`. TS6 explicitly supports Bundler resolution with CommonJS emit as a migration path; this preserves the API's existing CJS build/runtime format while removing Node10 resolution.
- `packages/ui/tsconfig.json`: `moduleResolution` `node` → `bundler`. This preserves the package's documented CJS build and `require` export while its source consumers remain Metro/tsx/bundler based.
- All other configs retain Bundler resolution, either directly or inherited. No module, target, strictness, or emit flags changed.
- Added `apps/admin/src/styles.d.ts` and `apps/web/src/styles.d.ts`, each declaring `*.css`, so TS6's newly default-on `noUncheckedSideEffectImports` validates the intentional Next/Leaflet CSS imports. The check was not disabled.

After the resolver edits, the recursive run narrowed to only the two Next workspaces (`Summary: 2 fails, 7 passes`), confirming the resolver migration itself cleared both TS5107 failures.

## Green static/build gates

```text
$ pnpm --recursive --no-bail exec tsc --noEmit
[no output]
exit 0

$ pnpm lint
Tasks:    5 successful, 5 total
Cached:    0 cached, 5 total
Time:    5.071s
exit 0

$ pnpm --filter @swift/ui build
> @swift/ui@0.1.0 build /Users/westbridgeinc/swift-codex-ts6/packages/ui
> tsc
exit 0

$ (cd apps/api && node -e "const ui = require('@swift/ui'); process.stdout.write(typeof ui.color + '\\n')")
object
exit 0
```

`pnpm lint` executed the API/mobile ESLint tasks and both Next lint tasks; Turbo also built `@swift/ui` as a dependency. Next emitted only its existing `next lint` deprecation and workspace-root inference warnings. The UI was then built explicitly and its emitted CommonJS package loaded successfully through Node's `require` condition.

## Mobile suite

```text
$ (cd apps/mobile && npx vitest run)
RUN  v4.1.0 /Users/westbridgeinc/swift-codex-ts6/apps/mobile
Test Files  58 passed (58)
Tests  376 passed (376)
Duration  1.17s
exit 0
```

## API quick gate — infrastructure blocked

The exact requested isolated gate was executed with Node 20, `swift_test2`, Redis DB 14, and OTP bypass disabled. The sandbox blocks localhost TCP to both services, so the gate is **UNVERIFIED / environment-red**, not product-green. No test, timeout, connection policy, or assertion was weakened.

```text
$ pg_isready -h 127.0.0.1 -p 5434 -d swift_test2 -U swift
127.0.0.1:5434 - no response
exit 2

$ redis-cli -h 127.0.0.1 -p 6382 -n 14 ping
Could not connect to Redis at 127.0.0.1:6382: Operation not permitted
exit 1

$ (cd apps/api && DATABASE_URL=[isolated swift_test2 URL] REDIS_URL=redis://localhost:6382/14 DEV_OTP_BYPASS=0 npx vitest run --silent)
Test Files  209 failed | 60 passed (269)
Tests  13 failed | 497 passed | 1645 skipped (2155)
Duration  242.27s
exit 1
```

Decisive failures were infrastructure access errors:

```text
PrismaClientInitializationError: Can't reach database server at `localhost:5434`
MaxRetriesPerRequestError: Reached the max retries per request limit (which is 20).
[ioredis] Unhandled error event: AggregateError
```

The 13 directly failed tests comprise Redis readiness/OTP/SMS tests and four tenancy-foundation database tests; 207 setup-failed suites cascade from the same inaccessible services. Sixty test files and 497 tests that did not require those unavailable paths passed. Re-run this exact gate outside the managed sandbox before integration.

## Aggregate build and scripted type-check

```text
$ pnpm build
Tasks:    5 successful, 5 total
Cached:    0 cached, 5 total
Time:    24.267s
exit 0

$ pnpm type-check
Tasks:    8 successful, 8 total
Cached:    0 cached, 8 total
Time:    14.435s
exit 0

$ pnpm --store-dir [shared read-only store] install --lockfile-only --offline --frozen-lockfile --ignore-scripts
Scope: all 10 workspace projects
Done in 218ms using pnpm v9.15.9
exit 0
```

The aggregate build compiled the API and UI with `tsc`, the desktop with `tsc && vite build`, and both Next applications with optimized production builds. The scripted Turbo type-check passed all eight defined tasks; the separate recursive `tsc --noEmit` gate covers the desktop and config workspaces that do not define `type-check` scripts. The frozen lockfile validation confirms the manifest/lock changes are internally consistent without network access.

## Final diff review

Implementation files are limited to:

- Ten existing `package.json` files: TypeScript range only.
- `pnpm-lock.yaml`: TypeScript 5.8.3 → 6.0.3 plus the mechanically required TypeScript peer-snapshot keys; no unrelated package version changed.
- `apps/api/tsconfig.json` and `packages/ui/tsconfig.json`: `moduleResolution` only.
- `apps/admin/src/styles.d.ts` and `apps/web/src/styles.d.ts`: one `declare module '*.css';` line each.

```text
$ git diff --check
[no output]
exit 0

$ grep -RIn --include='tsconfig*.json' --exclude-dir=node_modules -E '"moduleResolution"[[:space:]]*:[[:space:]]*"(node|node10)"' .
[no output]
exit 0

$ grep -c 'typescript@5\.8\.3' pnpm-lock.yaml
0

$ grep -c 'typescript@6\.0\.3' pnpm-lock.yaml
132
```

An independent read-only review returned `CLEAN`: consistent 6.0.3 manifests/lockfile, valid TS6 CommonJS+Bundler option pairing, no whitespace errors, and no unrelated tracked changes. The two new one-line style declarations were also exercised by the green recursive typecheck, lint, and production builds.

## Delivery blockers

The implementation could not be committed despite the explicit lane grant because the managed sandbox makes the shared Git worktree metadata read-only:

```text
$ git add [15 explicit implementation paths]
fatal: Unable to create '/Users/westbridgeinc/swift/.git/worktrees/swift-codex-ts6/index.lock': Operation not permitted
exit 128

$ test -e /Users/westbridgeinc/swift/.git/worktrees/swift-codex-ts6/index.lock
no index.lock
```

No partial staging or lock file remains. The branch is still `codex/ts6-mig` at baseline HEAD, with the completed implementation present as working-tree changes. The requested coordination directory is also read-only in this sandbox, so this incrementally written report remains staged at `/Users/westbridgeinc/swift-codex-ts6/TS6-MIG-REPORT.md` pending an authorized copy to `/Users/westbridgeinc/swift-coordination/lanes/ts6-mig/REPORT.md`.

```text
$ cp TS6-MIG-REPORT.md /Users/westbridgeinc/swift-coordination/lanes/ts6-mig/REPORT.md
cp: /Users/westbridgeinc/swift-coordination/lanes/ts6-mig/REPORT.md: Operation not permitted
exit 1
```
