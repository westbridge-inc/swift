import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportCrash, setCrashReporter, installGlobalErrorHandler } from './crash-reporter';

// SWIFT-013: the crash safety net. These cover the pure logic (RN-free): the
// reporter routing/coercion/isolation, and the global-handler wiring against a
// mocked ErrorUtils. The ErrorBoundary component + on-device fatal capture need
// device QA on top.

describe('crash-reporter (SWIFT-013)', () => {
  beforeEach(() => setCrashReporter(null));
  afterEach(() => {
    setCrashReporter(null);
    delete (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
  });

  it('routes a caught error to the installed reporter with its context', () => {
    const spy = vi.fn();
    setCrashReporter(spy);
    const err = new Error('boom');
    reportCrash(err, { screen: 'Checkout' });
    expect(spy).toHaveBeenCalledWith(err, { screen: 'Checkout' });
  });

  it('coerces a non-Error throw and never throws when no reporter is set', () => {
    expect(() => reportCrash('string crash')).not.toThrow();
    const spy = vi.fn();
    setCrashReporter(spy);
    reportCrash('string crash');
    const arg = spy.mock.calls[0]![0] as Error;
    expect(arg).toBeInstanceOf(Error);
    expect(arg.message).toBe('string crash');
  });

  it('a reporter that itself throws never propagates out of reportCrash', () => {
    setCrashReporter(() => {
      throw new Error('reporter down');
    });
    expect(() => reportCrash(new Error('x'))).not.toThrow();
  });

  it('installGlobalErrorHandler wires ErrorUtils to route uncaught errors AND chains the prior handler', () => {
    const set = vi.fn();
    const prev = vi.fn();
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
      getGlobalHandler: () => prev,
      setGlobalHandler: set,
    };
    const spy = vi.fn();
    setCrashReporter(spy);

    installGlobalErrorHandler();
    expect(set).toHaveBeenCalledOnce();

    // invoke the handler RN would call on an uncaught fatal error
    const wired = set.mock.calls[0]![0] as (e: unknown, fatal?: boolean) => void;
    const e = new Error('uncaught');
    wired(e, true);
    expect(spy).toHaveBeenCalledWith(e, { fatal: true, source: 'global' });
    expect(prev).toHaveBeenCalledWith(e, true); // RN's own redbox/native report still fires
  });

  it('installGlobalErrorHandler no-ops safely outside a RN runtime (no ErrorUtils)', () => {
    expect(() => installGlobalErrorHandler()).not.toThrow();
  });
});
