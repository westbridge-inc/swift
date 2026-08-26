import type { CSSProperties } from 'react';
import {
  color,
  elevation,
  font,
  radius,
  space,
  typeScale,
} from '../../../../packages/ui/src';
import { VERTICAL_TINT } from '../../../mobile/src/kit/vertical-tint';

/**
 * Web bridge for the canonical Swift tokens.
 *
 * This lane cannot add the missing `@swift/ui` workspace dependency because
 * apps/web/package.json is outside its ownership. Importing the exact source
 * modules keeps one token authority until the package manifest can be wired by
 * the integration owner. No colour or layout value is duplicated here.
 */
type SwiftCssVariables = CSSProperties & Record<`--${string}`, string | number>;
type StorefrontVertical = 'food' | 'groceries' | 'shops' | 'services';

const px = (value: number) => `${value}px`;

const storefrontVerticalByVendorType: Record<string, StorefrontVertical> = {
  RESTAURANT: 'food',
  SUPERMARKET: 'groceries',
  STORE: 'shops',
  SERVICE: 'services',
};

export function storefrontVertical(vendorType: string): StorefrontVertical {
  return storefrontVerticalByVendorType[vendorType] ?? 'shops';
}

export function storefrontVerticalVariables(vendorType: string): SwiftCssVariables {
  const tint = VERTICAL_TINT[storefrontVertical(vendorType)];
  return {
    '--swift-vertical-bg': tint?.bg ?? color.brand[50],
    '--swift-vertical-ink': tint?.ink ?? color.brand[600],
  };
}

export const swiftDesignVariables: SwiftCssVariables = {
  '--swift-red': color.brand[500],
  '--swift-red-600': color.brand[600],
  '--swift-red-50': color.brand[50],
  '--swift-white': color.white,
  '--swift-ink': color.text.primary,
  '--swift-muted': color.text.secondary,
  '--swift-muted-soft': color.text.muted,
  '--swift-canvas': color.surface.subtle,
  '--swift-card': color.surface.base,
  '--swift-sunken': color.surface.sunken,
  '--swift-subtle': color.brand[50],
  '--swift-border': color.border.subtle,
  '--swift-border-strong': color.border.strong,
  '--swift-success': color.success,
  '--swift-error': color.error,
  '--swift-warning': color.warning,
  '--swift-info': color.info,
  '--swift-star': color.star,
  '--swift-focus': color.focusRing,
  '--swift-scrim': color.scrim,
  '--swift-media-scrim': color.mediaScrim,
  '--swift-on-brand-muted': color.surface.onBrand,
  '--swift-vertical-bg': VERTICAL_TINT.food?.bg ?? color.brand[50],
  '--swift-vertical-ink': VERTICAL_TINT.food?.ink ?? color.brand[600],

  '--swift-space-xs': px(space.xs),
  '--swift-space-sm': px(space.sm),
  '--swift-space-md': px(space.md),
  '--swift-space-lg': px(space.lg),
  '--swift-space-xl': px(space.xl),
  '--swift-space-2xl': px(space['2xl']),
  '--swift-space-3xl': px(space['3xl']),
  '--swift-space-neg-3xl': px(-space['3xl']),
  '--swift-space-4xl': px(space['4xl']),
  '--swift-space-5xl': px(space['5xl']),
  '--swift-touch': px(space['5xl'] - space.xs),
  '--swift-menu-image': px(space['5xl'] * 2),
  '--swift-rail-width': px(space['5xl'] * 8),
  '--swift-modal-width': px(space['5xl'] * 10),
  '--swift-content-width': px(space['5xl'] * 25),
  '--swift-content-half': px((space['5xl'] * 25) / 2),
  '--swift-hero-height': px(space['5xl'] * 5),
  '--swift-rail-sticky-top': px((space['5xl'] - space.xs) * 2 + space['2xl']),
  '--swift-section-scroll': px((space['5xl'] - space.xs) * 3),

  '--swift-radius-sm': px(radius.sm),
  '--swift-radius-md': px(radius.md),
  '--swift-radius-lg': px(radius.lg),
  '--swift-radius-xl': px(radius.xl),
  '--swift-radius-full': px(radius.full),

  '--swift-font-display': font.display,
  '--swift-font-display-semibold': font.displaySemiBold,
  '--swift-font-body': font.body,
  '--swift-font-body-medium': font.bodyMedium,
  '--swift-font-body-semibold': font.bodySemiBold,
  '--swift-font-body-bold': font.bodyBold,
  '--swift-type-display': px(typeScale.display.fontSize),
  '--swift-leading-display': px(typeScale.display.lineHeight),
  '--swift-type-title': px(typeScale.title.fontSize),
  '--swift-leading-title': px(typeScale.title.lineHeight),
  '--swift-type-heading': px(typeScale.heading.fontSize),
  '--swift-leading-heading': px(typeScale.heading.lineHeight),
  '--swift-type-body': px(typeScale.body.fontSize),
  '--swift-leading-body': px(typeScale.body.lineHeight),
  '--swift-type-label': px(typeScale.label.fontSize),
  '--swift-leading-label': px(typeScale.label.lineHeight),
  '--swift-type-caption': px(typeScale.caption.fontSize),
  '--swift-leading-caption': px(typeScale.caption.lineHeight),
  '--swift-type-micro': px(typeScale.micro.fontSize),
  '--swift-leading-micro': px(typeScale.micro.lineHeight),
  '--swift-tracking-micro': px(typeScale.micro.letterSpacing ?? 0),
  '--swift-type-num-l': px(typeScale.numL.fontSize),
  '--swift-leading-num-l': px(typeScale.numL.lineHeight),
  '--swift-type-num-m': px(typeScale.numM.fontSize),
  '--swift-leading-num-m': px(typeScale.numM.lineHeight),

  '--swift-elevation-card': elevation.card.boxShadow,
  '--swift-elevation-raised': elevation.raised.boxShadow,
  '--swift-elevation-floating': elevation.floating.boxShadow,
};

/**
 * Raw brand hexes, for the few places that cannot use a CSS variable —
 * notably the generated Open Graph card, which is rasterised by Satori with
 * no stylesheet in scope. Sourced from the same token object as everything
 * else, so the UI barrier's "no brand hex outside packages/ui" rule holds.
 */
export const brandPalette = {
  brand: color.brand[500],
  brandDeep: color.brand[600],
  paper: color.surface.subtle,
  blush: color.brand[100],
  ink: color.text.primary,
} as const;
