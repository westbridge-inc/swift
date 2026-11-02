import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BICYCLE_DOCUMENTS, MOTOR_DOCUMENTS, TAXI_DOCUMENTS, VEHICLE_DOCUMENTS } from '@/lib/vehicle-documents';

// [WEB-WORDING · 1 Nov 2026] Partners read these pages before they sign up (GUARDRAILS §8: no misleading
// claims). Each claim below is pinned to the code that makes it true, not to a sentence someone remembered.
const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');
const API = join(__dirname, '..', '..', '..', '..', 'api', 'src', 'modules');
const PLATFORM_CONFIG = readFileSync(join(API, 'ops', 'platform-config.ts'), 'utf8');
const SERVICE_CATALOG = readFileSync(join(API, 'services', 'service-catalog.ts'), 'utf8');
const VEHICLE_CLASSES = readFileSync(join(API, '..', 'config', 'vehicle-classes.ts'), 'utf8');
const VERIFICATION = readFileSync(join(API, 'verification', 'verification.service.ts'), 'utf8');

/** One vehicle's docProfiles from config/vehicle-classes VEHICLE_CLASSES, read off the server's own source. */
function docProfiles(type: string): string[] {
  const m = VEHICLE_CLASSES.match(new RegExp(`\\n\\s*${type}: \\{[^}]*?docProfiles: \\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${type} has no docProfiles in vehicle-classes`);
  return [...(m[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((x) => x[1] ?? '');
}

/** One launch checklist from DEFAULT_DOCUMENT_CHECKLISTS, read off the server's own source. */
function checklist(key: string): string[] {
  const m = PLATFORM_CONFIG.match(new RegExp(`\\n\\s*${key}: \\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${key} is not in platform-config`);
  return [...(m[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1] ?? '');
}

describe('the drivers page names each vehicle’s real documents', () => {
  const page = read('drivers/page.tsx');

  it('uses the server’s own lists: motorbike, bicycle, and the seven taxi documents', () => {
    expect([...MOTOR_DOCUMENTS]).toEqual(checklist('MOVER_MOTOR'));
    expect([...BICYCLE_DOCUMENTS]).toEqual(checklist('MOVER_NO_LICENCE'));
    expect([...TAXI_DOCUMENTS]).toEqual([...checklist('MOVER_MOTOR'), ...checklist('MOVER_TAXI_EXTRA')]);
    expect(TAXI_DOCUMENTS).toHaveLength(7);
  });

  it('[REVIEW-G S4] each card is the server’s vehicle -> checklist map, and its documents are those profiles', () => {
    for (const v of VEHICLE_DOCUMENTS) {
      for (const type of v.vehicleTypes) expect(docProfiles(type)).toEqual(v.profiles);
      expect([...v.docs]).toEqual(v.profiles.flatMap(checklist));
    }
  });

  it('[REVIEW-F S2 · R13] every motor card says the insurance must permit use for hire or reward, the rule the server enforces', () => {
    expect(VERIFICATION).toMatch(/INSURANCE_NOT_HIRE: 'This policy does not permit use for hire or reward\./);
    expect(VEHICLE_CLASSES).toMatch(/docProfiles\.includes\('MOVER_MOTOR'\)/);
    for (const v of VEHICLE_DOCUMENTS) {
      if (v.profiles.includes('MOVER_MOTOR')) expect(v.note).toMatch(/insurance must permit use for hire or reward/);
      else expect(v.note).not.toMatch(/hire or reward/);
    }
  });

  it('shows one card per vehicle, a motorised bicycle signing up as a motorbike', () => {
    expect(VEHICLE_DOCUMENTS.map((v) => v.vehicle)).toEqual(['Motorbike rider', 'Bicycle rider', 'Taxi driver']);
    expect(VEHICLE_DOCUMENTS[0]?.note).toMatch(/bicycle with any kind of motor signs up as a motorbike/i);
    expect(VEHICLE_DOCUMENTS[1]?.labels).toEqual(['National ID or Digital ID card']);
    expect(page).toMatch(/VEHICLE_DOCUMENTS\.map/);
  });

  it('no longer says four documents or a government ID for everyone', () => {
    expect(page).not.toMatch(/Four documents/i);
    expect(page).not.toMatch(/government ID/i);
  });
});

describe('the businesses page makes only claims Swift can prove', () => {
  const page = read('vendors/page.tsx');

  it('says Swift takes no cut, without comparing itself to every other platform', () => {
    expect(page).not.toMatch(/the only delivery platform/i);
    expect(page).not.toMatch(/\bonly\b[^.]{0,40}\b(platform|app|service)\b/i);
    expect(page).toMatch(/Swift takes no cut\. You keep 100% of every sale, for one flat weekly fee\./);
  });
});

describe('the pricing Services card names only trades open today', () => {
  const page = read('pricing/page.tsx');
  const card = page.slice(page.indexOf('title="Services"'), page.indexOf('</PriceCard>', page.indexOf('title="Services"')));

  it('names no held trade (service-catalog PENDING_CATEGORIES)', () => {
    const held = SERVICE_CATALOG.match(/PENDING_CATEGORIES = new Set<ServiceTradeId>\(\[([^\]]*)\]/);
    expect(held).not.toBeNull();
    const ids = [...(held?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1] ?? '');
    expect(ids).toContain('barber');
    for (const id of ids) expect(card.toLowerCase()).not.toContain(id.replaceAll('_', ' '));
    expect(card).toMatch(/Plumbers, electricians, mechanics, tutors/);
  });
});
