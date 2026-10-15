// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SUBSTITUTION_STATUSES } from '@swift/types';

describe('shared substitution status contract', () => {
  it('matches the persisted server enum', () => {
    const schema = readFileSync(new URL('../../../api/prisma/schema.prisma', import.meta.url), 'utf8');
    const body = schema.match(/enum SubstitutionStatus\s*\{([^}]+)\}/)?.[1];
    expect(body).toBeDefined();
    const values = body?.trim().split(/\s+/);
    expect([...SUBSTITUTION_STATUSES]).toEqual(values);
  });
});
