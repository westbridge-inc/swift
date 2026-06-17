import { color } from './tokens';

/**
 * Minimal CSS custom properties for web parity / global.css. Kept small on
 * purpose — the Tailwind theme map (tailwind.ts) is the primary surface.
 */
export function swiftCssVars(): string {
  const vars = [
    `--swift-brand-500: ${color.brand[500]};`,
    `--swift-brand-600: ${color.brand[600]};`,
    `--swift-surface-base: ${color.surface.base};`,
    `--swift-surface-subtle: ${color.surface.subtle};`,
    `--swift-text-primary: ${color.text.primary};`,
    `--swift-text-secondary: ${color.text.secondary};`,
    `--swift-border-subtle: ${color.border.subtle};`,
  ];
  return `:root {\n  ${vars.join('\n  ')}\n}`;
}
