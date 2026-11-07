import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  branchAddress, branchDeliversWords, branchFactsLine, branchOpenWords, brandLine, brandTitle, currentBranchLabel, showsBranchSwitcher,
  type BrandBranch,
} from './brandCard';

const branch = (over: Partial<BrandBranch>): BrandBranch => ({
  id: 'b', name: 'Royal Camp', slug: 'royal-camp', addressLine1: '12 Camp Street', city: 'Georgetown',
  isCurrentlyOpen: true, acceptingOrders: true, distanceKm: null, delivers: null, current: false, ...over,
});

describe('[CHAINS] the brand card', () => {
  it('a chain card reads as the brand, with the branch it opens and how many there are', () => {
    expect(brandTitle('Royal Camp', { name: 'Royal Castle', branches: 4 })).toBe('Royal Castle');
    expect(brandLine({ name: 'Royal Castle', branches: 4 }, '12 Camp Street')).toBe('12 Camp Street · 4 branches');
    expect(brandLine({ name: 'Royal Castle', branches: 1 }, '12 Camp Street')).toBe('12 Camp Street');
    expect(brandLine({ name: 'Royal Castle', branches: 3 }, '  ')).toBe('3 branches');
  });
  it('a store on its own is untouched', () => {
    expect(brandTitle('Corner Shop', null)).toBe('Corner Shop');
    expect(brandTitle('Corner Shop', undefined)).toBe('Corner Shop');
    expect(brandLine(null, '1 Main Street')).toBeNull();
  });
});

describe('[CHAINS] the storefront branch switcher', () => {
  it('shown only with two or more branches', () => {
    expect(showsBranchSwitcher(null)).toBe(false);
    expect(showsBranchSwitcher({ name: 'R', branches: [branch({ current: true })] })).toBe(false);
    expect(showsBranchSwitcher({ name: 'R', branches: [branch({ current: true }), branch({ id: 'c' })] })).toBe(true);
  });
  it('names this branch', () => {
    expect(currentBranchLabel({ name: 'R', branches: [branch({ id: 'x' }), branch({ current: true, addressLine1: '3 Sheriff Street' })] }, 'Royal')).toBe('3 Sheriff Street branch');
    expect(currentBranchLabel(null, '1 Main Street')).toBe('1 Main Street branch');
  });
  it('each branch: open or closed, distance and delivery when known', () => {
    expect(branchOpenWords({ isCurrentlyOpen: true, acceptingOrders: false })).toBe('Closed');
    expect(branchDeliversWords(true)).toBe('Delivers to you');
    expect(branchDeliversWords(false)).toBe('Doesn’t deliver to you');
    expect(branchDeliversWords(null)).toBeNull();
    expect(branchFactsLine(branch({ distanceKm: 1.24, delivers: true }))).toBe('Open · 1.2 km · Delivers to you');
    expect(branchFactsLine(branch({ isCurrentlyOpen: false }))).toBe('Closed');
    expect(branchAddress(branch({}))).toBe('12 Camp Street, Georgetown');
  });
  it('the website says the same words: its copy is byte-identical', () => {
    const here = readFileSync(join(process.cwd(), 'src/lib/brandCard.ts'), 'utf8');
    const web = readFileSync(join(process.cwd(), '../web/src/lib/brand-card.ts'), 'utf8');
    expect(web).toBe(here);
  });
});
