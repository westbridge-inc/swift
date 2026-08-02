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
      // DESIGN-100× no-literal-colour gate (foundation flow): screen code uses
      // tokens, never raw hexes/rgba. Kit layers are exempt (src/kit + the
      // legacy components/ui kit — they define the tokens' consumers).
      files: [
        'apps/mobile/src/modules/**/*',
        'apps/mobile/src/screens/**/*',
        'apps/mobile/src/components/**/*',
      ],
      excludedFiles: [
        'apps/mobile/src/components/ui/**/*', // legacy kit — migrates in the System Surfaces flow
        // ---- DESIGN-100× DEBT LEDGER ----
        // Pre-foundation literals, migrated flow-by-flow down the Part 6
        // register. Each flow DELETES its files from this list at merge.
        // Ledger empty = Part 8.2 acceptance. Do not add files.
        'apps/mobile/src/components/ErrorBoundary.tsx',
        'apps/mobile/src/components/FareSlider.tsx',
        'apps/mobile/src/components/MmgPayLinkCard.tsx',
        'apps/mobile/src/modules/advertiser/screens/AdvertiserHomeScreen.tsx',
        'apps/mobile/src/modules/advertiser/screens/CampaignDetailScreen.tsx',
        'apps/mobile/src/modules/chat/screens/ConversationScreen.tsx',
        'apps/mobile/src/modules/mover/dark.tsx',
        'apps/mobile/src/modules/mover/screens/ActiveJobScreen.tsx',
        'apps/mobile/src/modules/mover/screens/EarningsScreen.tsx',
        'apps/mobile/src/modules/mover/screens/MoverHomeScreen.tsx',
        'apps/mobile/src/modules/mover/screens/MoverOnboardingScreen.tsx',
        'apps/mobile/src/modules/mover/shared.tsx',
        'apps/mobile/src/modules/orders/screens/OrdersHistoryScreen.tsx',
        'apps/mobile/src/screens/auth/SelfieCaptureScreen.tsx',
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
