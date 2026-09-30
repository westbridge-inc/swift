import { describe, expect, it } from 'vitest';
import { VerificationService } from '../modules/verification/verification.service';

describe('identity signal module boundaries', () => {
  it('loads verification through the leaf identity-type authority without an initialization cycle', () => {
    expect(VerificationService).toBeTypeOf('function');
  });
});
