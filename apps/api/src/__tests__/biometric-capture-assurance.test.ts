import { afterEach, describe, expect, it } from 'vitest';
import {
  verificationBiometricFaceMatchEnabled,
} from '../lib/biometric-guard';
import { getKycProvider } from '../providers/kyc/kyc-provider';

const saved = {
  NODE_ENV: process.env['NODE_ENV'],
  KYC_PROVIDER: process.env['KYC_PROVIDER'],
  FEATURE_BIOMETRIC_FACE_MATCH: process.env['FEATURE_BIOMETRIC_FACE_MATCH'],
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('verification biometric capture assurance', () => {
  it('never treats a caller-supplied file as proof of live capture', () => {
    expect(verificationBiometricFaceMatchEnabled('USER_SUPPLIED_FILE', {
      NODE_ENV: 'production',
      FEATURE_BIOMETRIC_FACE_MATCH: '1',
    })).toBe(false);
    expect(verificationBiometricFaceMatchEnabled('USER_SUPPLIED_FILE', {
      NODE_ENV: 'development',
      FEATURE_BIOMETRIC_FACE_MATCH: '1',
    })).toBe(false);
  });

  it('allows the simulated branch only outside production', () => {
    expect(verificationBiometricFaceMatchEnabled('TEST_SIMULATED', {
      NODE_ENV: 'test',
      FEATURE_BIOMETRIC_FACE_MATCH: '1',
    })).toBe(true);
    expect(verificationBiometricFaceMatchEnabled('TEST_SIMULATED', {
      NODE_ENV: 'production',
      FEATURE_BIOMETRIC_FACE_MATCH: '1',
    })).toBe(false);
  });

  it('fails provider construction when the feature is enabled without liveness assurance', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['KYC_PROVIDER'] = 'manual';
    process.env['FEATURE_BIOMETRIC_FACE_MATCH'] = '1';
    expect(() => getKycProvider()).toThrow(/hosted-liveness/);
  });
});
