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
