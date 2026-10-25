import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ImportPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// [GUARDRAILS §8] Owner ruling (13 Oct): a row whose own words carry a banned word
// (rum cake, cough syrup) still imports, but is held hidden for a quick check. The
// import result names those rows, so the partner is not left wondering why they
// cannot see them on their store.
describe('bulk import names the rows waiting for a quick check', () => {
  const preview = { mapping: { name: 'name' }, rowCount: 3, preview: [{ name: 'Rum cake' }], normalizedCsv: 'category,name,basePrice\nCakes,Rum cake,1200' };

  it('lists the held rows by row number and name, beside the imported count', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/vendor/items/import/automap') return { body: { data: preview } };
      if (url.pathname === '/api/v1/vendor/items/import') return { body: { data: {
        imported: 3, failedCount: 0, failures: [],
        waitingForCheck: [{ row: 2, name: 'Rum cake' }, { row: 4, name: 'Cough syrup' }], waitingForCheckCount: 2,
      } } };
      throw new Error(`Unexpected request: ${url}`);
    });
    const { user, container } = renderWithQuery(<ImportPage />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['category,name,basePrice\nCakes,Rum cake,1200'], 'menu.csv', { type: 'text/csv' }));
    await user.click(await screen.findByRole('button', { name: 'Import 3 items' }));
    expect(await screen.findByText('✓ 3 items imported')).toBeTruthy();
    expect(screen.getByText('2 waiting for a quick check — hidden from customers until Swift checks them:')).toBeTruthy();
    expect(screen.getByText('Row 2: Rum cake')).toBeTruthy();
    expect(screen.getByText('Row 4: Cough syrup')).toBeTruthy();
  });

  it('says how many more are held beyond the rows the server listed', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/vendor/items/import/automap') return { body: { data: preview } };
      if (url.pathname === '/api/v1/vendor/items/import') return { body: { data: {
        imported: 3, failedCount: 0, failures: [], waitingForCheck: [{ row: 2, name: 'Rum cake' }], waitingForCheckCount: 120,
      } } };
      throw new Error(`Unexpected request: ${url}`);
    });
    const { user, container } = renderWithQuery(<ImportPage />);
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, new File(['x'], 'menu.csv', { type: 'text/csv' }));
    await user.click(await screen.findByRole('button', { name: 'Import 3 items' }));
    expect(await screen.findByText('…and 119 more')).toBeTruthy();
  });

  it('names the rows imported without their photo address [IMAGES-E2E PR4: photos are uploaded, never imported]', async () => {
    const note = 'Imported without its photo: a photo address is not used. Add the photo by uploading it in the app or on the website.';
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/vendor/items/import/automap') return { body: { data: preview } };
      if (url.pathname === '/api/v1/vendor/items/import') return { body: { data: {
        imported: 3, failedCount: 0, failures: [], notes: [{ row: 3, note }], notesCount: 1,
      } } };
      throw new Error(`Unexpected request: ${url}`);
    });
    const { user, container } = renderWithQuery(<ImportPage />);
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, new File(['x'], 'menu.csv', { type: 'text/csv' }));
    await user.click(await screen.findByRole('button', { name: 'Import 3 items' }));
    expect(await screen.findByText('1 row was imported without a photo. Photos are uploaded, never imported: add them on each item.')).toBeTruthy();
    expect(screen.getByText(`Row 3: ${note}`)).toBeTruthy();
  });

  it('says nothing about a check when no row is held (and an older server sends no such field)', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/vendor/items/import/automap') return { body: { data: preview } };
      if (url.pathname === '/api/v1/vendor/items/import') return { body: { data: { imported: 3, failedCount: 0, failures: [] } } };
      throw new Error(`Unexpected request: ${url}`);
    });
    const { user, container } = renderWithQuery(<ImportPage />);
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, new File(['x'], 'menu.csv', { type: 'text/csv' }));
    await user.click(await screen.findByRole('button', { name: 'Import 3 items' }));
    await waitFor(() => expect(screen.getByText('✓ 3 items imported')).toBeTruthy());
    expect(screen.queryByText(/waiting for a quick check/)).toBeNull();
    expect(screen.queryByText(/imported without a photo/)).toBeNull();
  });
});
