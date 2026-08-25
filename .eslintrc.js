module.exports = {
  root: true,
  extends: ['eslint:recommended'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'react-hooks'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', '.next/', '.turbo/'],
  overrides: [
    {
      // [F-026-32] The baseline scenarios are operator-facing CLI tools whose
      // entire output IS console logging — that is the evidence they produce.
      // They are now inside the lint gate; console is the one rule that would
      // be pure noise there.
      files: ['apps/api/scripts/**/*.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      // DESIGN-100× no-literal-colour law: screen AND component code uses
      // tokens, never raw hexes/rgba. Only src/kit is exempt — it is where
      // the tokens' consumers are defined. The debt ledger that once lived
      // here is EMPTY (Part 8.2 acceptance, 2026-08-02).
      files: [
        'apps/mobile/src/modules/**/*',
        'apps/mobile/src/screens/**/*',
        'apps/mobile/src/components/**/*',
      ],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
            message: 'No literal hex colours in screens — use @swift/ui tokens (design-100× Part 4).',
          },
          {
            selector: 'Literal[value=/^rgba?\\(/]',
            message: 'No literal rgb()/rgba() in screens — use @swift/ui tokens (scrim, skeleton, elevation).',
          },
        ],
      },
    },
    // ─────────────────────────────────────────────────────────────────────
    // THE UI BARRIER [SWIFT-UI-GUT-AND-REBUILD §7]
    //
    // The measured problem: TWO complete design systems live in this app —
    // `src/kit` (new, tokens-only) and `src/components/ui` (legacy,
    // gluestack-flavoured) — and FIFTEEN of the highest-traffic screens import
    // BOTH. Home, Cart, the hold, the store page, search, taxi, the rider
    // cockpit, the active job, the vendor stack and the role picker each render
    // two typographic scales, two elevation scales, two pressable behaviours and
    // two toast systems at once.
    //
    // That is the "mixed up" the founder keeps seeing, and it is structural. No
    // amount of restyling individual screens fixes it while both kits stay
    // importable — which is why this is a lint rule and not a convention.
    //
    // The new tree is `kit2/` + `screens2/`. It is built clean and cut over one
    // surface at a time; the old tree is frozen meanwhile.
    // ─────────────────────────────────────────────────────────────────────
    {
      // ① THE WALL — the new tree may never import the old one.
      files: ['apps/mobile/src/kit2/**/*', 'apps/mobile/src/screens2/**/*'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [
            {
              group: ['**/components/ui', '**/components/ui/**'],
              message: 'BARRIER: kit2/screens2 must never import the legacy kit. Build it in kit2/.',
            },
            {
              // The old kit is contaminated at its own root: kit/food.tsx
              // imports Scrim from components/ui, so "just use the new kit"
              // still drags the legacy tree in behind it.
              group: ['**/src/kit', '**/src/kit/**'],
              message: 'BARRIER: the old kit is contaminated (kit/food.tsx imports components/ui). Port into kit2/.',
            },
            {
              group: ['**/src/modules/**', '**/src/screens/**'],
              message: 'BARRIER: new screens must not import old screens. Rebuild from the reference image.',
            },
          ],
        }],
        // Token-only from line one. No grandfathering, no debt ledger.
        'no-restricted-syntax': [
          'error',
          {
            selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
            message: 'No literal hex in kit2/screens2 — use @swift/ui tokens.',
          },
          {
            selector: 'Literal[value=/^rgba?\\(/]',
            message: 'No literal rgb()/rgba() — use tokens (scrim, skeleton, elevation).',
          },
        ],
      },
    },
    {
      // ② THE FREEZE — the old tree may not reach into the new one either.
      // Without this, someone "quickly improves" a dying screen with a kit2
      // component and creates a THIRD mixed state, which is how we got here.
      files: [
        'apps/mobile/src/modules/**/*',
        'apps/mobile/src/screens/**/*',
        'apps/mobile/src/components/**/*',
        'apps/mobile/src/kit/**/*',
      ],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [{
            group: ['**/kit2', '**/kit2/**', '**/screens2', '**/screens2/**'],
            message: 'BARRIER: the old tree is frozen. It does not consume kit2 — migrate the screen instead.',
          }],
        }],
      },
    },
    {
      // ③ The navigator is the ONE place both trees are legitimately visible,
      // because that is where the cutover flag lives.
      files: ['apps/mobile/src/navigation/**/*'],
      rules: { 'no-restricted-imports': 'off' },
    },
    {
      // Mission Control is a Tauri app: a real browser webview, not Node. The
      // root env declares `node` only, so every `window`, `document`,
      // `requestAnimationFrame` and `HTMLElement` in it resolved to no-undef —
      // 18 errors sat on main unnoticed, because CI runs "Desktop Build (TS)"
      // and never lints this package. Declaring the environment makes the
      // desktop honestly lintable instead of permanently red.
      files: ['apps/desktop/src/**/*'],
      env: { browser: true },
    },
  ],
  rules: {
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    // React Hooks correctness (mobile/admin). rules-of-hooks catches real bugs;
    // exhaustive-deps is advisory so it never reds CI — and stale disable-directives
    // now resolve instead of erroring (the cause of the earlier main breakage).
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
};
