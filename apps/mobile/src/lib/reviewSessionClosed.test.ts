import { beforeEach, describe, expect, it, vi } from 'vitest';

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('react-native', () => ({ Alert: { alert } }));

import { DEMO_ENDED_MESSAGE, DEMO_ENDED_TITLE, explainDemoEnded } from './reviewSessionClosed';

// [Row 353] The demo's end is said in plain words, with nothing that can crash.

beforeEach(() => { alert.mockReset(); });

describe('explainDemoEnded', () => {
  it('says the demo ended and what to do, with one OK', () => {
    explainDemoEnded();
    expect(alert).toHaveBeenCalledWith(DEMO_ENDED_TITLE, DEMO_ENDED_MESSAGE, [{ text: 'OK' }]);
    expect(DEMO_ENDED_TITLE).toBe('This demo has ended');
    expect(DEMO_ENDED_MESSAGE).toMatch(/signed out on this phone/);
  });

  it('never throws when there is no native alert to show it with', () => {
    alert.mockImplementationOnce(() => { throw new Error('no native module'); });
    expect(() => explainDemoEnded()).not.toThrow();
  });
});
