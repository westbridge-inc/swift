import type { ReactNode } from 'react';
import type { StorefrontSeller } from '@/lib/api';
import styles from './storefront.module.css';

/**
 * [R3 · Consumer Affairs Act 2011 s.70 · legal research D10 + E5] Who sells, how payment works and the store's
 * refund rule — on every store page. The API projects the block from what Swift holds on file; a fact it does
 * not hold arrives as null and reads "Ask the store", never a blank and never a guess. The statutory-rights
 * sentence comes from the API too, so the website and the app print the same words.
 */
export const ASK_THE_STORE = 'Ask the store';

/** How payment works: cash at handover always; MMG only into the store's own account, when it offers it. */
export function sellerPaymentLine(payment: StorefrontSeller['payment']): string {
  return payment.storeMmg
    ? 'Cash at handover, or MMG straight to the store’s own MMG account'
    : 'Cash at handover';
}

export function SellerInfo({ seller }: { seller: StorefrontSeller }) {
  const facts: Array<[string, ReactNode]> = [
    ['Legal name', seller.legalName ?? ASK_THE_STORE],
    ['Business address', seller.address ?? ASK_THE_STORE],
    ['Phone', seller.phone ? <a href={`tel:${seller.phone}`}>{seller.phone}</a> : ASK_THE_STORE],
    ['How payment works', sellerPaymentLine(seller.payment)],
  ];
  return (
    <section className={styles.seller} aria-labelledby="seller-info">
      <h2 id="seller-info" className={styles.sellerTitle}>Seller information</h2>
      <dl className={styles.sellerFacts}>
        {facts.map(([label, value]) => (
          <div key={label} className={styles.sellerFact}>
            <dt className={styles.sellerLabel}>{label}</dt>
            <dd className={styles.sellerValue}>{value}</dd>
          </div>
        ))}
        <div className={styles.sellerFact}>
          <dt className={styles.sellerLabel}>Refunds</dt>
          <dd className={styles.sellerValue}>
            {seller.refundRule ?? ASK_THE_STORE}
            <p className={styles.sellerRights}>{seller.statutoryRights}</p>
          </dd>
        </div>
      </dl>
    </section>
  );
}
