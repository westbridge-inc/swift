import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogueName, yourCatalogue } from './catalogue-name';

// [WEB-ONBOARDING · FLOW-QA F20] A supermarket's Inventory page was headed "YOUR MENU". The line under the tab name now
// follows the store's type, like the tab: Your menu, Your inventory, Your products, Your services.
describe('[F20] the catalogue heading follows the store type', () => {
  it('each type', () => {
    expect(['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE'].map((t) => yourCatalogue(catalogueName(t)))).toEqual(['Your menu', 'Your inventory', 'Your products', 'Your services']);
  });
  it('the Inventory page uses it, never a fixed "Your menu"', () => {
    const page = readFileSync(join(__dirname, '..', 'app', 'dashboard', 'inventory', 'page.tsx'), 'utf8');
    expect(page).toContain('{yourCatalogue(catalogue)}');
    expect(page).not.toContain('tracking-wide">Your menu</span>');
  });
});
