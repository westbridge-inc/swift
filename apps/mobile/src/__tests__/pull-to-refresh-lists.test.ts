import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [UI-SWEEP U33] These list screens had no pull to refresh where their sibling
// lists do. Each now carries a RefreshControl bound to hooks/usePullToRefresh
// (the spinner follows the person's pull only: __tests__/pull-spinner-gate).
// The two lists paged by hand ("Load more") reload from the newest page: back
// to page 1 and their whole history family re-read, so a pull deep in the list
// never appends a page twice (the store's list is driven end to end in
// VendorOrderHistoryScreen.pull.navigation.test.ts).
// ---------------------------------------------------------------------------

const LISTS: Array<{ file: string; paged?: string }> = [
  { file: 'modules/mover/screens/EarningsScreen.tsx' },
  { file: 'modules/mover/screens/ClaimsScreen.tsx' },
  { file: 'modules/vendor/screens/VendorScheduleScreen.tsx' },
  { file: 'modules/chat/screens/ChatListScreen.tsx' },
  { file: 'modules/profile/screens/NotificationsScreen.tsx' },
  { file: 'modules/mover/screens/JobHistoryScreen.tsx', paged: "queryKey: ['mover', 'history', kind]" },
  { file: 'modules/vendor/screens/VendorOrderHistoryScreen.tsx', paged: "queryKey: ['vendor', 'orders', 'history']" },
];

const code = (file: string) => readFileSync(join(process.cwd(), 'src', file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('[UI-SWEEP U33] the lists that lacked it offer pull to refresh', () => {
  for (const { file, paged } of LISTS) {
    it(`${file}: a RefreshControl driven by the person's pull`, () => {
      const src = code(file);
      expect(src).toMatch(/const pull = usePullToRefresh\(/);
      expect(src).toMatch(/<RefreshControl refreshing=\{pull\.refreshing\} onRefresh=\{\(\) => \{ void pull\.onRefresh\(\); \}\}/);
      expect(src).toContain("from '../../../hooks/usePullToRefresh'");
    });

    if (paged) {
      it(`${file}: a pull goes back to page 1 and re-reads its whole history family`, () => {
        const body = code(file).match(/const pull = usePullToRefresh\(async \(\) => \{([\s\S]*?)\n {2}\}\);/)?.[1] ?? '';
        expect(body, 'the pull handler').not.toBe('');
        expect(body).toContain('setPage(1);');
        expect(body).toContain(`await qc.invalidateQueries({ ${paged} });`);
      });
    }
  }
});
