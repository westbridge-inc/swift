import { renderHook, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useGuestBasket } from './basket-state';
it('keeps the hydrated basket reference stable across unrelated renders', async () => {
  localStorage.clear();
  const { result, rerender } = renderHook(useGuestBasket);
  await waitFor(() => expect(result.current.loaded).toBe(true));
  const current = result.current;
  rerender();
  expect(result.current).toBe(current);
});
