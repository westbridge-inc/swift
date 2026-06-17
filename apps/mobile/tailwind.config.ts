import type { Config } from 'tailwindcss';
import { swiftTailwindTheme } from '@swift/ui';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nativewindPreset = require('nativewind/preset');

/**
 * Identity lives in @swift/ui — this config just maps those tokens into Tailwind
 * so components use token classes (`bg-brand-500`, `text-text-primary`).
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}', './index.js'],
  presets: [nativewindPreset],
  theme: { extend: swiftTailwindTheme as unknown as Config['theme'] },
};

export default config;
