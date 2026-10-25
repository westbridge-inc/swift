'use client';

import { Minus, Plus, X } from 'lucide-react';
import { formatAmount, parseAmount } from '@/lib/money';
import type { MenuItem, OptionGroup } from '@/lib/customer';
import { Photo } from '@/components/order-ui';
import { Sheet } from '@/components/sheet';
import styles from './storefront.module.css';

/**
 * [W6] An item's sheet on the store page: its choices, the quantity and the
 * Add. It is only needed after a tap (or a link that names an item), so the
 * store page loads this code after its first paint instead of before it
 * (storefront-experience.tsx `loadItemSheet`). Everything it decides comes
 * from the page: the choices made, the price, the error, and what Add does.
 */

const gyMoney = (value: unknown) => formatAmount(value, '$');

function optionGuidance(group: OptionGroup): string {
  const minimum = group.isRequired ? Math.max(1, group.minSelect) : group.minSelect;
  if (group.maxSelect <= 1) return minimum > 0 ? 'Choose 1' : 'Optional';
  if (minimum === group.maxSelect) return `Choose ${group.maxSelect}`;
  if (minimum > 0) return `Choose ${minimum}–${group.maxSelect}`;
  return `Optional · up to ${group.maxSelect}`;
}

export interface ItemSheetProps {
  item: MenuItem & { optionGroups?: OptionGroup[] };
  vendorType: string | null | undefined;
  selectedOptions: Record<string, string[]>;
  onChoose: (_group: OptionGroup, _optionId: string) => void;
  quantity: number;
  onQuantity: (_next: (_count: number) => number) => void;
  error: string | null;
  busy: boolean;
  cartLoading: boolean;
  unitPrice: number | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function ItemSheet({
  item, vendorType, selectedOptions, onChoose, quantity, onQuantity, error, busy, cartLoading, unitPrice, onConfirm, onClose,
}: ItemSheetProps) {
  return (
    <Sheet labelledBy="menu-options-title" onClose={onClose} className={styles.sheet}>
      <div className={styles.sheetHeader}>
        <Photo src={item.imageUrl} alt="" vendorType={vendorType} sizes="72px" iconSize={26} className={styles.sheetPhoto} />
        <div className={styles.sheetHeading}>
          <h2 id="menu-options-title" className={styles.modalTitle}>{item.name}</h2>
          {item.description ? <p className={styles.modalDescription}>{item.description}</p> : null}
        </div>
        <button data-modal-initial-focus type="button" className={styles.closeButton} onClick={onClose} aria-label="Close item options">
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      <div className={styles.options}>
        {(item.optionGroups ?? []).map((group) => {
          const selectedCount = (selectedOptions[group.id] ?? []).length;
          const multiLimitReached = group.maxSelect > 1 && selectedCount >= group.maxSelect;
          const onSale = group.options.filter((option) => option.isAvailable !== false);
          return (
            <div key={group.id} className={styles.optionBlock}>
              <fieldset className={styles.optionGroup} data-option-group={group.id}>
                <legend className={styles.optionHeading}>
                  <span className={styles.optionTitle}>{group.name}</span>
                  <span className={styles.optionMeta}>
                    {group.isRequired ? <span className={styles.required}>Required</span> : <span className={styles.optionGuidance}>{optionGuidance(group)}</span>}
                  </span>
                </legend>
                {group.isRequired && group.maxSelect > 1 ? <p className={styles.optionGuidance}>{optionGuidance(group)}</p> : null}
                {onSale.length === 0 ? <p className={styles.optionGuidance}>Every choice here is sold out right now.</p> : null}
                {onSale.map((option) => {
                  const checked = (selectedOptions[group.id] ?? []).includes(option.id);
                  const single = group.maxSelect <= 1;
                  const clearableSingle = single && !group.isRequired && group.minSelect === 0;
                  const blockedByLimit = multiLimitReached && !checked;
                  const extra = parseAmount(option.additionalPrice);
                  return (
                    <label key={option.id} className={`${styles.optionLabel} ${blockedByLimit ? styles.optionLabelDisabled : ''}`}>
                      <span className={styles.optionChoice}>
                        <input
                          type={single && !clearableSingle ? 'radio' : 'checkbox'}
                          name={group.id}
                          checked={checked}
                          disabled={blockedByLimit}
                          onChange={() => onChoose(group, option.id)}
                        />
                        {option.name}
                      </span>
                      {extra === null ? (
                        <span className={styles.optionPrice}>Price unavailable</span>
                      ) : extra > 0 ? (
                        <span className={styles.optionPrice}>+{gyMoney(extra)}</span>
                      ) : null}
                    </label>
                  );
                })}
              </fieldset>
            </div>
          );
        })}
      </div>

      <div className={styles.sheetFooter}>
        {error ? <p id="menu-options-error" className={styles.modalAlert} role="alert">{error}</p> : null}
        <div className={styles.sheetFooterRow}>
          <div className={styles.quantity} role="group" aria-label="Quantity">
            <button type="button" className={styles.quantityButton} aria-label="Decrease quantity" disabled={quantity <= 1 || busy} onClick={() => onQuantity((count) => Math.max(1, count - 1))}><Minus size={18} aria-hidden="true" /></button>
            <span className={styles.quantityCount} role="status" aria-label={`Quantity ${quantity}`}>{quantity}</span>
            <button type="button" className={styles.quantityButton} aria-label="Increase quantity" disabled={quantity >= 99 || busy} onClick={() => onQuantity((count) => Math.min(99, count + 1))}><Plus size={18} aria-hidden="true" /></button>
          </div>
          <button
            type="button"
            className={`${styles.primaryButton} ${styles.sheetAdd}`}
            disabled={cartLoading || busy || unitPrice === null}
            aria-describedby={error ? 'menu-options-error' : undefined}
            onClick={onConfirm}
          >
            Add to order · {gyMoney(unitPrice === null ? null : unitPrice * quantity)}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
