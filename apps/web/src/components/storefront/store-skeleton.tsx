import { Bone, LoadingRegion } from '@/components/customer-skeletons';
import styles from './storefront.module.css';

/**
 * [W6] The store page's loading shape, drawn with the page's own classes (the
 * cover, the title row, the facts, the section chips and the menu cards), so
 * the store lands in exactly the space its placeholder held.
 */
export function StoreSkeleton() {
  return (
    <LoadingRegion label="Loading this store" className={styles.page}>
      <div className={styles.content}>
        <div className={styles.storeHead}>
          <Bone className={styles.cover} />
          <div className={styles.titleRow}>
            <div className={styles.titleCopy}>
              <Bone className="h-9 w-64 max-w-full" />
              <Bone className="mt-2 h-5 w-48" />
            </div>
          </div>
          <div className={styles.facts}>
            <Bone className={`${styles.fact} w-20`} />
            <Bone className={`${styles.fact} w-28`} />
          </div>
        </div>
        <div className={styles.categoryNav}>
          {[1, 2, 3].map((chip) => <Bone key={chip} className={`${styles.categoryLink} w-24`} />)}
        </div>
        <div className={styles.layout}>
          <div className={styles.menu}>
            <section className={styles.section}>
              <Bone className={`${styles.sectionTitle} h-7 w-36`} />
              <div className={styles.rows}>
                {[1, 2, 3, 4].map((card) => (
                  <div key={card} className={styles.menuRow}>
                    <div className={styles.itemCopy}>
                      <Bone className="h-6 w-3/4" />
                      <Bone className="mt-1 h-9" />
                      <div className={styles.itemFoot}><Bone className="h-6 w-16" /><Bone className="h-11 w-20 rounded-full" /></div>
                    </div>
                    <Bone className={styles.itemImage} />
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
