import { describe, expect, it } from 'vitest';
import { guyanaWeekday, todayHours } from './store-hours';

const week = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, openTime: `0${dayOfWeek}:00`, closeTime: '18:00', isClosed: dayOfWeek === 0 }));

describe('[W5] a store’s hours today', () => {
  it('reads the day on Guyana’s calendar, not the device’s', () => {
    // 02:30 UTC on a Monday is still Sunday evening in Guyana (UTC−4).
    const mondayUtc = new Date('2026-10-12T02:30:00Z');
    expect(mondayUtc.getUTCDay()).toBe(1);
    expect(guyanaWeekday(mondayUtc)).toBe(0);
    expect(todayHours(week, mondayUtc)).toBe('Closed today');
    expect(todayHours(week, new Date('2026-10-12T15:00:00Z'))).toBe('Today 01:00 – 18:00');
  });

  it('says nothing rather than inventing hours a store never published', () => {
    expect(todayHours([], new Date())).toBeNull();
    expect(todayHours(undefined, new Date())).toBeNull();
  });
});
