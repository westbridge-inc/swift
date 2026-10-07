import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  crashEnvironment,
  crashSdkOptions,
  resetCrashReportingForTests,
  startCrashReporting,
  usableDsn,
} from './crashReporting';
import { reportCrash } from './crash-reporter';

const DSN = 'https://publickey@errors.example.test/7';

function fakeSdk() {
  return { init: vi.fn(), captureException: vi.fn() };
}

afterEach(() => {
  resetCrashReportingForTests();
  vi.restoreAllMocks();
});

describe('remote crash reporting is OFF unless a DSN is configured (L13 item 7)', () => {
  it('no DSN, an empty DSN, or a non-https DSN: the SDK is never initialised and nothing is sent', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const dsn of [undefined, '', '   ', 'http://publickey@errors.example.test/7', 'not a url', 'https://errors.example.test/7']) {
      const sdk = fakeSdk();
      expect(startCrashReporting(sdk, { dsn, environment: 'production' }), String(dsn)).toBe(false);
      reportCrash(new Error('boom'), { source: 'boundary' });
      expect(sdk.init, String(dsn)).not.toHaveBeenCalled();
      expect(sdk.captureException, String(dsn)).not.toHaveBeenCalled();
    }
  });

  it('a usable DSN starts it once, with the privacy options, and boundary crashes are captured', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sdk = fakeSdk();
    expect(startCrashReporting(sdk, { dsn: DSN, environment: 'production' })).toBe(true);
    expect(startCrashReporting(sdk, { dsn: DSN, environment: 'production' })).toBe(true);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init.mock.calls[0]![0]).toMatchObject({ dsn: DSN, environment: 'production', sendDefaultPii: false });

    reportCrash(new Error('render'), { source: 'boundary', componentStack: 'in X' });
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
  });

  it('uncaught global errors are left to the SDK\'s own handler, so a crash is not reported twice', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sdk = fakeSdk();
    startCrashReporting(sdk, { dsn: DSN, environment: 'production' });
    reportCrash(new Error('global'), { fatal: true, source: 'global' });
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it('an SDK that throws on init leaves reporting off and the app running', () => {
    const sdk = { init: vi.fn(() => { throw new Error('native module missing'); }), captureException: vi.fn() };
    expect(startCrashReporting(sdk, { dsn: DSN, environment: 'production' })).toBe(false);
  });

  it('usableDsn accepts only https DSNs with a key and a project', () => {
    expect(usableDsn(` ${DSN} `)).toBe(DSN);
    expect(usableDsn('https://errors.example.test/')).toBeNull();
  });
});

describe('the SDK options send diagnostics only', () => {
  const options = crashSdkOptions(DSN, 'production');

  it('no default PII, no tracing, no replay, no screenshots, no view tree, no failed-request capture, no sessions, no native URL breadcrumbs', () => {
    expect(options).toMatchObject({
      sendDefaultPii: false,
      // Native crashes are captured; native reports do not pass the JS scrubber,
      // so breadcrumbs and thread dumps are switched off at the source.
      enableNative: true,
      enableNativeCrashHandling: true,
      maxBreadcrumbs: 0,
      attachThreads: false,
      tracesSampleRate: 0,
      enableAutoPerformanceTracing: false,
      enableUserInteractionTracing: false,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      attachScreenshot: false,
      attachViewHierarchy: false,
      enableCaptureFailedRequests: false,
      enableAutoSessionTracking: false,
      enableNetworkBreadcrumbs: false,
      enableNetworkTracking: false,
      enableSwizzling: false,
    });
  });

  it('every event and breadcrumb passes the scrubber', () => {
    const beforeSend = options['beforeSend'] as (e: object) => Record<string, unknown>;
    const beforeBreadcrumb = options['beforeBreadcrumb'] as (b: object) => unknown;
    const sent = beforeSend({ message: 'failed for +592 555 0142', user: { email: 'jane.doe@example.com' } });
    expect(sent['user']).toBeUndefined();
    expect(sent['message']).toBe('failed for [redacted]');
    expect(beforeBreadcrumb({ category: 'console', message: 'jane.doe@example.com' })).toBeNull();
  });
});

describe('boot wiring', () => {
  it('the app reads the DSN from EXPO_PUBLIC_SENTRY_DSN only, and boots crash reporting before anything else', () => {
    const boot = readFileSync(join(__dirname, 'crashReportingBoot.ts'), 'utf8');
    expect(boot).toMatch(/dsn: process\.env\.EXPO_PUBLIC_SENTRY_DSN,/);
    expect(boot).toMatch(/from '@sentry\/react-native'/);
    expect(boot).not.toMatch(/setUser|https:\/\//);
    const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
    const firstImport = app.split('\n').find((line) => line.startsWith('import '));
    expect(firstImport).toBe("import './lib/crashReportingBoot';");
  });

  it('nothing in the app attaches a user to crash reports', () => {
    let hits = '';
    try {
      hits = execFileSync('grep', ['-rlE', 'Sentry\\.(setUser|setContext|setExtra)', join(__dirname, '..')], { encoding: 'utf8' });
    } catch {
      hits = ''; // grep exits 1 when nothing matches
    }
    expect(hits).toBe('');
  });

  it('environment labels follow the build\'s API origin', () => {
    expect(crashEnvironment('https://api.swiftgy.com', false)).toBe('production');
    expect(crashEnvironment('https://api-staging.swiftgy.com', false)).toBe('staging');
    expect(crashEnvironment('https://api.swiftgy.com', true)).toBe('development');
    expect(crashEnvironment(undefined, false)).toBe('other');
  });
});
