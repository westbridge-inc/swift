import { describe, expect, it, vi } from 'vitest';
import {
  armServiceJobDueWakeup,
  localServiceJobDateTime,
  parseServiceQuoteInput,
  serviceJobDueDelayMs,
  serviceJobErrorMessage,
  serviceJobScheduleDays,
  showsServiceJobAgreedPrice,
} from './serviceJobPresentation';

const NativeDate = Date;
const GUYANA_BEHIND_UTC_MS = 4 * 60 * 60 * 1000;

/**
 * Exercise the device-local scheduling contract against Guyana wall time
 * without changing the test worker's TZ. Restoration in finally keeps the
 * fake calendar scoped to one assertion.
 */
function withGuyanaLocalCalendar<T>(run: () => T): T {
  class GuyanaDate extends NativeDate {
    constructor(...args: unknown[]) {
      if (args.length >= 2) {
        const numbers = args.map(Number);
        const year = numbers[0]!;
        const month = numbers[1]!;
        const day = numbers[2] ?? 1;
        const hour = numbers[3] ?? 0;
        const minute = numbers[4] ?? 0;
        const second = numbers[5] ?? 0;
        const millisecond = numbers[6] ?? 0;
        super(NativeDate.UTC(year, month, day, hour, minute, second, millisecond) + GUYANA_BEHIND_UTC_MS);
      } else if (args.length === 1) {
        const [value] = args;
        super(value instanceof NativeDate ? value.getTime() : value as string | number);
      } else {
        super();
      }
    }

    private wallTime(): Date {
      return new NativeDate(this.getTime() - GUYANA_BEHIND_UTC_MS);
    }

    override getFullYear(): number { return this.wallTime().getUTCFullYear(); }
    override getMonth(): number { return this.wallTime().getUTCMonth(); }
    override getDate(): number { return this.wallTime().getUTCDate(); }
    override getHours(): number { return this.wallTime().getUTCHours(); }
    override getMinutes(): number { return this.wallTime().getUTCMinutes(); }

    override setHours(hour: number, minute?: number, second?: number, millisecond?: number): number {
      const wallTime = this.wallTime();
      wallTime.setUTCHours(hour, minute, second, millisecond);
      return this.setTime(wallTime.getTime() + GUYANA_BEHIND_UTC_MS);
    }

    override setDate(day: number): number {
      const wallTime = this.wallTime();
      wallTime.setUTCDate(day);
      return this.setTime(wallTime.getTime() + GUYANA_BEHIND_UTC_MS);
    }
  }

  vi.stubGlobal('Date', GuyanaDate);
  try {
    return run();
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('service-job presentation contract', () => {
  it('keeps the agreed quote visible through every contracted and completed state', () => {
    expect(showsServiceJobAgreedPrice('QUOTED')).toBe(false);
    expect(showsServiceJobAgreedPrice('SCHEDULED')).toBe(true);
    expect(showsServiceJobAgreedPrice('IN_PROGRESS')).toBe(true);
    expect(showsServiceJobAgreedPrice('COMPLETED')).toBe(true);
  });

  it('parses exact two-decimal quote input without rounding', () => {
    expect(parseServiceQuoteInput('15000')).toBe(15000);
    expect(parseServiceQuoteInput('15000.25')).toBe(15000.25);
    expect(parseServiceQuoteInput('0.01')).toBe(0.01);
    expect(parseServiceQuoteInput('0')).toBeNull();
    expect(parseServiceQuoteInput('0.001')).toBeNull();
    expect(parseServiceQuoteInput('15000.009')).toBeNull();
  });

  it.each([
    ['PROVIDER_NOT_VERIFIED', 'Your verification has lapsed — renew your documents before taking new work.'],
    ['JOB_NOT_DUE', 'This job cannot start before its agreed time.'],
    ['SERVICE_JOB_CHANGED', 'This job changed — refresh it before trying again.'],
  ])('renders the canonical %s AppError message', (_code, message) => {
    const error = { response: { data: { error: { code: _code, message } } } };
    expect(serviceJobErrorMessage(error, 'Generic failure')).toBe(message);
  });

  it('retains the legacy message fallback and then safe generic copy', () => {
    expect(serviceJobErrorMessage({ response: { data: { message: 'Legacy failure' } } }, 'Generic failure'))
      .toBe('Legacy failure');
    expect(serviceJobErrorMessage({}, 'Generic failure')).toBe('Generic failure');
  });

  it('wakes exactly when the server-provided due instant arrives', () => {
    let nowMs = Date.parse('2026-09-20T12:59:59.000Z');
    let callback: (() => void) | undefined;
    const setTimer = vi.fn((next: () => void, _delay: number) => {
      callback = next;
      return 7 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimer = vi.fn();
    const onDue = vi.fn();
    const due = '2026-09-20T13:00:00.000Z';

    const cancel = armServiceJobDueWakeup(due, () => nowMs, setTimer, clearTimer, onDue);
    expect(serviceJobDueDelayMs(due, nowMs)).toBe(1000);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(onDue).not.toHaveBeenCalled();

    nowMs = Date.parse(due);
    callback?.();
    expect(onDue).toHaveBeenCalledOnce();

    cancel();
    expect(clearTimer).toHaveBeenCalledWith(7);
  });

  it('reports due immediately when foreground resume re-arms after native timer suspension', () => {
    let nowMs = Date.parse('2026-09-20T12:59:59.000Z');
    const setTimer = vi.fn((_callback: () => void, _delay: number) => (
      8 as unknown as ReturnType<typeof setTimeout>
    ));
    const clearTimer = vi.fn();
    const onDue = vi.fn();
    const due = '2026-09-20T13:00:00.000Z';

    const cancelBackgroundTimer = armServiceJobDueWakeup(due, () => nowMs, setTimer, clearTimer, onDue);
    cancelBackgroundTimer();
    nowMs = Date.parse('2026-09-20T13:00:01.000Z');

    // This second arm is what the AppState `active` listener invokes.
    armServiceJobDueWakeup(due, () => nowMs, setTimer, clearTimer, onDue);
    expect(onDue).toHaveBeenCalledOnce();
  });

  describe('local service-job scheduling calendar', () => {
    it('keeps Today on the Guyana calendar when UTC has already rolled over', () => {
      withGuyanaLocalCalendar(() => {
        const days = serviceJobScheduleDays(new NativeDate('2026-09-21T00:30:00.000Z'));

        expect(days[0]).toMatchObject({ key: '2026-09-20', label: 'Today' });
        expect(localServiceJobDateTime(days[0]!.key, '21:00').toISOString()).toBe('2026-09-21T01:00:00.000Z');
      });
    });

    it('preserves the local calendar date at Guyana midnight', () => {
      withGuyanaLocalCalendar(() => {
        const days = serviceJobScheduleDays(new NativeDate('2026-09-20T04:00:00.000Z'));

        expect(days.slice(0, 2).map((day) => day.key)).toEqual(['2026-09-20', '2026-09-21']);
        expect(localServiceJobDateTime(days[0]!.key, '08:00').toISOString()).toBe('2026-09-20T12:00:00.000Z');
      });
    });

    it('is DST-agnostic for Guyana dates on both US DST transition days', () => {
      withGuyanaLocalCalendar(() => {
        expect(localServiceJobDateTime('2026-03-08', '08:00').toISOString()).toBe('2026-03-08T12:00:00.000Z');
        expect(localServiceJobDateTime('2026-11-01', '08:00').toISOString()).toBe('2026-11-01T12:00:00.000Z');
      });
    });

    it('submits the selected daytime local slot unchanged', () => {
      withGuyanaLocalCalendar(() => {
        const days = serviceJobScheduleDays(new NativeDate('2026-09-20T12:00:00.000Z'));

        expect(days[0]).toMatchObject({ key: '2026-09-20', label: 'Today' });
        expect(localServiceJobDateTime(days[0]!.key, '10:00').toISOString()).toBe('2026-09-20T14:00:00.000Z');
      });
    });
  });
});
