import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ImportPage from './page';
import { renderWithQuery } from '@/test/test-utils';

// [REVIEW-F S4-2] The import calls load when a file is chosen. When their code fails to arrive (a dropped request, or a
// deploy while the page is open) it is tried once more (the shared retryImport), and a failure that remains is told in
// plain words: never webpack's own "Loading chunk N failed" with its address.

const { chunkError } = vi.hoisted(() => ({
  chunkError: () => Object.assign(
    new Error('Loading chunk 4242 failed. (error: https://example.test/_next/static/chunks/4242.js)'),
    { name: 'ChunkLoadError' },
  ),
}));
// The page's one on-demand piece (the panels, which carry the calls) never arrives.
vi.mock('./panels', () => { throw chunkError(); });

describe('the import tools fail to load', () => {
  it('says so in plain words, never the loader’s own message', async () => {
    const { user } = renderWithQuery(<ImportPage />);
    await user.upload(screen.getByLabelText('Choose a CSV or Excel file'), new File(['SKU,Name,Price,Qty\nRICE,Rice,3600,35'], 'till.csv', { type: 'text/csv' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Couldn\'t load the import tools. Check your connection and try again.');
    expect(alert.textContent).not.toMatch(/chunk|_next|https?:|vitest|mock/i);
  });

  it('the calls’ code is loaded through the shared retry, and a load that still fails becomes the plain words', () => {
    const source = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    expect(source).toContain('const loadCalls = retryImport(panels);');
    expect(source).toContain('const importApi = () => loadCalls().catch(() => { throw new Error(LOAD_FAILED); });');
  });

  it('[W2] the page has ONE on-demand piece (each one adds its address to the loader every page downloads first)', () => {
    const source = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    expect(source.match(/import\(/g)).toHaveLength(1);
    expect(source).toContain('const panels = () => import(\'./panels\');');
  });
});
