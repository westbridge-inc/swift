/** @jsxImportSource react */
import React from 'react';
import { money } from '../lib/money';
import { T, type TP } from './text';

/**
 * Money, rendered right: the shared formatter (lib/money) in a tabular num
 * step — `numM` (17) for rows and lists, `numL` (24) for totals and hero
 * amounts. Hand-built money strings are a lint error (Part 11 money law);
 * screens migrate onto this as their flow is elevated.
 */
export function Money({
  amount,
  size = 'm',
  ...rest
}: Omit<TP, 'variant' | 'children'> & { amount: number | null | undefined; size?: 'm' | 'l' }) {
  return (
    <T variant={size === 'l' ? 'numL' : 'numM'} {...rest}>
      {money(amount)}
    </T>
  );
}
