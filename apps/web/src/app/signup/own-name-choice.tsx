'use client';

// [ROLE-DOCS · #2046 · perf] The own-name choice and the declaration's words (BNA s.3), loaded on the business
// step only for a store type that is asked for a business registration (own-name-loader.ts; page-size.test.ts).
// The page keeps the choice and the tick, and signs after the store exists; this block only shows them.
import { OWN_NAME_DECLARATION_WEB, ownNameSigningFor } from '@/lib/own-name-copy';
import styles from '../auth-flow.module.css';

export type NameBasis = 'REGISTERED' | 'OWN_NAME';

export function OwnNameChoice({ storeName, nameBasis, onNameBasis, tick, onTick }: {
  storeName: string;
  nameBasis: NameBasis;
  onNameBasis: (_basis: NameBasis) => void;
  tick: boolean;
  onTick: (_ticked: boolean) => void;
}) {
  return (
    <fieldset className={styles.field}>
      <legend className={styles.label}>What name does your store use?</legend>
      <label><input type="radio" name="name-basis" checked={nameBasis === 'OWN_NAME'} onChange={() => { onNameBasis('OWN_NAME'); onTick(false); }} /> My own name — just my surname, with or without my first names or initials (for example “Persaud” or “R. Persaud”)</label>
      <label><input type="radio" name="name-basis" checked={nameBasis === 'REGISTERED'} onChange={() => { onNameBasis('REGISTERED'); onTick(false); }} /> A business name, or a company</label>
      {nameBasis === 'OWN_NAME' ? (
        <>
          <p className={styles.bodyCopy}>The law does not ask you to register your own name as a business name, so you sign a short declaration instead of uploading a business registration. A person on our team checks it against your ID.</p>
          {ownNameSigningFor(storeName) ? <p className={styles.bodyCopy}><strong>{ownNameSigningFor(storeName)}</strong></p> : null}
          <pre className={styles.bodyCopy} style={{ whiteSpace: 'pre-wrap' }}>{OWN_NAME_DECLARATION_WEB}</pre>
          <label><input type="checkbox" checked={tick} onChange={(e) => onTick(e.target.checked)} /> I have read the declaration above and I sign it.</label>
        </>
      ) : null}
    </fieldset>
  );
}
