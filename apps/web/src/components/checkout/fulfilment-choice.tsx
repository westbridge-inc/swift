'use client';

import type { OrderingMode } from '@/components/ordering-context';
import styles from './fulfilment-choice.module.css';

const LABELS: Record<OrderingMode, { title: string; sub: string }> = {
  DELIVERY: { title: 'Delivery', sub: 'A rider brings it to your address' },
  PICKUP: { title: 'Pickup', sub: 'Collect it from the store · no delivery fee' },
};

/**
 * [W5] The customer's own Delivery · Pickup choice, the same on the store's
 * order panel and the checkout (one ordering context holds it). The server
 * prices and accepts either; this only says which one to ask for.
 */
export function FulfilmentChoice({ value, onChange, disabled = false, name }: {
  value: OrderingMode; onChange: (_mode: OrderingMode) => void; disabled?: boolean; name: string;
}) {
  return (
    <fieldset className={styles.choices} role="radiogroup" aria-label="How would you like your order?">
      <legend className={styles.legend}>How would you like your order?</legend>
      {(['DELIVERY', 'PICKUP'] as const).map((mode) => (
        <label key={mode} className={styles.choice}>
          <input type="radio" name={name} value={mode} checked={value === mode} disabled={disabled} onChange={() => onChange(mode)} />
          <span className={styles.copy}>
            <span className={styles.title}>{LABELS[mode].title}</span>
            <span className={styles.sub}>{LABELS[mode].sub}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
