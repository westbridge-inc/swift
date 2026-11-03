import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [PERF] The sign-up page's first load carried the store map picker (its map,
// place search and location code, about a fifth of the page's own code),
// though only a store owner on the business step ever opens it. The picker's
// code now loads on demand (ahead of the tap, once a store reaches that step);
// its stylesheet stays in the page so the on-demand piece is code only. The
// picker's behaviour is unchanged (store-pin.test.tsx); a failed fetch is
// covered by store-picker-retry.test.tsx.
// ---------------------------------------------------------------------------

const page = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
const loader = readFileSync(join(__dirname, 'store-picker-loader.ts'), 'utf8');
const staticImports = page.split('\n').filter((line) => /^import\s/.test(line));
// [D6 · WEB-ONBOARDING] The business and vehicle steps are their own chunk (partner-steps.tsx), loaded on demand: the
// loaders below now live there, so the page's first load carries none of them.
const steps = readFileSync(join(__dirname, 'partner-steps.tsx'), 'utf8');
const stepImports = steps.split('\n').filter((line) => /^import\s/.test(line));

describe('[D6] the sign-up page loads the partner steps on demand', () => {
  const stepsLoader = readFileSync(join(__dirname, 'partner-steps-loader.ts'), 'utf8');
  it('imports them only as a type, through their loader', () => {
    expect(staticImports.filter((line) => /partner-steps'/.test(line) && !/^import type /.test(line))).toEqual([]);
    expect(staticImports).toContain("import { loadPartnerSteps } from './partner-steps-loader';");
    expect(stepsLoader).toContain("export const loadPartnerSteps = () => import('./partner-steps');");
    expect(stepsLoader.split('\n').filter((line) => /^import\s/.test(line))).toEqual([]);
  });

  it('the page carries none of the business or vehicle step code', () => {
    for (const gone of ['store-pin', 'taxi-documents', 'own-name-store-type', 'weekly-fee-loader', 'store-picker-loader', 'own-name-loader']) {
      expect(staticImports.filter((line) => line.includes(gone)), gone).toEqual([]);
    }
    expect(page).not.toMatch(/MOVER_VEHICLES|TAXI_PLATE|becomePartner|storePinInMarket|businessAsk|taxiAsk/);
  });
});

describe('[PERF] the sign-up page does not load the store map picker up front', () => {
  it('imports the picker’s code only on demand (a type import costs nothing at run time)', () => {
    expect([...staticImports, ...stepImports].filter((line) => /store-location-picker'/.test(line) && !/^import type /.test(line))).toEqual([]);
    expect(stepImports).toContain("import { loadStorePicker } from './store-picker-loader';");
    expect(loader).toContain("export const loadStorePicker = () => import('@/components/store-location-picker');");
    expect(loader.split('\n').filter((line) => /^import\s/.test(line))).toEqual([]);
  });

  it('keeps the picker’s stylesheet in the page, so only code is fetched on demand', () => {
    expect(staticImports).toContain("import '@/components/store-location-picker.module.css';");
  });
});

describe('[PERF · row 628] the weekly fee block loads on the partner steps only', () => {
  const feeLoader = readFileSync(join(__dirname, 'weekly-fee-loader.ts'), 'utf8');
  it('imports the block and its price read on demand (type imports cost nothing at run time)', () => {
    expect([...staticImports, ...stepImports].filter((line) => /weekly-fee'|signup-fee'/.test(line) && !/^import type /.test(line))).toEqual([]);
    expect(stepImports).toContain("import { loadWeeklyFee } from './weekly-fee-loader';");
    expect(feeLoader).toContain("export const loadWeeklyFee = () => import('./weekly-fee');");
    expect(feeLoader.split('\n').filter((line) => /^import\s/.test(line))).toEqual([]);
  });
});

describe('[ROLE-DOCS · #2046 · perf] the own-name choice and its declaration load on the business step only', () => {
  const ownNameLoader = readFileSync(join(__dirname, 'own-name-loader.ts'), 'utf8');
  it('the page holds neither the declaration’s words nor the choice up front (type imports cost nothing at run time)', () => {
    expect([...staticImports, ...stepImports].filter((line) => /own-name-copy'|own-name-choice'/.test(line) && !/^import type /.test(line))).toEqual([]);
    expect(stepImports).toContain("import { loadOwnNameChoice } from './own-name-loader';");
    expect(stepImports).toContain("import { ownNameStoreType } from '@/lib/own-name-store-type';");
    expect(page + steps).not.toMatch(/OWN_NAME_DECLARATION_WEB|I TRADE UNDER MY OWN NAME/);
    expect(ownNameLoader).toContain("export const loadOwnNameChoice = () => import('./own-name-choice');");
    expect(ownNameLoader.split('\n').filter((line) => /^import\s/.test(line))).toEqual([]);
  });
});
