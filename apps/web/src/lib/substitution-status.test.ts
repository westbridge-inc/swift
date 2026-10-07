import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SUBSTITUTION_STATUSES } from '@swift/types';

describe('shared substitution status contract', () => {
  it('matches the persisted server enum', () => {
    const schema = readFileSync('../api/prisma/schema.prisma', 'utf8');
    const values = schema.match(/enum SubstitutionStatus\s*\{([^}]+)\}/)![1]!.trim().split(/\s+/);
    expect([...SUBSTITUTION_STATUSES]).toEqual(values);
  });
});
