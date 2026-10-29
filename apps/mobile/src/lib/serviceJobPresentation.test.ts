import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  armServiceJobDueWakeup,
  parseServiceQuoteInput,
  SERVICE_JOB_BOOKED_CANCEL_WORDS,
  SERVICE_JOB_STARTED_CANCEL_WORDS,
  serviceJobCancelView,
  serviceJobDueDelayMs,
  serviceJobErrorMessage,
  showsServiceJobAgreedPrice,
} from './serviceJobPresentation';
import { serviceJobScheduleSelection, upcomingAppointmentDays } from './appointmentTime';

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

  // The schedule sheet uses the shared appointment calendar, which is pinned to
  // Guyana time whatever zone the phone is set to.
  describe('service-job scheduling calendar (Guyana time on any device)', () => {
    it('keeps Today on the Guyana calendar when UTC has already rolled over', () => {
      const now = new Date('2026-09-21T00:30:00.000Z');
      expect(upcomingAppointmentDays(now)[0]).toMatchObject({ key: '2026-09-20', label: 'Today' });
      expect(serviceJobScheduleSelection('2026-09-20', '21:00', now).scheduledFor).toBe('2026-09-21T01:00:00.000Z');
    });

    it('preserves the calendar date at Guyana midnight', () => {
      const now = new Date('2026-09-20T04:00:00.000Z');
      expect(upcomingAppointmentDays(now).slice(0, 2).map((day) => day.key)).toEqual(['2026-09-20', '2026-09-21']);
      expect(serviceJobScheduleSelection('2026-09-20', '08:00', now).scheduledFor).toBe('2026-09-20T12:00:00.000Z');
    });

    it('is unaffected by US daylight-saving transition days', () => {
      expect(serviceJobScheduleSelection('2026-03-08', '08:00').scheduledFor).toBe('2026-03-08T12:00:00.000Z');
      expect(serviceJobScheduleSelection('2026-11-01', '08:00').scheduledFor).toBe('2026-11-01T12:00:00.000Z');
    });

    it('flags a slot that has already passed', () => {
      const now = new Date('2026-09-20T15:00:00.000Z');
      expect(serviceJobScheduleSelection('2026-09-20', '10:00', now)).toEqual({ scheduledFor: '2026-09-20T14:00:00.000Z', isPast: true });
      expect(serviceJobScheduleSelection('2026-09-20', '12:00', now).isPast).toBe(false);
    });
  });
});

describe('[coordinator ruling 14 Oct · Terms 2026-10-15 §7] who may cancel a service job in the app', () => {
  const API_POLICY = readFileSync(join(process.cwd(), '../api/src/modules/order/cancel-policy.ts'), 'utf8');
  const apiWords = (name: string) => API_POLICY.match(new RegExp(`export const ${name} = '([^']+)';`))?.[1];

  it('the customer cancels only a request; once booked or started the app says who to contact instead', () => {
    expect(serviceJobCancelView('REQUESTED', true)).toEqual({ canCancel: true, contactWords: null });
    expect(serviceJobCancelView('QUOTED', true)).toEqual({ canCancel: true, contactWords: null });
    expect(serviceJobCancelView('SCHEDULED', true)).toEqual({ canCancel: false, contactWords: SERVICE_JOB_BOOKED_CANCEL_WORDS });
    expect(serviceJobCancelView('IN_PROGRESS', true)).toEqual({ canCancel: false, contactWords: SERVICE_JOB_STARTED_CANCEL_WORDS });
  });

  it('the provider keeps Cancel through SCHEDULED and IN_PROGRESS; a closed job offers nobody a Cancel', () => {
    for (const status of ['REQUESTED', 'QUOTED', 'SCHEDULED', 'IN_PROGRESS']) {
      expect(serviceJobCancelView(status, false), status).toEqual({ canCancel: true, contactWords: null });
    }
    for (const status of ['COMPLETED', 'CANCELLED']) {
      expect(serviceJobCancelView(status, true), status).toEqual({ canCancel: false, contactWords: null });
      expect(serviceJobCancelView(status, false), status).toEqual({ canCancel: false, contactWords: null });
    }
  });

  it('the words are the server refusal, word for word', () => {
    expect(apiWords('SERVICE_JOB_BOOKED_MESSAGE')).toBe(SERVICE_JOB_BOOKED_CANCEL_WORDS);
    expect(apiWords('SERVICE_JOB_STARTED_MESSAGE')).toBe(SERVICE_JOB_STARTED_CANCEL_WORDS);
  });

  it('the job card asks this one rule for its Cancel button and its contact words', () => {
    const SCREEN = readFileSync(join(process.cwd(), 'src/modules/services/screens/ServiceJobsScreen.tsx'), 'utf8');
    expect(SCREEN).toMatch(/serviceJobCancelView\(job\.status, isCustomer\)/);
    expect(SCREEN).toMatch(/\{cancelView\.canCancel \? \(\s*<PillButton label="Cancel"/);
    expect(SCREEN).toMatch(/\{cancelView\.contactWords\}/);
    expect(SCREEN).not.toMatch(/\['REQUESTED', 'QUOTED', 'SCHEDULED', 'IN_PROGRESS'\]\.includes\(job\.status\)/);
  });
});
