 'use client';
import type { Dispatch, SetStateAction } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import { formatAmount, parseAmount } from '@/lib/money';
import type { OptionGroup, VendorDetail } from '@/lib/customer';
import { Photo } from '@/components/order-ui';
import { Sheet } from '@/components/sheet';
import type { DisplayItem } from './storefront-experience';
import styles from './storefront.module.css';
const gyMoney = (value: unknown) => formatAmount(value, '$');
type Props = {
 modalItem: DisplayItem; vendorType: VendorDetail['vendorType'];
 selectedOptions: Record<string, string[]>; chooseOption: (_group: OptionGroup, _optionId: string) => void;
 itemQuantity: number; setItemQuantity: Dispatch<SetStateAction<number>>; busyItem: string | null;
 modalError: string | null; modalUnitPrice: number | null; cartHydrationPending: boolean;
 closeOptions: () => void; confirmOptions: () => void;
};
function optionGuidance(group: OptionGroup): string {
  const minimum = group.isRequired ? Math.max(1, group.minSelect) : group.minSelect;
  if (group.maxSelect <= 1) return minimum > 0 ? 'Choose 1' : 'Optional';
  if (minimum === group.maxSelect) return `Choose ${group.maxSelect}`;
  if (minimum > 0) return `Choose ${minimum}–${group.maxSelect}`;
  return `Optional · up to ${group.maxSelect}`;
}

/** What the person is told when the validator refuses their choices. */
export function ItemOptionsPanel({ modalItem, vendorType, selectedOptions, chooseOption, itemQuantity, setItemQuantity, busyItem, modalError, modalUnitPrice, cartHydrationPending, closeOptions, confirmOptions }: Props) {
 return (<Sheet labelledBy="menu-options-title" onClose={closeOptions} className={styles.sheet}>
          <div className={styles.sheetHeader}>
            <Photo src={modalItem.imageUrl} alt="" vendorType={vendorType} sizes="72px" iconSize={26} className={styles.sheetPhoto} />
            <div className={styles.sheetHeading}>
              <h2 id="menu-options-title" className={styles.modalTitle}>{modalItem.name}</h2>
              {modalItem.description ? <p className={styles.modalDescription}>{modalItem.description}</p> : null}
            </div>
            <button data-modal-initial-focus type="button" className={styles.closeButton} onClick={closeOptions} aria-label="Close item options">
              <X size={20} aria-hidden="true" />
            </button>
          </div>

          <div className={styles.options}>
            {(modalItem.optionGroups ?? []).map((group) => {
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
                              onChange={() => chooseOption(group, option.id)}
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
            {modalError ? <p id="menu-options-error" className={styles.modalAlert} role="alert">{modalError}</p> : null}
            <div className={styles.sheetFooterRow}>
              <div className={styles.quantity} role="group" aria-label="Quantity">
                <button type="button" className={styles.quantityButton} aria-label="Decrease quantity" disabled={itemQuantity <= 1 || busyItem !== null} onClick={() => setItemQuantity((count) => Math.max(1, count - 1))}><Minus size={18} aria-hidden="true" /></button>
                <span className={styles.quantityCount} role="status" aria-label={`Quantity ${itemQuantity}`}>{itemQuantity}</span>
                <button type="button" className={styles.quantityButton} aria-label="Increase quantity" disabled={itemQuantity >= 99 || busyItem !== null} onClick={() => setItemQuantity((count) => Math.min(99, count + 1))}><Plus size={18} aria-hidden="true" /></button>
              </div>
              <button
                type="button"
                className={`${styles.primaryButton} ${styles.sheetAdd}`}
                disabled={cartHydrationPending || busyItem !== null || modalUnitPrice === null}
                aria-describedby={modalError ? 'menu-options-error' : undefined}
                onClick={confirmOptions}
              >
                Add to order · {gyMoney(modalUnitPrice === null ? null : modalUnitPrice * itemQuantity)}
              </button>
            </div>
          </div>
        </Sheet>);
}
